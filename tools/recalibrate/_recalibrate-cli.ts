// tools/recalibrate/_recalibrate-cli.ts — Addition #15 baseline-
// maintenance lifecycle, Task 8. CLI arg parsing + per-subcommand
// handlers for tools/recalibrate.ts. Handlers are exported standalone
// (kept <100 lines each) so tests import + call them directly against a
// fixture store — no child_process (plan §C Task 8 test note, mirrors
// the q60 test pattern).
//
// D1 (plan §B): EVERY subcommand handler below runs `sweepTimeouts`
// first — not just as an outer CLI wrapper step, but inside each
// handler itself, so a test that imports e.g. `runApprove` directly
// still gets the lazy-timeout enforcement (this is the "approve past
// timeout -> sweep rejects first, approve fails" load-bearing case,
// plan §C Task 8 test list).
//
// `--reviewer` is a self-declared operator identity — reference-
// implementation posture, no auth. `--reason-code` is validated against
// RECALIBRATION_REASON_CODES by the state machine itself (Task 2); this
// module doesn't re-validate it.
//
// `shadow` is deliberately ABSENT from the subcommand table below —
// plan §C Task 9 (tools/recalibrate/_recalibrate-shadow.ts, not part of
// this task) owns it; 'reviewable' is reachable ONLY via that path.
// Listed in USAGE_TEXT for operator visibility, not dispatched here.

import * as path from 'node:path';

import type { LifecycleEventEmitter } from '../../engine/o0/lifecycle-events';
import type { CreationReason } from '../../engine/types/recalibration';
import { transition } from '../../engine/recalibration/state-machine';
import { sweepTimeouts, checkCalendarSafetyNet } from './_recalibrate-sweep';
import { buildProposedCandidate, type ProposeSourceWindow } from './_recalibrate-candidate';
import { RecalibrationStore, JsonlLifecycleEventEmitter, type InitOptions } from './_recalibrate-store';

export const USAGE_TEXT = 'usage: recalibrate <init|propose|list|show|approve|reject|check|rollback> [flags] '
  + '(shadow: not available in this build — plan §C Task 9)';

export interface HandlerResult {
  exitCode: number;
  lines: string[];
}

const ok = (lines: string[]): HandlerResult => ({ exitCode: 0, lines });

function nowOrDefault(nowIso?: string): string {
  return nowIso ?? new Date().toISOString();
}

// ── init ──────────────────────────────────────────────────────────────

export interface InitArgs {
  root: string;
  serviceId: string;
  timeoutDays?: number;
  unchangedEpsilonRel?: number;
}

/** No sweep here — the store doesn't exist yet before init creates it. */
export function runInit(args: InitArgs): HandlerResult {
  const opts: InitOptions = {
    timeoutDays: args.timeoutDays,
    unchangedEpsilonRel: args.unchangedEpsilonRel,
  };
  RecalibrationStore.init(args.root, args.serviceId, opts);
  return ok([`initialized recalibration store for service '${args.serviceId}' under ${args.root}`]);
}

// ── propose ───────────────────────────────────────────────────────────

export interface ProposeArgs {
  candidateId: string;
  candidateConfigPath: string;
  creationReason: CreationReason;
  sourceWindow: ProposeSourceWindow;
  driftOutput?: object;
  now?: string;
}

export async function runPropose(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, args: ProposeArgs,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(args.now);
  await sweepTimeouts(store, emitter, nowIso);

  const outcome = buildProposedCandidate({
    store,
    candidateId: args.candidateId,
    candidateConfigPath: args.candidateConfigPath,
    creationReason: args.creationReason,
    sourceWindow: args.sourceWindow,
    driftOutput: args.driftOutput,
    nowIso,
  });
  store.writeCandidate(outcome.record);

  if (!outcome.accepted) {
    const gateLines = Object.entries(outcome.readiness)
      .filter(([k]) => k !== 'all_passed')
      .map(([gate, passed]) => `  ${gate}: ${passed ? 'PASS' : 'FAIL'}`);
    return {
      exitCode: 2,
      lines: [`candidate '${args.candidateId}' failed readiness gates:`, ...gateLines],
    };
  }

  await emitter.emit('recalibration.proposed', {
    type: 'recalibration.proposed',
    service_id: outcome.record.service_id,
    candidate_id: outcome.record.candidate_id,
    proposed_baseline_version: outcome.record.proposed_baseline_version,
    current_baseline_version: outcome.record.current_baseline_version,
    direction_classification: outcome.record.direction_classification,
    at: nowIso,
  });
  return ok([`candidate '${args.candidateId}' proposed (${outcome.record.direction_classification}); pending_shadow`]);
}

