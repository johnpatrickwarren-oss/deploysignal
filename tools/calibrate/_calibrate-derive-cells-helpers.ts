// tools/calibrate/_calibrate-derive-cells-helpers.ts — per-cell builders +
// post-processing passes for baseline_cells derivation. Logic extracted
// VERBATIM from the pre-split tools/calibrate.ts god-file `deriveBaselineCells`
// (D-54-3 god-file decomposition); each helper < 100 lines, preserving exact
// ordering, side effects, and returned shapes. The orchestrating
// deriveBaselineCells lives in _calibrate-derive-cells.ts.

import type {
  BaselineBundle, CompilerOptions, BaselineCellEntry,
  FamilyAPerSignalParams, FamilyCPerCell, TenantTier,
} from '../../engine/types';
import { resolveSignalClass } from '../../engine/signal-classes.js';
import {
  applyAggregateShrinkage, columnMean, relativeDeviations, sampleCovariance,
} from '../calibrators/family-c.js';
import {
  MIN_SAMPLES_STRICT, MIN_SAMPLES_POOLED, MIN_PER_SIGNAL_SAMPLES,
} from './_calibrate-constants.js';
import { pushIfMissing, choleskyLowerTriangularLocal } from './_calibrate-data-prep.js';
import { buildFamilyAPerSignal } from './_calibrate-family-wrappers.js';
import type { CompileAggregator, CellSamples2D, FamilyCRowsPerCell } from './_calibrate-types.js';

export interface PendingBuildTask {
  entryIdx: number;
  tier: TenantTier;
  n_samples: number;
  spec: { rows: number[][]; key: Record<string, number | string> } | null;
  /** Q2.B.4 — cell's own rows for per-cell μ + adaptive Σ shrinkage
   *  even when buildCellSpec is null (n < p+1). May be empty array
   *  if rowCells absent or the cell has zero samples. */
  perCellRows: number[][];
}

/** Q60 Phase-3.d.1 (A) — filter familyASignals down to those present in
 *  the bundle (≥ MIN_PER_SIGNAL_SAMPLES samples). Returns the present list;
 *  warns about omitted signals. */
export function filterPresentFamilyASignals(
  bundle: BaselineBundle, familyASignals: readonly string[],
): readonly string[] {
  const sampleCountBySignal = new Map<string, number>();
  for (const sig of familyASignals) sampleCountBySignal.set(sig, 0);
  for (const run of bundle.runs) {
    for (const sig of familyASignals) {
      const series = run.signal_series[sig];
      if (series) sampleCountBySignal.set(sig, (sampleCountBySignal.get(sig) ?? 0) + series.length);
    }
  }
  const presentFamilyASignals = familyASignals.filter(
    (sig) => (sampleCountBySignal.get(sig) ?? 0) >= MIN_PER_SIGNAL_SAMPLES);
  const omittedFamilyASignals = familyASignals.filter(
    (sig) => (sampleCountBySignal.get(sig) ?? 0) < MIN_PER_SIGNAL_SAMPLES);
  if (omittedFamilyASignals.length > 0) {
    console.warn(
      `[calibrate] Q60 Phase-3.d.1 (A) sparse-signal emission: omitting `
      + `family_A.per_signal[sig] for signals lacking samples: `
      + `${omittedFamilyASignals.join(', ')} (substrate signal coverage: `
      + `${presentFamilyASignals.join(', ') || '<none>'}).`);
  }
  return presentFamilyASignals;
}

/** Q2.B.5 (per Q2-B-5-SIGMA-COHERENCE-SPEC.md) — Σ-coherence enforcement
 *  (Stage 3). Derive raw-space σ² from Σ_C diagonal for each overlapping
 *  (Family A, Family C) signal. Mutates entry.family_A per_signal in place. */
export function enforceSigmaCoherence(
  cellEntries: BaselineCellEntry[], familyCSignals: readonly string[],
): void {
  for (const entry of cellEntries) {
    const fc = entry.family_C;
    const familyAPerSignal = entry.family_A?.per_signal;
    if (!fc?.covariance || !fc?.mean_vector || !familyAPerSignal) continue;
    for (let i = 0; i < familyCSignals.length; i++) {
      const sig = familyCSignals[i];
      const ps = familyAPerSignal[sig];
      if (!ps) continue;  // Family A doesn't include this signal
      const muRaw = ps.baseline_mean_raw ?? ps.baseline_mean;
      const sigmaCDiag = fc.covariance[i][i];
      // σ²_A_raw = μ_raw² · Σ_C_blended[i,i] (relative-deviation identity:
      // Var(r) = Var(x)/μ²; substituting back gives Var(x) = μ² · Var(r)).
      let sigma2Raw = muRaw * muRaw * sigmaCDiag;
      const SIGMA2_FLOOR_CV = 1e-6;
      const muRawSquared = muRaw * muRaw;
      const rawFloor = Math.max(
        Number.EPSILON * muRawSquared,
        SIGMA2_FLOOR_CV * muRawSquared,
      );
      if (sigma2Raw < rawFloor) sigma2Raw = rawFloor;
      ps.baseline_sigma_squared_raw = sigma2Raw;
    }
  }
}

