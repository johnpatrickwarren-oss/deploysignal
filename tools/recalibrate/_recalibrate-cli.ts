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
// `shadow` (Task 9, tools/recalibrate/_recalibrate-shadow.ts) drives a
// `pending_shadow` candidate through the Q60 shadow-compare orchestrator;
// 'reviewable' is reachable ONLY via that path.
//
// Fix 1 (Tasks 6-8 review, OQ-5 stale-warning surfacing): `list` and
// `check` surface pending_readiness/pending_shadow candidates whose
// timeout_at has passed as STALE warnings — printed AND returned via
// HandlerResult.staleCandidateIds — WITHOUT auto-rejecting them (the
// state machine defines no legal 'timeout' transition out of those
// review_status values; only `sweepTimeouts`-eligible 'reviewable'
// candidates get auto-rejected, per OQ-5 / _recalibrate-sweep.ts).

import * as path from 'node:path';

import type { LifecycleEventEmitter } from '../../engine/o0/lifecycle-events';
import type { CandidateRecord, CreationReason } from '../../engine/types/recalibration';
import { transition } from '../../engine/recalibration/state-machine';
import { isTimedOut } from '../../engine/recalibration/timeout';
import type { ExclusionWindow } from '../../engine/recalibration/compare';
import { sweepTimeouts, checkCalendarSafetyNet } from './_recalibrate-sweep';
import { buildProposedCandidate, type ProposeSourceWindow } from './_recalibrate-candidate';
import { runCandidateShadow } from './_recalibrate-shadow';
import { RecalibrationStore, JsonlLifecycleEventEmitter, type InitOptions } from './_recalibrate-store';

export const USAGE_TEXT = 'usage: recalibrate <init|propose|shadow|list|show|approve|reject|check|rollback> [flags]';

export interface HandlerResult {
  exitCode: number;
  lines: string[];
  /** Fix 1 (Tasks 6-8 review) — candidate_ids surfaced as STALE by
   *  `list`/`check` (see module header). Absent/empty on every other
   *  handler and whenever nothing is stale. */
  staleCandidateIds?: string[];
}

/** Fix 1 — pending_readiness/pending_shadow candidates whose timeout_at
 *  has already passed. `sweepTimeouts` never touches these (OQ-5), so
 *  without this surfacing they'd sit silently past their review deadline
 *  forever; `list`/`check` print + return them as warnings instead. */
