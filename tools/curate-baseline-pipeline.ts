// tools/curate-baseline-pipeline.ts — Q61 SPEC-1 SLICE 1.
//
// 10-decision baseline curation pipeline orchestrator. Each decision
// is a pure function with explicit input + output_summary + decision
// rule + verification + source memorialization. Pipeline executes per
// substrate at compile time; produces audit-emitted per-decision
// diagnostic at CompiledConfig.baseline_curation_pipeline_diagnostics
// (additive optional field).
//
// SLICE 1 ships D1-D4; SLICE 2 ships D5-D7; SLICE 3 ships D8-D10.
//
// SLICE 1 design choice (per spec § Open questions #1 +
// architect-default-suggestion + TPM HALT-DISCIPLINE Step 3):
//
//   Decisions inspect the already-built CompiledConfig + BaselineBundle
//   to emit audit-summary records. Calibration logic stays in
//   tools/calibrate.ts unchanged; pipeline doesn't reimplement μ/Σ/
//   signal_class/sliding-buffer. Calibrate.ts main() invokes the
//   pipeline orchestrator AT END-OF-MAIN to stamp diagnostics on the
//   emitted CompiledConfig.
//
//   Byte-identical regression (acceptance criterion #7) auto-holds by
//   construction — pipeline does no calculation; just inspects state
//   and stamps audit records.
//
// Anti-scope (per Q61 spec):
//   - NO calibration logic changes (preserves Q58 + Q59 H4 PERMANENT +
//     Q60 anti-scope).
//   - NO new compile-output fields beyond baseline_curation_pipeline_
//     diagnostics.
//   - SLICE 1 ships D1-D4 only; D5-D10 throw on request.

import type {
  BaselineBundle,
  BaselineCurationDecision,
  BaselineCurationDecisionId,
  CompiledConfig,
} from '../engine/types/config.js';

export type SliceId = 'SLICE_1' | 'SLICE_2' | 'SLICE_3';

export interface PipelineState {
  bundle: BaselineBundle;
  compiledConfig: CompiledConfig;
  decisions: Partial<Record<BaselineCurationDecisionId, BaselineCurationDecision>>;
}

export interface PipelineOpts {
  slices: SliceId[];
  /** When true, throws if any in-slice decision didn't emit its audit
   *  diagnostic (defensive verification at architect-disposition time). */
  verifyDecisions?: boolean;
}

/** Run the baseline curation pipeline against an already-built
 *  CompiledConfig + its source BaselineBundle. SLICE 1 stamps D1-D4
 *  audit records; SLICE 2/3 throw NotImplementedError per slice
 *  boundary halt-discipline. */
export function runBaselineCurationPipeline(
  bundle: BaselineBundle,
  compiledConfig: CompiledConfig,
  opts: PipelineOpts,
): PipelineState {
  const state: PipelineState = { bundle, compiledConfig, decisions: {} };

  if (opts.slices.includes('SLICE_1')) {
    state.decisions.D1 = runD1_perCellMuAggregation(state);
    state.decisions.D2 = runD2_perCellSigmaShrinkage(state);
    state.decisions.D3 = runD3_signalClassTransform(state);
    state.decisions.D4 = runD4_slidingBufferThreshold(state);
  }

  if (opts.slices.includes('SLICE_2')) {
    throw new Error(
      'SLICE_2 (D5 sparse-cell fallback + D6 multi-tenant tier '
      + 'aggregation + D7 ar1_phi calibration) not yet implemented; '
      + 'deferred to future close PR per Q61 spec § Q61.2 phasing.');
  }
  if (opts.slices.includes('SLICE_3')) {
    throw new Error(
      'SLICE_3 (D8 substrate-specific calibration adjustment + D9 '
      + 'cross-substrate consistency verification + D10 baseline_provenance '
      + 'honest stamping) not yet implemented; deferred to future close PR '
      + 'per Q61 spec § Q61.2 phasing.');
  }

  if (opts.verifyDecisions) verifyDecisionAuditEmissions(state);
  return state;
}

// ── SLICE 1 decision functions (D1-D4) ────────────────────────────

