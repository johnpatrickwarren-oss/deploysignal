// tools/recalibrate/_recalibrate-soak-cli.ts — R5 live shadow soak,
// Task 5: separate dispatch file for the `soak` subcommand family.
//
// Deliberately NOT folded into _recalibrate-cli.ts's KNOWN_FLAGS/
// dispatch()/USAGE_TEXT (plan §3 Task 5 / §6 conflict list — that file
// is the highest-contention shared file against the parallel refresh-
// controller workstream). This file owns its own flag table, its own
// usage text, and its own argv parser; _recalibrate-cli.ts's `main()`
// only ever hands it `argv.slice(1)` once `argv[0] === 'soak'` (Task 6).
//
// CLI:
//   node tools/recalibrate.ts soak start  --service <id> \
//     --candidate-id <id> --requested-by <id> \
//     [--target-ticks 200] [--max-duration-seconds <n>] \
//     [--root <dir>] [--now <iso>]
//   node tools/recalibrate.ts soak status --service <id> \
//     [--root <dir>] [--now <iso>]
//   node tools/recalibrate.ts soak stop   --service <id> \
//     --candidate-id <id> --reviewer <id> [--root <dir>] [--now <iso>]
//
// Deliberate deviation from the D1 convention (plan §3 Task 5, binding):
// these handlers do NOT call `sweepTimeouts` first. Soak commands never
// transition a candidate's (status, review_status) — starting/stopping/
// polling a soak has no interaction with the timeout sweep's own state
// space, and NOT importing _recalibrate-sweep here keeps this module
// decoupled from that parallel workstream's file, per the plan's
// shared-file conflict list.

import * as path from 'node:path';

import type { HandlerResult } from './_recalibrate-cli';
import type { SoakManifest, SoakWindow } from '../../engine/types/recalibration';
import { RecalibrationStore } from './_recalibrate-store';
import {
  readSoakManifest, writeSoakManifest, readSoakSidecar, foldSoakEvidence, formatSoakSidecarSummary,
} from './_recalibrate-soak';

export const SOAK_USAGE_TEXT = 'usage: recalibrate soak <start|status|stop> [flags]\n'
  + '  soak start  --service <id> --candidate-id <id> --requested-by <id> '
  + '[--target-ticks 200] [--max-duration-seconds <n>] [--root <dir>] [--now <iso>]\n'
  + '  soak status --service <id> [--root <dir>] [--now <iso>]\n'
  + '  soak stop   --service <id> --candidate-id <id> --reviewer <id> [--root <dir>] [--now <iso>]';

/** plan §4 default #5 — target_ticks: 200 (≈3+ default 60-tick sessions;
 *  enough sessions for coverage stats to mean something). */
const DEFAULT_TARGET_TICKS = 200;

const ok = (lines: string[]): HandlerResult => ({ exitCode: 0, lines });

function nowOrDefault(nowIso?: string): string {
  return nowIso ?? new Date().toISOString();
}

// ── start ────────────────────────────────────────────────────────────

export interface SoakStartArgs {
  candidateId: string;
  requestedBy: string;
  targetTicks?: number;
  maxDurationSeconds?: number;
  now?: string;
}

/** `start`: candidate must exist with status 'candidate' and
 *  review_status in {pending_shadow, reviewable} (R5 scope — a soak can
 *  run while a candidate is still gathering shadow evidence, or once
 *  it's reviewable). Refuses a second concurrent soak for a DIFFERENT
 *  candidate (one soak per service, plan §4 default #4 — sidecars are
 *  per-candidate, so re-running `start` for the SAME candidate id is not
 *  refused here; see service/gate-http/_gate-soak.ts's activateCandidate
 *  for the re-soak-after-completion archive behavior that makes that
 *  safe). */