/** Q2.B.4 — μ-coherence audit. Walks all cells; computes per-cell coherence
 *  residual, stamps it, halts on threshold breach, and logs the summary.
 *  Mutates fc.coherence_residual in place. */
export function auditMuCoherence(
  cellEntries: BaselineCellEntry[], familyCSignals: readonly string[],
): void {
  const FP_TOLERANCE = 1e-12;
  const COHERENCE_HALT_THRESHOLD = 1e-9;
  let maxObservedResidual = 0;
  let worstCellKey: Record<string, string | number> | undefined;
  let aggregateFallbackUsedCount = 0;
  for (const entry of cellEntries) {
    const fc = entry.family_C;
    if (!fc) continue;
    if (fc.aggregate_fallback_used) aggregateFallbackUsedCount += 1;
    const muC = fc.mean_vector;
    const familyA = entry.family_A?.per_signal;
    if (!muC || !familyA) {
      fc.coherence_residual = 0;
      continue;
    }
    let cellMax = 0;
    for (let i = 0; i < familyCSignals.length; i++) {
      const sig = familyCSignals[i];
      const muA = familyA[sig]?.baseline_mean_raw
        ?? familyA[sig]?.baseline_mean;
      if (muA === undefined) continue;
      const denom = Math.max(Math.abs(muA), FP_TOLERANCE);
      const residual = Math.abs(muC[i] - muA) / denom;
      if (residual > cellMax) cellMax = residual;
    }
    fc.coherence_residual = cellMax;
    if (cellMax > maxObservedResidual) {
      maxObservedResidual = cellMax;
      worstCellKey = entry.key;
    }
    if (cellMax > COHERENCE_HALT_THRESHOLD) {
      throw new Error(
        `[calibrate] Q2.B.4 coherence audit FAILED at cell ${JSON.stringify(entry.key)}: `
        + `coherence_residual=${cellMax.toExponential(3)} > ${COHERENCE_HALT_THRESHOLD.toExponential(0)}. `
        + `Family A and Family C means disagree post-fix; audit + investigate.`,
      );
    }
  }
  console.log(
    `[calibrate] Q2.B.4 coherence audit: max_residual=${maxObservedResidual.toExponential(3)} `
    + `(worst cell ${JSON.stringify(worstCellKey ?? '(none)')}); `
    + `${cellEntries.length}/${cellEntries.length} cells pass; `
    + `${aggregateFallbackUsedCount} cells used Σ shrinkage (α<1).`,
  );
}

/** Pass-3 stitch — aggregate-fallback (Q2.B.4 single-source μ + adaptive Σ
 *  shrinkage) branch for one task. Mutates entry.family_C in place. */
export function stitchAggregateFallback(
  entry: BaselineCellEntry, task: PendingBuildTask,
  aggregateFamilyC: FamilyCPerCell, familyCSignals: readonly string[],
): void {
  const perCellRows = task.perCellRows;
  const p = familyCSignals.length;
  const familyAPerSignal = entry.family_A?.per_signal ?? {};
  const cellEmpiricalMean = perCellRows.length >= 1
    ? columnMean(perCellRows)
    : aggregateFamilyC.mean_vector.slice();
  const perCellMean = new Array(p).fill(0);
  for (let k = 0; k < p; k++) {
    const sig = familyCSignals[k];
    // Q2.B.6c — source from baseline_mean_raw (raw observation space) when
    // available; fall back to baseline_mean (pre-Q2.B.5 configs).
    const muA = familyAPerSignal[sig]?.baseline_mean_raw
      ?? familyAPerSignal[sig]?.baseline_mean;
    if (muA !== undefined) {
      perCellMean[k] = muA;
    } else {
      perCellMean[k] = cellEmpiricalMean[k];
    }
  }
  let perCellSigma: number[][];
  if (perCellRows.length >= p + 1) {
    const Z = relativeDeviations(perCellRows, perCellMean);
    perCellSigma = sampleCovariance(Z);
  } else {
    perCellSigma = aggregateFamilyC.covariance;
  }
  // Q2.B.6a — rank-sufficient (n ≥ p+1) cells use Σ_pc directly;
  // rank-deficient cells use Σ_aggregate. shrinkage_alpha is binary {0, 1}.
  const { cov: shrunkCov, alpha } = applyAggregateShrinkage(
    perCellSigma,
    aggregateFamilyC.covariance,
    perCellRows.length,
    p + 1,
  );
  const shrunkCholesky = choleskyLowerTriangularLocal(shrunkCov);
  entry.family_C = {
    mean_vector: perCellMean,
    covariance: shrunkCov,
    covariance_method: 'aggregate_fallback',
    outlier_detection: null,
    mmd_params: null,
    hotelling_variant: aggregateFamilyC.hotelling_variant,
    safe_hotelling_params: aggregateFamilyC.safe_hotelling_params ?? null,
// Q68 .C consolidation: mmd_variant retired from schema
    e_mmd_params: null,
    cholesky_L: shrunkCholesky,
    shrinkage_alpha: alpha,
    aggregate_fallback_used: alpha < 1,
  };
}