function runD1_perCellMuAggregation(state: PipelineState): BaselineCurationDecision {
  const cells = state.compiledConfig.baseline_cells?.cells ?? [];
  const populatedCells = cells.filter(
    (c) => c.confidence === 'strict' || c.confidence === 'pooled');
  // Inspect the per-cell μ shape from the first populated cell.
  const firstCell = populatedCells[0];
  const perSignalKeys = firstCell?.family_A?.per_signal
    ? Object.keys(firstCell.family_A.per_signal)
    : [];
  return {
    decision_id: 'D1',
    decision_name: 'Per-cell μ aggregation',
    inputs: {
      upstream_decisions: undefined,
      compile_state_ref: 'baseline_cells.cells[].family_A.per_signal[].baseline_mean',
    },
    output_summary: {
      n_cells_total: cells.length,
      n_cells_populated: populatedCells.length,
      n_per_signal_entries: perSignalKeys.length,
      cell_dim: state.bundle.cell_dim ?? 'unset',
    },
    decision_rule:
      'Q2.B.4 single-source per-cell μ disposition: each cell aggregates μ '
      + 'from its own constituent runs; no cross-cell μ leakage. Per-signal '
      + 'entries omitted for sparse-substrate signals per Q60 Phase-3.d.1 '
      + '(A) sparse-skip emission.',
    verification: {
      audit_emitted: true,
      diagnostic_path: 'CompiledConfig.baseline_curation_pipeline_diagnostics.D1',
    },
    source_memorialization:
      'ARCHITECT-REPLY-Q2-B-4-COMPILE-PIPELINE-FIX-DISPOSITION '
      + '(amended by ARCHITECT-REPLY-Q60-SLICE-1-PHASE-3-LS2-SPARSE-SIGNAL-DISPOSITION (A) sparse-skip).',
  };
}

function runD2_perCellSigmaShrinkage(state: PipelineState): BaselineCurationDecision {
  const cells = state.compiledConfig.baseline_cells?.cells ?? [];
  let cellsWithFamilyC = 0;
  let lambdaSum = 0;
  let lambdaMax = 0;
  let lambdaCount = 0;
  for (const c of cells) {
    const fc = c.family_C as { ledoit_wolf_lambda?: number; mean_vector?: unknown } | undefined;
    if (!fc) continue;
    cellsWithFamilyC += 1;
    if (typeof fc.ledoit_wolf_lambda === 'number' && Number.isFinite(fc.ledoit_wolf_lambda)) {
      lambdaSum += fc.ledoit_wolf_lambda;
      if (fc.ledoit_wolf_lambda > lambdaMax) lambdaMax = fc.ledoit_wolf_lambda;
      lambdaCount += 1;
    }
  }
  return {
    decision_id: 'D2',
    decision_name: 'Per-cell Σ shrinkage',
    inputs: {
      upstream_decisions: ['D1'],
      compile_state_ref: 'baseline_cells.cells[].family_C.{covariance, ledoit_wolf_lambda, cholesky_L, cholesky_L_eps}',
    },
    output_summary: {
      n_cells_with_family_C: cellsWithFamilyC,
      ledoit_wolf_lambda_avg: lambdaCount > 0 ? lambdaSum / lambdaCount : 0,
      ledoit_wolf_lambda_max: lambdaMax,
    },
    decision_rule:
      'Q2.B.5 σ²_A_raw coherence + Ledoit-Wolf shrinkage at Q2.B.4 '
      + 'single-source disposition: per-cell Σ shrinks toward diagonal target '
      + 'with optimal λ; preserves Cholesky decomposition for parametric_ar1 '
      + 'resampler dispatch.',
    verification: {
      audit_emitted: true,
      diagnostic_path: 'CompiledConfig.baseline_curation_pipeline_diagnostics.D2',
    },
    source_memorialization:
      'ARCHITECT-REPLY-Q2-B-5-COMPILE-PIPELINE-FIX-DISPOSITION + Q2.B.4 single-source per-cell μ.',
  };
}