// ── list / show ──────────────────────────────────────────────────────

export async function runList(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, now?: string,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(now);
  await sweepTimeouts(store, emitter, nowIso);
  const lines = store.listCandidates().map(
    (c) => `${c.candidate_id}\t${c.status}\t${c.review_status}\t${c.direction_classification}`,
  );
  return ok(lines);
}

export async function runShow(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, candidateId: string, now?: string,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(now);
  await sweepTimeouts(store, emitter, nowIso);
  const rec = store.readCandidate(candidateId);
  return ok([JSON.stringify(rec, null, 2)]);
}

// ── approve / reject ─────────────────────────────────────────────────

export interface DecisionArgs {
  candidateId: string;
  reviewer: string;
  reasonCode: string;
  now?: string;
}

export async function runApprove(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, args: DecisionArgs,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(args.now);
  await sweepTimeouts(store, emitter, nowIso);

  const rec = store.readCandidate(args.candidateId);
  if (rec.review_status !== 'reviewable') {
    return { exitCode: 1, lines: [`candidate '${args.candidateId}' is not reviewable (review_status='${rec.review_status}')`] };
  }

  const updated = transition(rec, {
    kind: 'approve', at: nowIso, actor: args.reviewer, reason_code: args.reasonCode,
  });
  store.writeCandidate(updated);
  store.promote(args.candidateId, 'operator_approved', nowIso, { actor: args.reviewer, reasonCode: args.reasonCode });

  await emitter.emit('recalibration.operator_approved', {
    type: 'recalibration.operator_approved',
    service_id: updated.service_id,
    candidate_id: updated.candidate_id,
    proposed_baseline_version: updated.proposed_baseline_version,
    current_baseline_version: updated.current_baseline_version,
    direction_classification: updated.direction_classification,
    at: nowIso,
    operator_id: args.reviewer,
    reason_code: args.reasonCode,
  });
  return ok([`candidate '${args.candidateId}' approved by '${args.reviewer}'; active baseline updated`]);
}

export async function runReject(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, args: DecisionArgs,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(args.now);
  await sweepTimeouts(store, emitter, nowIso);

  const rec = store.readCandidate(args.candidateId);
  if (rec.review_status !== 'reviewable') {
    return { exitCode: 1, lines: [`candidate '${args.candidateId}' is not reviewable (review_status='${rec.review_status}')`] };
  }

  const updated = transition(rec, {
    kind: 'reject', at: nowIso, actor: args.reviewer, reason_code: args.reasonCode,
  });
  store.writeCandidate(updated);
  // active.json is deliberately untouched — reject never calls promote.

  await emitter.emit('recalibration.operator_rejected', {
    type: 'recalibration.operator_rejected',
    service_id: updated.service_id,
    candidate_id: updated.candidate_id,
    proposed_baseline_version: updated.proposed_baseline_version,
    current_baseline_version: updated.current_baseline_version,
    direction_classification: updated.direction_classification,
    at: nowIso,
    operator_id: args.reviewer,
    reason_code: args.reasonCode,
  });
  return ok([`candidate '${args.candidateId}' rejected by '${args.reviewer}'`]);
}

// ── check (D2 calendar safety net) ──────────────────────────────────

/** Prints calendar-safety-net guidance and exits 3 when due. No typed
 *  lifecycle event is emitted here — Task 5 closed LifecycleEventType's
 *  recalibration.* set at exactly six members and 'calendar_due' isn't
 *  one of them (plan §C Task 5); the CLI's printed guidance + exit code
 *  IS the "emission" plan §B D2's prose refers to. */
export async function runCheck(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, now?: string,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(now);
  await sweepTimeouts(store, emitter, nowIso);
  const result = checkCalendarSafetyNet(store, nowIso);
  if (!result.due) {
    return ok([`calendar safety net: not due (last_activity_at=${result.last_activity_at ?? 'none'}, open_candidate=${result.open_candidate_id ?? 'none'})`]);
  }
  return {
    exitCode: 3,
    lines: [
      `calendar safety net: DUE — no recalibration activity since ${result.last_activity_at}`,
      `run: node tools/recalibrate.ts propose --creation-reason calendar_safety_net ...`,
    ],
  };
}

// ── rollback ─────────────────────────────────────────────────────────