/** Pass-3 stitch — per-cell-calibration-succeeded (α = 1) branch for one
 *  task. Mutates entry.family_C in place. */
export function stitchPerCellCalibration(
  entry: BaselineCellEntry, cell: FamilyCPerCell, familyCSignals: readonly string[],
): void {
  // Q2.B.6c — override mean_vector to use Family A's per-signal
  // baseline_mean_raw for overlapping signals (raw observation space).
  const familyAPerSignal = entry.family_A?.per_signal ?? {};
  const muVec = cell.mean_vector.slice();
  for (let k = 0; k < familyCSignals.length; k++) {
    const sig = familyCSignals[k];
    const muA = familyAPerSignal[sig]?.baseline_mean_raw
      ?? familyAPerSignal[sig]?.baseline_mean;
    if (muA !== undefined) muVec[k] = muA;
  }
  entry.family_C = cell;
  entry.family_C.mean_vector = muVec;
  entry.family_C.shrinkage_alpha = 1;
  entry.family_C.aggregate_fallback_used = false;
}

/** REPLY-42 §1(a) — build the empty-non-aggregate-tier short-circuit entry
 *  (confidence='none' + D3 aggregate-cov inheritance). */
export function buildEmptyTierEntry(
  h: number, d: number, twoD: boolean, tier: TenantTier,
  tenantTierMap: Record<string, TenantTier> | null,
  aggregateFamilyC: FamilyCPerCell | undefined,
): BaselineCellEntry {
  const keyOut: Record<string, string | number> = twoD
    ? { hour_of_day: h, day_of_week: d } : { hour_of_day: h };
  if (tenantTierMap) keyOut.tenant_tier = tier;
  const entry: BaselineCellEntry = {
    key: keyOut,
    n_samples: 0,
    confidence: 'none',
  };
  if (aggregateFamilyC) {
    entry.family_C = {
      mean_vector: aggregateFamilyC.mean_vector.slice(),
      covariance: aggregateFamilyC.covariance.map((row) => row.slice()),
      covariance_method: 'aggregate_fallback',
      outlier_detection: null,
      mmd_params: null,
      hotelling_variant: aggregateFamilyC.hotelling_variant,
      safe_hotelling_params: aggregateFamilyC.safe_hotelling_params ?? null,
// Q68 .C consolidation: mmd_variant retired from schema
      e_mmd_params: null,
      cholesky_L: aggregateFamilyC.cholesky_L
        ? aggregateFamilyC.cholesky_L.map((row) => row.slice())
        : undefined,
    };
  }
  return entry;
}

/** Context shared across the Pass-1 per-cell builder. */
export interface CellBuildContext {
  twoD: boolean;
  cells: CellSamples2D[];
  rowCells: FamilyCRowsPerCell[] | null;
  cellIdx: (h: number, d: number, tier: TenantTier) => number;
  poolFamilyA: (signal: string, h: number, d: number, tier: TenantTier) =>
    { samples: number[]; fromKeys: Array<Record<string, number | string>> };
  poolFamilyCRows: (h: number, d: number, tier: TenantTier) =>
    { rows: number[][]; fromKeys: Array<Record<string, number | string>> };
  familyASignals: readonly string[];
  familyCSignals: readonly string[];
  compilerOpts: CompilerOptions;
  tenantTierMap: Record<string, TenantTier> | null;
  agg: CompileAggregator;
}

/** Pass-1 per-(h,d,tier) cell builder. Pushes the entry into cellEntries
 *  and the matching PendingBuildTask into pendingBuildTasks. Mirrors the
 *  pre-split inner loop body exactly (strict/pooled/else dispatch). */