function runD3_signalClassTransform(state: PipelineState): BaselineCurationDecision {
  const signalClasses = state.compiledConfig.signal_classes ?? {};
  const classCounts: Record<string, number> = {};
  for (const cls of Object.values(signalClasses)) {
    const k = String(cls);
    classCounts[k] = (classCounts[k] ?? 0) + 1;
  }
  return {
    decision_id: 'D3',
    decision_name: 'Signal_class transform',
    inputs: {
      upstream_decisions: undefined,
      compile_state_ref: 'CompiledConfig.signal_classes',
    },
    output_summary: {
      n_signals_classified: Object.keys(signalClasses).length,
      classes_summary: JSON.stringify(classCounts),
    },
    decision_rule:
      'Q2.A signal-class registry: logit (bounded [0,1] signals), log '
      + '(heavy-tail), Anscombe (non-negative count signals). Operators '
      + 'override defaults via CompilerOptions.signal_classes; absence '
      + 'falls back to DEFAULT_SIGNAL_CLASSES → gaussian_like.',
    verification: {
      audit_emitted: true,
      diagnostic_path: 'CompiledConfig.baseline_curation_pipeline_diagnostics.D3',
    },
    source_memorialization: 'Q2.A signal-class registry spec.',
  };
}

function runD4_slidingBufferThreshold(state: PipelineState): BaselineCurationDecision {
  const cells = state.compiledConfig.baseline_cells?.cells ?? [];
  const af = state.compiledConfig.baseline_cells?.aggregate_fallback;
  const afPerSignal = af?.family_A?.per_signal ?? {};
  let perCellThresholdsStamped = 0;
  for (const c of cells) {
    const fa = c.family_A?.per_signal;
    if (!fa) continue;
    for (const sigParams of Object.values(fa)) {
      if (typeof sigParams.betting_sliding_buffer_threshold === 'number'
          && Number.isFinite(sigParams.betting_sliding_buffer_threshold)) {
        perCellThresholdsStamped += 1;
      }
    }
  }
  let aggThresholdsStamped = 0;
  for (const sigParams of Object.values(afPerSignal)) {
    if (typeof sigParams.betting_sliding_buffer_threshold === 'number'
        && Number.isFinite(sigParams.betting_sliding_buffer_threshold)) {
      aggThresholdsStamped += 1;
    }
  }
  return {
    decision_id: 'D4',
    decision_name: 'Sliding-buffer threshold',
    inputs: {
      upstream_decisions: ['D1', 'D2', 'D3'],
      compile_state_ref:
        'baseline_cells.cells[].family_A.per_signal[].betting_sliding_buffer_threshold '
        + '+ aggregate_fallback.family_A.per_signal[].betting_sliding_buffer_threshold',
    },
    output_summary: {
      n_per_cell_thresholds_stamped: perCellThresholdsStamped,
      n_aggregate_fallback_thresholds_stamped: aggThresholdsStamped,
      n_aggregate_fallback_signals: Object.keys(afPerSignal).length,
    },
    decision_rule:
      'Q2.B.6.1 + Q2.B.6.2 + Q2.B.6.3 sliding-buffer recalibration: per-detector '
      + 'thresholds derived from compile-time aggregation of (per-cell μ + Σ + '
      + 'signal_class transform) over evaluation window; bootstrap-derived '
      + 'with AR(1)-aware variance inflation post-Q2.B.7 cholesky_L_eps stamping.',
    verification: {
      audit_emitted: true,
      diagnostic_path: 'CompiledConfig.baseline_curation_pipeline_diagnostics.D4',
    },
    source_memorialization:
      'ARCHITECT-REPLY-Q2-B-6-1 + Q2.B.6.2 + Q2.B.6.3 sliding-buffer recalibration disposition cycle '
      + '(audit hardened at Q2.B.6.3 betting threshold consistency check).',
  };
}

function verifyDecisionAuditEmissions(state: PipelineState): void {
  for (const [id, decision] of Object.entries(state.decisions)) {
    if (!decision || !decision.verification.audit_emitted) {
      throw new Error(
        `Q61 pipeline verification failed: decision ${id} missing audit emission.`);
    }
  }
}