export interface RollbackArgs {
  versionId: string;
  reviewer: string;
  reasonCode: string;
  now?: string;
}

export async function runRollback(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, args: RollbackArgs,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(args.now);
  await sweepTimeouts(store, emitter, nowIso);
  store.rollbackTo(args.versionId, args.reviewer, args.reasonCode, nowIso);
  return ok([`rolled back to '${args.versionId}' by '${args.reviewer}'`]);
}

// ── argv parsing + dispatch ──────────────────────────────────────────

const KNOWN_FLAGS = new Set([
  '--service', '--root', '--candidate-id', '--candidate-config', '--creation-reason',
  '--source-window-start', '--source-window-end', '--source-window-samples',
  '--drift-output', '--now', '--reviewer', '--reason-code', '--timeout-days',
  '--unchanged-epsilon-rel', '--version',
]);

export interface ParsedArgv {
  subcommand: string;
  flags: Record<string, string>;
}

/** Flat `--flag value` parser shared by every subcommand (subcommand-
 *  specific requiredness is enforced by `requireFlag` at dispatch time,
 *  not here) — an unrecognized `--flag` always throws, regardless of
 *  subcommand, per plan §C Task 8's "unknown flag -> usage error" test. */
export function parseArgv(argv: string[]): ParsedArgv {
  if (argv.length === 0) throw new Error(USAGE_TEXT);
  const [subcommand, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith('--')) throw new Error(`unexpected positional argument: '${k}'. ${USAGE_TEXT}`);
    if (!KNOWN_FLAGS.has(k)) throw new Error(`Unknown flag: ${k}. ${USAGE_TEXT}`);
    flags[k.slice(2)] = rest[i + 1];
    i += 1;
  }
  return { subcommand, flags };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

function openStore(flags: Record<string, string>): RecalibrationStore {
  const root = flags.root ?? 'runs/baseline-history';
  return new RecalibrationStore(path.join(root, requireFlag(flags, 'service')));
}

async function dispatch(subcommand: string, flags: Record<string, string>): Promise<HandlerResult> {
  if (subcommand === 'init') {
    return runInit({
      root: flags.root ?? 'runs/baseline-history',
      serviceId: requireFlag(flags, 'service'),
      timeoutDays: flags['timeout-days'] !== undefined ? parseInt(flags['timeout-days'], 10) : undefined,
      unchangedEpsilonRel: flags['unchanged-epsilon-rel'] !== undefined ? parseFloat(flags['unchanged-epsilon-rel']) : undefined,
    });
  }

  const store = openStore(flags);
  const emitter = new JsonlLifecycleEventEmitter(store);

  switch (subcommand) {
    case 'propose':
      return runPropose(store, emitter, {
        candidateId: requireFlag(flags, 'candidate-id'),
        candidateConfigPath: requireFlag(flags, 'candidate-config'),
        creationReason: requireFlag(flags, 'creation-reason') as CreationReason,
        sourceWindow: {
          start: requireFlag(flags, 'source-window-start'),
          end: requireFlag(flags, 'source-window-end'),
          n_samples: parseInt(requireFlag(flags, 'source-window-samples'), 10),
        },
        now: flags.now,
      });
    case 'list':
      return runList(store, emitter, flags.now);
    case 'show':
      return runShow(store, emitter, requireFlag(flags, 'candidate-id'), flags.now);
    case 'approve':
      return runApprove(store, emitter, {
        candidateId: requireFlag(flags, 'candidate-id'),
        reviewer: requireFlag(flags, 'reviewer'),
        reasonCode: requireFlag(flags, 'reason-code'),
        now: flags.now,
      });
    case 'reject':
      return runReject(store, emitter, {
        candidateId: requireFlag(flags, 'candidate-id'),
        reviewer: requireFlag(flags, 'reviewer'),
        reasonCode: requireFlag(flags, 'reason-code'),
        now: flags.now,
      });
    case 'check':
      return runCheck(store, emitter, flags.now);
    case 'rollback':
      return runRollback(store, emitter, {
        versionId: requireFlag(flags, 'version'),
        reviewer: requireFlag(flags, 'reviewer'),
        reasonCode: requireFlag(flags, 'reason-code'),
        now: flags.now,
      });
    default:
      throw new Error(`Unknown subcommand: '${subcommand}'. ${USAGE_TEXT}`);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { subcommand, flags } = parseArgv(argv);
  const result = await dispatch(subcommand, flags);
  for (const line of result.lines) console.log(line);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}