export function runSoakStart(store: RecalibrationStore, args: SoakStartArgs): HandlerResult {
  const nowIso = nowOrDefault(args.now);
  const rec = store.readCandidate(args.candidateId);
  if (rec.status !== 'candidate' || (rec.review_status !== 'pending_shadow' && rec.review_status !== 'reviewable')) {
    return {
      exitCode: 1,
      lines: [`candidate '${args.candidateId}' is not eligible for soak `
        + `(status='${rec.status}', review_status='${rec.review_status}')`],
    };
  }

  const existing = readSoakManifest(store.dir);
  if (existing && existing.status === 'requested' && existing.candidate_id !== args.candidateId) {
    return {
      exitCode: 1,
      lines: [`a soak is already active for candidate '${existing.candidate_id}' — stop it first (one soak per service)`],
    };
  }

  const window: SoakWindow = {
    target_ticks: args.targetTicks ?? DEFAULT_TARGET_TICKS,
    ...(args.maxDurationSeconds !== undefined ? { max_duration_seconds: args.maxDurationSeconds } : {}),
  };
  const manifest: SoakManifest = {
    schema_version: '1',
    candidate_id: args.candidateId,
    requested_at: nowIso,
    requested_by: args.requestedBy,
    window,
    status: 'requested',
  };
  writeSoakManifest(store.dir, manifest);

  store.appendEvent({
    type: 'recalibration.soak_started',
    payload: {
      service_id: rec.service_id, candidate_id: args.candidateId, window, requested_by: args.requestedBy,
    },
    at: nowIso,
  });

  return ok([`soak started for candidate '${args.candidateId}' (target_ticks=${window.target_ticks})`]);
}

// ── status ───────────────────────────────────────────────────────────

/** `status`: prints the manifest plus a live sidecar summary (ticks
 *  observed/target, disagreements, rollback divergence, coverage,
 *  voids) when the soak controller has observed at least one tick.
 *  Always exit 0 — "no soak" / "no ticks yet" are informational states,
 *  not errors. */
export function runSoakStatus(store: RecalibrationStore, _now?: string): HandlerResult {
  // `_now` accepted for signature symmetry with the plan's dispatch
  // shape (soakMain threads `flags.now` through uniformly to all three
  // handlers) — status is a pure read with no sweep/mutation, so there
  // is nothing to compute "as of now" here; kept unused deliberately.
  const manifest = readSoakManifest(store.dir);
  if (!manifest) return ok(['no soak manifest for this service']);

  const lines = [
    `soak manifest: candidate='${manifest.candidate_id}' status='${manifest.status}' `
    + `requested_by='${manifest.requested_by}' requested_at=${manifest.requested_at} `
    + `target_ticks=${manifest.window.target_ticks}`
    + (manifest.status === 'stopped' ? ` stopped_at=${manifest.stopped_at} stopped_by='${manifest.stopped_by}'` : ''),
  ];

  const sidecar = readSoakSidecar(store.dir, manifest.candidate_id);
  if (sidecar) {
    lines.push(`SOAK (live): ${formatSoakSidecarSummary(sidecar)}`);
  } else {
    lines.push('no live sidecar yet (soak controller has not observed a tick)');
  }
  return ok(lines);
}

// ── stop ─────────────────────────────────────────────────────────────

export interface SoakStopArgs {
  candidateId: string;
  reviewer: string;
  now?: string;
}

/** `stop`: sets manifest status:'stopped' (+stopped_at/stopped_by) if
 *  not already stopped; if a sidecar exists, folds it via
 *  `foldSoakEvidence` — this is the moment `CandidateRecord.soak`
 *  becomes durable. Idempotent: stopping an already-stopped soak
 *  refreshes the fold (re-reads the current sidecar, re-folds) and
 *  exits 0 rather than erroring. */
