// tools/recalibrate/_recalibrate-shadow.ts — Addition #15 baseline-
// maintenance lifecycle, Task 9. Shadow-validation integration:
// `runCandidateShadow` wraps the EXISTING Q60 orchestrator
// (tools/run-shadow-compare.ts's `runShadowCompare`) with SubstrateRefs
// built from the service's active baseline + the candidate under
// review — no new shadow-comparison machinery, this module is glue.
//
// `reviewable` is reachable ONLY through this path (plan §C Task 9):
// the state machine's `pending_shadow -(shadow_validated)-> reviewable`
// transition (engine/recalibration/state-machine.ts) is invoked from
// nowhere else in tools/recalibrate/*. D5 (plan §B): "auto-promote means
// no operator identity required, not no validation" — an 'improvement'
// classification still has to clear the shadow-mode acceptance gates
// before `handleAutoPromote`'s classification guard even gets a chance
// to run.
//
// D6 (engine/tools split): this module is I/O (delegates to the
// orchestrator, which writes report-card files) so it lives in tools/,
// not engine/.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CandidateRecord } from '../../engine/types/recalibration';
import { transition } from '../../engine/recalibration/state-machine';
import type {
  LifecycleEventEmitter,
  RecalibrationShadowValidatedPayload,
  RecalibrationAutoPromotedPayload,
} from '../../engine/o0/lifecycle-events';
import {
  runShadowCompare, type SubstrateRef, type ShadowCompareOpts, type ShadowCompareReport,
} from '../run-shadow-compare';
import type { RecalibrationStore } from './_recalibrate-store';

export interface RunCandidateShadowOptions {
  scenarios: string[];
  seeds: number[];
  outputDir: string;
  dryRun?: boolean;
  /** SubstrateRef.baselineDir for both the active + candidate substrates
   *  — the orchestrator's dry-run path doesn't read it, but production
   *  (non-dry-run) sweeps do. Defaults to a scratch dir under outputDir
   *  when omitted (caller is expected to always pass a real one outside
   *  dry-run tests). */
  baselineDir?: string;
  /** Deterministic "now" the caller threads through — mirrors every
   *  other tools/recalibrate/* handler's `nowIso` convention (Task 7/8).
   *  No wall-clock fallback here: shadow validation is always invoked
   *  from a CLI handler that has already resolved `nowIso`. */
  nowIso: string;
  /** Test-injection seam for the orchestrator call — defaults to the
   *  REAL `runShadowCompare` (Q60 orchestrator, unmodified). Dry-run
   *  mode always stub-emits zero firing counts for every substrate, so
   *  its acceptance gates trivially pass; a test that needs to exercise
   *  the gate-FAILURE branch injects a fake report here instead of
   *  trying to coax a genuine ΔFPR breach out of the dry-run stub
   *  (plan §C Task 9 test list: "failed gate -> shadow_mode_failed"). */
  shadowCompareFn?: (opts: ShadowCompareOpts) => ShadowCompareReport;
}

export interface RunCandidateShadowResult {
  record: CandidateRecord;
  gatesPassed: boolean;
  autoPromoted: boolean;
  shadowReportPath: string;
  report: ShadowCompareReport;
}

function buildSubstrates(
  store: RecalibrationStore,
  candidate: CandidateRecord,
  baselineDir: string,
): [SubstrateRef, SubstrateRef] {
  const active = store.readActive();
  if (!active) {
    throw new Error(
      `runCandidateShadow: service '${candidate.service_id}' has no active baseline to shadow-compare against`,
    );
  }
  // `active` first — runShadowCompare's cross-substrate diff treats
  // opts.substrates[0] as the reference substrate (tools/
  // _run-shadow-compare-orchestrator.ts), so the diff is naturally
  // "candidate vs currently-active", not the other way around.
  const activeRef: SubstrateRef = { name: 'active', baselineDir, compiledConfig: active.compiled_config_path };
  const candidateRef: SubstrateRef = { name: 'candidate', baselineDir, compiledConfig: candidate.compiled_config_path };
  return [activeRef, candidateRef];
}

/** All acceptance gates true, over a non-empty gate set — an empty
 *  `acceptance_gates` map (e.g. a misconfigured zero-scenario sweep)
 *  fails closed rather than vacuously passing. */
function allGatesPassed(gates: Record<string, boolean>): boolean {
  const values = Object.values(gates);
  return values.length > 0 && values.every(Boolean);
}