export function buildCellPass1(
  ctx: CellBuildContext, h: number, d: number, tier: TenantTier,
  aggregateFamilyC: FamilyCPerCell | undefined,
  cellEntries: BaselineCellEntry[], pendingBuildTasks: PendingBuildTask[],
): void {
  const {
    twoD, cells, rowCells, cellIdx, poolFamilyA, poolFamilyCRows,
    familyASignals, familyCSignals, compilerOpts, tenantTierMap, agg,
  } = ctx;
  const idx = cellIdx(h, d, tier);
  const raw = cells[idx];
  let primaryN = 0;
  for (const sig of familyASignals) {
    const n = raw.perSignal[sig]?.length ?? 0;
    if (n > primaryN) primaryN = n;
  }
  const rawRowCount = rowCells ? rowCells[idx].rows.length : 0;
  const effectiveN = Math.max(primaryN, rawRowCount);

  // REPLY-42 §1(a) — empty non-aggregate tier short-circuit.
  if (tier !== 'aggregate' && effectiveN === 0) {
    cellEntries.push(buildEmptyTierEntry(h, d, twoD, tier, tenantTierMap, aggregateFamilyC));
    return;
  }

  let confidence: BaselineCellEntry['confidence'];
  let pooled_from: Array<Record<string, number | string>> | undefined;
  let variance_inflated: boolean | undefined;
  const familyA_perSignal: Record<string, FamilyAPerSignalParams> = {};
  let buildCellSpec: { rows: number[][]; key: Record<string, number | string> } | null = null;
  let n_samples = effectiveN;

  if (effectiveN >= MIN_SAMPLES_STRICT) {
    confidence = 'strict';
    for (const signal of familyASignals) {
      const cls = resolveSignalClass(signal, compilerOpts.signal_classes);
      familyA_perSignal[signal] = buildFamilyAPerSignal(
        raw.perSignal[signal] ?? [], agg, cls);
    }
    if (rowCells && rowCells[idx].rows.length >= familyCSignals.length + 1) {
      const cellKey: Record<string, number | string> = twoD
        ? { hour_of_day: h, day_of_week: d } : { hour_of_day: h };
      if (tenantTierMap) cellKey.tenant_tier = tier;
      buildCellSpec = { rows: rowCells[idx].rows, key: cellKey };
    }
  } else if (effectiveN >= MIN_SAMPLES_POOLED) {
    confidence = 'pooled';
    variance_inflated = true;
    pooled_from = [];
    let pooledN = 0;
    for (const signal of familyASignals) {
      const r = poolFamilyA(signal, h, d, tier);
      const cls = resolveSignalClass(signal, compilerOpts.signal_classes);
      familyA_perSignal[signal] = buildFamilyAPerSignal(r.samples, agg, cls);
      for (const k of r.fromKeys) pooled_from = pushIfMissing(pooled_from, k);
      if (signal === 'p99_latency') pooledN = r.samples.length;
    }
    n_samples = pooledN;
    if (rowCells) {
      const r = poolFamilyCRows(h, d, tier);
      if (r.rows.length >= familyCSignals.length + 1) {
        const cellKey: Record<string, number | string> = twoD
          ? { hour_of_day: h, day_of_week: d } : { hour_of_day: h };
        if (tenantTierMap) cellKey.tenant_tier = tier;
        buildCellSpec = { rows: r.rows, key: cellKey };
      }
      for (const k of r.fromKeys) pooled_from = pushIfMissing(pooled_from, k);
    }
  } else {
    confidence = effectiveN > 0 ? 'aggregate' : 'none';
    n_samples = effectiveN;
  }

  const keyOut: Record<string, string | number> = twoD
    ? { hour_of_day: h, day_of_week: d } : { hour_of_day: h };
  if (tenantTierMap) keyOut.tenant_tier = tier;

  const entry: BaselineCellEntry = { key: keyOut, n_samples, confidence };
  if (pooled_from) entry.pooled_from = pooled_from as Array<Record<string, string | number>>;
  if (variance_inflated) entry.variance_inflated = variance_inflated;
  if (confidence === 'strict' || confidence === 'pooled') {
    entry.family_A = { per_signal: familyA_perSignal };
  }
  // entry.family_C populated in Pass 3 (post-dispatch stitch).
  cellEntries.push(entry);
  const entryIdx = cellEntries.length - 1;
  pendingBuildTasks.push({
    entryIdx,
    tier,
    n_samples,
    spec: buildCellSpec,
    perCellRows: rowCells ? rowCells[idx].rows : [],
  });
}