export function runSoakStop(store: RecalibrationStore, args: SoakStopArgs): HandlerResult {
  const nowIso = nowOrDefault(args.now);
  const manifest = readSoakManifest(store.dir);
  if (!manifest || manifest.candidate_id !== args.candidateId) {
    return { exitCode: 1, lines: [`no soak manifest found for candidate '${args.candidateId}'`] };
  }

  if (manifest.status === 'requested') {
    const stopped: SoakManifest = {
      ...manifest, status: 'stopped', stopped_at: nowIso, stopped_by: args.reviewer,
    };
    writeSoakManifest(store.dir, stopped);
  }

  const lines = [`soak stopped for candidate '${args.candidateId}'`];
  const sidecar = readSoakSidecar(store.dir, args.candidateId);
  if (!sidecar) {
    lines.push('no live sidecar to fold (soak controller never observed a tick)');
    return ok(lines);
  }

  const rec = store.readCandidate(args.candidateId);
  const folded = foldSoakEvidence(store, rec, sidecar, args.reviewer, nowIso);
  lines.push(`folded: ${formatSoakSidecarSummary(sidecar)}, stopped_early=${folded.soak!.stopped_early}`);

  store.appendEvent({
    type: 'recalibration.soak_stopped',
    payload: {
      service_id: rec.service_id,
      candidate_id: args.candidateId,
      ticks_observed: sidecar.stats.ticks_observed,
      stopped_early: folded.soak!.stopped_early,
    },
    at: nowIso,
  });

  return ok(lines);
}

// ── argv parsing + dispatch (own flag table — see module header) ──────

const SOAK_KNOWN_FLAGS = new Set([
  '--service', '--root', '--candidate-id', '--requested-by',
  '--target-ticks', '--max-duration-seconds', '--now', '--reviewer',
]);

interface ParsedSoakArgv { action: string; flags: Record<string, string>; }

function parseSoakArgv(argv: string[]): ParsedSoakArgv {
  if (argv.length === 0) throw new Error(SOAK_USAGE_TEXT);
  const [action, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith('--')) throw new Error(`unexpected positional argument: '${k}'. ${SOAK_USAGE_TEXT}`);
    if (!SOAK_KNOWN_FLAGS.has(k)) throw new Error(`Unknown flag: ${k}. ${SOAK_USAGE_TEXT}`);
    flags[k.slice(2)] = rest[i + 1];
    i += 1;
  }
  return { action, flags };
}

function requireSoakFlag(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

function openSoakStore(flags: Record<string, string>): RecalibrationStore {
  const root = flags.root ?? 'runs/baseline-history';
  return new RecalibrationStore(path.join(root, requireSoakFlag(flags, 'service')));
}

function dispatchSoak(action: string, flags: Record<string, string>): HandlerResult {
  const store = openSoakStore(flags);
  switch (action) {
    case 'start':
      return runSoakStart(store, {
        candidateId: requireSoakFlag(flags, 'candidate-id'),
        requestedBy: requireSoakFlag(flags, 'requested-by'),
        targetTicks: flags['target-ticks'] !== undefined ? parseInt(flags['target-ticks'], 10) : undefined,
        maxDurationSeconds: flags['max-duration-seconds'] !== undefined ? parseInt(flags['max-duration-seconds'], 10) : undefined,
        now: flags.now,
      });
    case 'status':
      return runSoakStatus(store, flags.now);
    case 'stop':
      return runSoakStop(store, {
        candidateId: requireSoakFlag(flags, 'candidate-id'),
        reviewer: requireSoakFlag(flags, 'reviewer'),
        now: flags.now,
      });
    default:
      throw new Error(`Unknown soak action: '${action}'. ${SOAK_USAGE_TEXT}`);
  }
}

/** Parse + dispatch for the 'soak' subcommand family. Called from
 *  _recalibrate-cli.ts's `main()` with `argv.slice(1)` (i.e. `argv[0]`
 *  here is 'start'/'status'/'stop', not 'soak' — the outer `main()`
 *  already consumed that token). `async` to match `main()`'s own
 *  `await` call site; none of the three handlers above actually need to
 *  await anything (no sweep, no shadow-compare orchestrator). */
// eslint-disable-next-line @typescript-eslint/require-await
export async function soakMain(argv: string[]): Promise<HandlerResult> {
  const { action, flags } = parseSoakArgv(argv);
  return dispatchSoak(action, flags);
}