function staleCandidateWarnings(
  candidates: CandidateRecord[], nowIso: string,
): { ids: string[]; lines: string[] } {
  const stale = candidates.filter(
    (c) => (c.review_status === 'pending_readiness' || c.review_status === 'pending_shadow')
      && isTimedOut(c.timeout_at, nowIso),
  );
  return {
    ids: stale.map((c) => c.candidate_id),
    lines: stale.map((c) => `STALE: candidate '${c.candidate_id}' (review_status='${c.review_status}') `
      + `timeout_at=${c.timeout_at} has passed but was NOT auto-rejected `
      + '(OQ-5: only \'reviewable\' candidates time out; operator action required)'),
  };
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
  /** R2 Task 7 — threaded through to `buildProposedCandidate`'s Task-1
   *  `selectionAppliedExclusions` option. `refresh`'s own dispatch
   *  (Task 8, tools/recalibrate/_recalibrate-refresh.ts) is the only
   *  caller that sets this; direct `propose` CLI invocations never do,
   *  so the Task-1 backstop stays unchanged for them. */
  selectionAppliedExclusions?: ExclusionWindow[];
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
    selectionAppliedExclusions: args.selectionAppliedExclusions,
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

// ── shadow (Task 9) ──────────────────────────────────────────────────

export interface ShadowArgs {
  candidateId: string;
  scenarios: string[];
  seeds: number[];
  outputDir: string;
  dryRun?: boolean;
  baselineDir?: string;
  now?: string;
}

/** Drives a `pending_shadow` candidate through the Q60 shadow-compare
 *  orchestrator (tools/recalibrate/_recalibrate-shadow.ts). Only legal
 *  from `pending_shadow` — 'reviewable' is reachable ONLY via this
 *  handler (plan §C Task 9), mirroring approve/reject's "not reviewable"
 *  guard shape for the sibling "wrong review_status" error. */
export async function runShadow(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, args: ShadowArgs,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(args.now);
  await sweepTimeouts(store, emitter, nowIso);

  const rec = store.readCandidate(args.candidateId);
  if (rec.review_status !== 'pending_shadow') {
    return { exitCode: 1, lines: [`candidate '${args.candidateId}' is not pending_shadow (review_status='${rec.review_status}')`] };
  }

  const result = await runCandidateShadow(store, emitter, rec, {
    scenarios: args.scenarios,
    seeds: args.seeds,
    outputDir: args.outputDir,
    dryRun: args.dryRun,
    baselineDir: args.baselineDir,
    nowIso,
  });

  if (!result.gatesPassed) {
    return {
      exitCode: 2,
      lines: [`candidate '${args.candidateId}' failed shadow-mode acceptance gates; rejected (shadow_mode_failed)`],
    };
  }
  if (result.autoPromoted) {
    return ok([`candidate '${args.candidateId}' shadow-validated + auto-promoted (improvement); active baseline updated`]);
  }
  return ok([`candidate '${args.candidateId}' shadow-validated; reviewable (${result.record.direction_classification})`]);
}

// ── list / show ──────────────────────────────────────────────────────

export async function runList(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, now?: string,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(now);
  await sweepTimeouts(store, emitter, nowIso);
  const candidates = store.listCandidates();
  const lines = candidates.map(
    (c) => `${c.candidate_id}\t${c.status}\t${c.review_status}\t${c.direction_classification}`,
  );
  const stale = staleCandidateWarnings(candidates, nowIso);
  return { exitCode: 0, lines: [...lines, ...stale.lines], staleCandidateIds: stale.ids };
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
 *  IS the "emission" plan §B D2's prose refers to.
 *
 *  Fix 2 (Tasks 6-8 review) — calendar-due must still leave a DURABLE
 *  audit trace, not just stdout: when due, an untyped StoredEvent (type
 *  'recalibration.calendar_due') is appended straight to the store's
 *  events.jsonl via `store.appendEvent`, mirroring rollback's
 *  'recalibration.rolled_back' pattern (_recalibrate-store.ts header
 *  note) — same mechanism Task 9's shadow-gate-failure path also uses. */
export async function runCheck(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, now?: string,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(now);
  await sweepTimeouts(store, emitter, nowIso);
  const candidates = store.listCandidates();
  const stale = staleCandidateWarnings(candidates, nowIso);
  const result = checkCalendarSafetyNet(store, nowIso);
  if (!result.due) {
    return {
      exitCode: 0,
      lines: [
        `calendar safety net: not due (last_activity_at=${result.last_activity_at ?? 'none'}, open_candidate=${result.open_candidate_id ?? 'none'})`,
        ...stale.lines,
      ],
      staleCandidateIds: stale.ids,
    };
  }

  store.appendEvent({
    type: 'recalibration.calendar_due',
    payload: {
      service_id: store.readMeta().service_id,
      last_activity_at: result.last_activity_at,
    },
    at: nowIso,
  });

  return {
    exitCode: 3,
    lines: [
      `calendar safety net: DUE — no recalibration activity since ${result.last_activity_at}`,
      `run: node tools/recalibrate.ts propose --creation-reason calendar_safety_net ...`,
      ...stale.lines,
    ],
    staleCandidateIds: stale.ids,
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
  '--scenarios', '--seeds', '--output-dir', '--dry-run', '--baseline-dir',
]);

export interface ParsedArgv {
  subcommand: string;
  flags: Record<string, string>;
}

/** `--dry-run` is a bare boolean flag (Task 9's `shadow` subcommand,
 *  mirroring tools/run-shadow-compare.ts's own `--dry-run`) — it doesn't
 *  consume a following value like every other flag here. */
const BOOLEAN_FLAGS = new Set(['--dry-run']);

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
    if (BOOLEAN_FLAGS.has(k)) {
      flags[k.slice(2)] = 'true';
      continue;
    }
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
    case 'shadow':
      return runShadow(store, emitter, {
        candidateId: requireFlag(flags, 'candidate-id'),
        scenarios: requireFlag(flags, 'scenarios').split(',').map((s) => s.trim()),
        seeds: requireFlag(flags, 'seeds').split(',').map((s) => parseInt(s.trim(), 10)),
        outputDir: flags['output-dir'] ?? 'runs/validation-reports/profile-report-cards/',
        dryRun: flags['dry-run'] === 'true',
        baselineDir: flags['baseline-dir'],
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