function basePayloadFields(rec: CandidateRecord, nowIso: string) {
  return {
    service_id: rec.service_id,
    candidate_id: rec.candidate_id,
    proposed_baseline_version: rec.proposed_baseline_version,
    current_baseline_version: rec.current_baseline_version,
    direction_classification: rec.direction_classification,
    at: nowIso,
  };
}

/** Run shadow-mode validation for a `pending_shadow` candidate, then
 *  drive the state machine per the outcome:
 *   - any acceptance gate false -> `shadow_failed` -> status 'rejected',
 *     outcome 'shadow_mode_failed'. No typed lifecycle event exists for
 *     this (Task 5 closed LifecycleEventType's recalibration.* set at
 *     exactly six members) — an untyped StoredEvent is appended to the
 *     store's events.jsonl instead, mirroring rollback's
 *     'recalibration.rolled_back' pattern (_recalibrate-store.ts header
 *     note) so the decision still lands in the authoritative audit log.
 *   - all gates true -> `shadow_validated` -> review_status 'reviewable'
 *     + 'recalibration.shadow_validated' emitted.
 *   - all gates true AND direction_classification === 'improvement' ->
 *     immediately follow with `auto_promote` + `store.promote` +
 *     'recalibration.auto_promoted' emitted. No operator identity is
 *     involved anywhere in this branch (D5). */
export async function runCandidateShadow(
  store: RecalibrationStore,
  emitter: LifecycleEventEmitter,
  candidate: CandidateRecord,
  opts: RunCandidateShadowOptions,
): Promise<RunCandidateShadowResult> {
  const baselineDir = opts.baselineDir ?? path.join(opts.outputDir, 'substrates');
  const [activeRef, candidateRef] = buildSubstrates(store, candidate, baselineDir);
  const shadowCompareFn = opts.shadowCompareFn ?? runShadowCompare;

  const report = shadowCompareFn({
    substrates: [activeRef, candidateRef],
    scenarios: opts.scenarios,
    seeds: opts.seeds,
    outputDir: opts.outputDir,
    dryRun: opts.dryRun,
  });

  fs.mkdirSync(opts.outputDir, { recursive: true });
  const shadowReportPath = path.join(opts.outputDir, `${candidate.candidate_id}-shadow-report.json`);
  fs.writeFileSync(shadowReportPath, JSON.stringify(report, null, 2) + '\n');

  const gatesPassed = allGatesPassed(report.acceptance_gates);

  if (!gatesPassed) {
    const failed = transition(candidate, {
      kind: 'shadow_failed',
      at: opts.nowIso,
      actor: 'system',
      comment: `acceptance_gates: ${JSON.stringify(report.acceptance_gates)}`,
    });
    store.writeCandidate(failed);
    store.appendEvent({
      type: 'recalibration.shadow_failed',
      payload: {
        ...basePayloadFields(failed, opts.nowIso),
        shadow_report_path: shadowReportPath,
        acceptance_gates: report.acceptance_gates,
      },
      at: opts.nowIso,
    });
    return {
      record: failed, gatesPassed: false, autoPromoted: false, shadowReportPath, report,
    };
  }

  const validated = transition(candidate, {
    kind: 'shadow_validated', at: opts.nowIso, actor: 'system', shadow_report_path: shadowReportPath,
  });
  store.writeCandidate(validated);
  const validatedPayload: RecalibrationShadowValidatedPayload = {
    type: 'recalibration.shadow_validated',
    ...basePayloadFields(validated, opts.nowIso),
    shadow_report_path: shadowReportPath,
  };
  await emitter.emit('recalibration.shadow_validated', validatedPayload);

  if (validated.direction_classification !== 'improvement') {
    return {
      record: validated, gatesPassed: true, autoPromoted: false, shadowReportPath, report,
    };
  }

  const promoted = transition(validated, { kind: 'auto_promote', at: opts.nowIso, actor: 'system' });
  store.writeCandidate(promoted);
  store.promote(candidate.candidate_id, 'auto_promoted', opts.nowIso);

  const autoPromotedPayload: RecalibrationAutoPromotedPayload = {
    type: 'recalibration.auto_promoted',
    ...basePayloadFields(promoted, opts.nowIso),
  };
  await emitter.emit('recalibration.auto_promoted', autoPromotedPayload);

  return {
    record: promoted, gatesPassed: true, autoPromoted: true, shadowReportPath, report,
  };
}
