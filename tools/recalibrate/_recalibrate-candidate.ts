// tools/recalibrate/_recalibrate-candidate.ts — Addition #15 baseline-
// maintenance lifecycle, Task 8. The `propose` flow: load the active +
// candidate CompiledConfigs, run the pre-shadow readiness gates (Task
// 4), classify direction (Task 3), compute the comparison report (Task
// 4), and assemble a fresh CandidateRecord — driving it through
// pending_readiness -> {pending_shadow | rejected} via the Task 2 state
// machine, exactly as that module's header anticipates ("the CLI's
// propose handler is expected to build such a record directly for its
// exit-2 path, but the state machine supports the transition too").
//
// D6 (engine/tools split): this module is I/O (reads CompiledConfig
// JSON off disk) so it lives in tools/, not engine/ — but every
// classification/gate/comparison decision it makes delegates straight
// to the pure engine/recalibration/* modules; no math is re-derived
// here.

import * as fs from 'node:fs';

import type {
  CandidateRecord, CreationReason,
} from '../../engine/types/recalibration';
import { RECALIBRATION_REASON_CODES } from '../../engine/types/recalibration';
import type { CompiledConfig } from '../../engine/types';
import { transition } from '../../engine/recalibration/state-machine';
import { classifyRecalibration } from '../../engine/recalibration/classify';
import {
  compareCandidateVsActive, evaluateReadinessGates, extractSignalMeans,
  type ReadinessGateResult, type ExclusionWindow,
} from '../../engine/recalibration/compare';
import { computeTimeoutAt } from '../../engine/recalibration/timeout';
import type { RecalibrationStore } from './_recalibrate-store';

export interface ProposeSourceWindow {
  start: string;
  end: string;
  n_samples: number;
}

export interface ProposeInput {
  store: RecalibrationStore;
  candidateId: string;
  candidateConfigPath: string;
  creationReason: CreationReason;
  sourceWindow: ProposeSourceWindow;
  driftOutput?: object;
  nowIso: string;
}

export interface ProposeOutcome {
  record: CandidateRecord;
  readiness: ReadinessGateResult;
  accepted: boolean;
}

function readCompiledConfig(filePath: string): CompiledConfig {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CompiledConfig;
}

/** Mirrors engine/recalibration/compare.ts's private half-open
 *  [start, end) `windowsOverlap` — not exported from there, duplicated
 *  here (metadata-only use: counting how many declared exclusion
 *  windows overlapped the source window, for
 *  CandidateRecord.source_window.excluded_windows_applied). The actual
 *  pass/fail gate decision is evaluateReadinessGates's job, not this
 *  count. */
function windowsOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Build a fresh CandidateRecord from a proposed candidate CompiledConfig
 *  against the service's currently-active one. Always computes
 *  classification + comparison (even on a readiness failure) so the
 *  rejected record is maximally informative for the operator; falls
 *  back to the conservative 'mixed' verdict only in the degenerate case
 *  where active/candidate share zero comparable signals (classify's
 *  documented empty-intersection throw). */
export function buildProposedCandidate(input: ProposeInput): ProposeOutcome {
  const meta = input.store.readMeta();
  const active = input.store.readActive();
  if (!active) {
    throw new Error(
      `propose: service '${meta.service_id}' has no active baseline yet — bootstrap active.json before proposing candidates`,
    );
  }

  const activeConfig = readCompiledConfig(active.compiled_config_path);
  const candidateConfig = readCompiledConfig(input.candidateConfigPath);
  const exclusions: ExclusionWindow[] = input.store.readExclusionWindows();

  const readiness = evaluateReadinessGates(
    activeConfig, candidateConfig, input.sourceWindow, exclusions,
  );

  const classification = classifyCandidate(activeConfig, candidateConfig, meta);
  const comparison = compareCandidateVsActive(activeConfig, candidateConfig);
  const excludedWindowsApplied = exclusions.filter((w) => windowsOverlap(input.sourceWindow, w)).length;

  const created: CandidateRecord = {
    schema_version: '1',
    service_id: meta.service_id,
    candidate_id: input.candidateId,
    proposed_baseline_version: candidateConfig.version,
    current_baseline_version: active.version_id,
    direction_classification: classification.direction_classification,
    per_signal_direction: classification.per_signal_direction,
    suggested_reason_codes: classification.suggested_reason_codes,
    shadow_mode_validated_at: null,
    timeout_at: computeTimeoutAt(input.nowIso, meta.timeout_days),
    status: 'candidate',
    review_status: 'pending_readiness',
    creation_reason: input.creationReason,
    created_at: input.nowIso,
    source_window: {
      start: input.sourceWindow.start,
      end: input.sourceWindow.end,
      n_samples: input.sourceWindow.n_samples,
      excluded_windows_applied: excludedWindowsApplied,
    },
    compiled_config_path: input.candidateConfigPath,
    drift_output: input.driftOutput,
    comparison: comparison as unknown as object,
    outcome: null,
    history: [{ at: input.nowIso, actor: 'system', action: 'created' }],
  };

  const record = transition(created, readiness.all_passed
    ? { kind: 'readiness_passed', at: input.nowIso, actor: 'system', readiness: readiness as unknown as object }
    : { kind: 'readiness_failed', at: input.nowIso, actor: 'system', readiness: readiness as unknown as object });

  return { record, readiness, accepted: readiness.all_passed };
}

function classifyCandidate(
  activeConfig: CompiledConfig,
  candidateConfig: CompiledConfig,
  meta: { unchanged_epsilon_rel: number; informational_direction_overrides: Record<string, 'higher' | 'lower'> },
): { direction_classification: CandidateRecord['direction_classification']; per_signal_direction: CandidateRecord['per_signal_direction']; suggested_reason_codes: string[] } {
  try {
    return classifyRecalibration(
      buildSignalMeans(activeConfig),
      buildSignalMeans(candidateConfig),
      { epsilon: meta.unchanged_epsilon_rel, overrides: meta.informational_direction_overrides },
    );
  } catch (_err) {
    // Empty signal intersection — nothing to classify. Conservative
    // 'mixed' + full reason-code list (same shape as a degradation/mixed
    // verdict) so the record still routes to operator review rather
    // than silently defaulting to something that could auto-promote.
    return {
      direction_classification: 'mixed',
      per_signal_direction: {},
      suggested_reason_codes: [...RECALIBRATION_REASON_CODES],
    };
  }
}

function buildSignalMeans(cfg: CompiledConfig): Record<string, number> {
  return extractSignalMeans(cfg);
}
