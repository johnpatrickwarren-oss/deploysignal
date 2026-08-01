// tools/calibrate/_calibrate-derive-cells.ts — W3 §3.1.c baseline_cells
// derivation orchestrator. Logic extracted VERBATIM from the pre-split
// tools/calibrate.ts god-file (D-54-3 god-file decomposition); the ~581-line
// deriveBaselineCells is decomposed into module-level helpers (here +
// _calibrate-derive-cells-helpers.ts), each < 100 lines, preserving exact
// ordering, side effects, and returned shapes.

import type {
  BaselineBundle, CompilerOptions, BaselineCellsConfig, BaselineCellEntry,
  FamilyAPerSignalParams, FamilyCPerCell, TenantTier,
} from '../../engine/types';
import { resolveSignalClass } from '@johnpatrickwarren-oss/deploysignal-engine/signal-classes';
import {
  EMITTED_TIERS, FAMILY_A_SIGNALS, FAMILY_C_SIGNALS, MIN_SAMPLES_POOLED,
} from './_calibrate-constants.js';
import {
  collectCellSamples2D, collectFamilyCRows,
} from './_calibrate-data-prep.js';
import { newCompileAggregator } from './_calibrate-aggregator.js';
import { buildFamilyAPerSignal, buildFamilyCPerCell } from './_calibrate-family-wrappers.js';
import type {
  CompileAggregator, CellSamples2D, FamilyCRowsPerCell,
} from './_calibrate-types.js';
import type { CellWorkerPool } from './_calibrate-worker-pool.js';
import {
  filterPresentFamilyASignals, enforceSigmaCoherence, auditMuCoherence,
  buildCellPass1, stitchAggregateFallback, stitchPerCellCalibration,
  type PendingBuildTask, type CellBuildContext,
} from './_calibrate-derive-cells-helpers.js';

/** W3 §3.1.c — build the unified `baseline_cells` block with 2-D cells
 *  (hour × day), hierarchical pooling per ARCHITECT-REPLY-09.md Q2, and
 *  Family A + Family C per-cell parameters. For 1-D bundles (W2 format),
 *  still emits 24 hour-only cells with `dimensions: ['hour_of_day']`.
 *
 *  Addition #23 — when `tenantTierMap` is non-null, cells multiply by the
 *  emitted tier set (5-wide, incl. 'aggregate'): 168 × 5 = 840 entries
 *  on a 2-D bundle. Pre-#23 bundles (tenantTierMap === null) stay at
 *  168 cells, 'aggregate' tier, behaviorally identical to pre-#23. */
export async function deriveBaselineCells(
  bundle: BaselineBundle,
  emitFamilyC: boolean,
  compilerOpts: CompilerOptions = {},
  alphaMMD?: number,
  tenantTierMap: Record<string, TenantTier> | null = null,
  pool: CellWorkerPool | null = null,
  familyASignals: readonly string[] = FAMILY_A_SIGNALS,
  familyCSignals: readonly string[] = FAMILY_C_SIGNALS,
  agg: CompileAggregator = newCompileAggregator(),
): Promise<BaselineCellsConfig> {
  if (bundle.cell_dim !== 'hour_of_day' && bundle.cell_dim !== 'hour_of_day_x_day_of_week') {
    throw new Error('baseline_cells derivation requires cell_dim to be hour_of_day or hour_of_day_x_day_of_week.');
  }
  const twoD = bundle.cell_dim === 'hour_of_day_x_day_of_week';
  const dayCount = twoD ? 7 : 1;
  const tiers: TenantTier[] = tenantTierMap ? EMITTED_TIERS : ['aggregate'];

  familyASignals = filterPresentFamilyASignals(bundle, familyASignals);

  // Per-signal samples (Family A) and multi-signal rows (Family C).
  const cells = collectCellSamples2D(bundle, tenantTierMap);
  const rowCells = emitFamilyC ? collectFamilyCRows(bundle, tenantTierMap, familyCSignals) : null;
  const tierPos = (tier: TenantTier): number => {
    const i = tiers.indexOf(tier);
    return i < 0 ? tiers.indexOf('aggregate') : i;
  };
  const cellIdx = (h: number, d: number, tier: TenantTier): number =>
    tierPos(tier) * dayCount * 24 + (twoD ? d * 24 + h : h);

  // Pool samples for Family A across neighboring cells with the Addition
  // #2 hierarchy: adjacent hours within the same day first, then across
  // days only if still sparse. Pooling stays WITHIN the target tier.
  const poolFamilyA = makePoolFamilyA(cells, twoD, tenantTierMap, cellIdx);
  // Same hierarchy for Family C's row matrices; tier-constrained.
  const poolFamilyCRows = makePoolFamilyCRows(rowCells, twoD, tenantTierMap, cellIdx);

  const cellEntries: BaselineCellEntry[] = [];
  // Aggregate data (across all cells + all tiers) for the aggregate_fallback
  // block. 'aggregate' tier cells already carry cross-tenant pooled samples.
  const { aggregateSamples, aggregateRows } =
    collectAggregateData(cells, rowCells, familyASignals);

  // REPLY-50 D2 — dispatch wrapper (worker thread when pooled, else serial).
  const dispatchBuildCell = makeDispatchBuildCell(pool, agg);

  // Build aggregate_fallback covariance eagerly so the per-tier
  // 'aggregate_fallback' path below can inherit it on sparse tiers.
  const aggregateFamilyC: FamilyCPerCell | undefined =
    (emitFamilyC && aggregateRows.length >= familyCSignals.length + 1)
      ? await dispatchBuildCell(aggregateRows, compilerOpts, { hour_of_day: -1 }, alphaMMD)
      : undefined;

  // MCD sample-size floor per REPLY-38. Tiers whose pooled n is below
  // this route their covariance through D3 aggregate_fallback.
  const mcdFloor = Math.max(5 * familyCSignals.length, 200);

  // REPLY-50 D2 — Pass-1 accumulator for per-cell buildFamilyCPerCell
  // dispatch.
  const pendingBuildTasks: PendingBuildTask[] = [];
  const ctx: CellBuildContext = {
    twoD, cells, rowCells, cellIdx, poolFamilyA, poolFamilyCRows,
    familyASignals, familyCSignals, compilerOpts, tenantTierMap, agg,
  };

  for (const tier of tiers) {
    for (let d = 0; d < dayCount; d++) {
      for (let h = 0; h < 24; h++) {
        buildCellPass1(ctx, h, d, tier, aggregateFamilyC, cellEntries, pendingBuildTasks);
      }
    }
  }

  // Pass 2 — parallel dispatch. When pool is null, dispatchBuildCell runs
  // in-process serially (preserves pre-slice-2 semantics).
  const cellResults: Array<FamilyCPerCell | null> = await Promise.all(
    pendingBuildTasks.map((t) =>
      t.spec === null ? Promise.resolve(null) :
        dispatchBuildCell(t.spec.rows, compilerOpts, t.spec.key, alphaMMD),
    ),
  );

  // Pass 3 — stitch cellResults into entry.family_C. Addition #23 D3
  // per-tier covariance sample-size fallback applies here.
  stitchPass3(
    pendingBuildTasks, cellResults, cellEntries,
    aggregateFamilyC, mcdFloor, familyCSignals);

  // Q2.B.5 — Σ-coherence enforcement (Stage 3).
  enforceSigmaCoherence(cellEntries, familyCSignals);

  // Q2.B.4 — μ-coherence audit (also asserts σ²_A_raw coherence).
  auditMuCoherence(cellEntries, familyCSignals);

  return assembleBaselineCellsConfig(
    cellEntries, familyASignals, aggregateSamples, aggregateFamilyC,
    agg, compilerOpts, twoD, tenantTierMap);
}

/** Family A pooling closure factory. Returns `poolFamilyA` with its captured
 *  cell grid + indexing identical to the pre-split inline closure: pool
 *  samples across neighboring cells with the Addition #2 hierarchy (adjacent
 *  hours within the same day first, then across days only if still sparse).
 *  Pooling stays WITHIN the target tier. */
function makePoolFamilyA(
  cells: CellSamples2D[], twoD: boolean,
  tenantTierMap: Record<string, TenantTier> | null,
  cellIdx: (h: number, d: number, tier: TenantTier) => number,
): (signal: string, h: number, d: number, tier: TenantTier) =>
  { samples: number[]; fromKeys: Array<Record<string, number | string>> } {
  return function poolFamilyA(signal: string, h: number, d: number, tier: TenantTier): { samples: number[]; fromKeys: Array<Record<string, number | string>> } {
    const samples: number[] = [];
    const fromKeys: Array<Record<string, number | string>> = [];
    const keyFor = (h2: number, d2: number): Record<string, number | string> => {
      const k: Record<string, number | string> = { hour_of_day: h2 };
      if (twoD) k.day_of_week = d2;
      if (tenantTierMap) k.tenant_tier = tier;
      return k;
    };
    for (let dh = -2; dh <= 2; dh++) {
      const h2 = (h + dh + 24) % 24;
      const s = cells[cellIdx(h2, d, tier)].perSignal[signal];
      if (!s) continue;
      for (const v of s) samples.push(v);
      fromKeys.push(keyFor(h2, d));
    }
    if (samples.length >= MIN_SAMPLES_POOLED) return { samples, fromKeys };
    if (twoD) {
      for (let d2 = 0; d2 < 7; d2++) {
        if (d2 === d) continue;
        const s = cells[cellIdx(h, d2, tier)].perSignal[signal];
        if (!s) continue;
        for (const v of s) samples.push(v);
        fromKeys.push(keyFor(h, d2));
      }
    }
    return { samples, fromKeys };
  };
}

/** Family C row-matrix pooling closure factory. Returns `poolFamilyCRows`
 *  with the same hierarchy as `makePoolFamilyA`, tier-constrained. */
function makePoolFamilyCRows(
  rowCells: FamilyCRowsPerCell[] | null, twoD: boolean,
  tenantTierMap: Record<string, TenantTier> | null,
  cellIdx: (h: number, d: number, tier: TenantTier) => number,
): (h: number, d: number, tier: TenantTier) =>
  { rows: number[][]; fromKeys: Array<Record<string, number | string>> } {
  return function poolFamilyCRows(h: number, d: number, tier: TenantTier): { rows: number[][]; fromKeys: Array<Record<string, number | string>> } {
    const rows: number[][] = [];
    const fromKeys: Array<Record<string, number | string>> = [];
    if (!rowCells) return { rows, fromKeys };
    const keyFor = (h2: number, d2: number): Record<string, number | string> => {
      const k: Record<string, number | string> = { hour_of_day: h2 };
      if (twoD) k.day_of_week = d2;
      if (tenantTierMap) k.tenant_tier = tier;
      return k;
    };
    for (let dh = -2; dh <= 2; dh++) {
      const h2 = (h + dh + 24) % 24;
      const c = rowCells[cellIdx(h2, d, tier)];
      for (const r of c.rows) rows.push(r);
      if (c.rows.length > 0) fromKeys.push(keyFor(h2, d));
    }
    if (rows.length >= MIN_SAMPLES_POOLED) return { rows, fromKeys };
    if (twoD) {
      for (let d2 = 0; d2 < 7; d2++) {
        if (d2 === d) continue;
        const c = rowCells[cellIdx(h, d2, tier)];
        for (const r of c.rows) rows.push(r);
        if (c.rows.length > 0) fromKeys.push(keyFor(h, d2));
      }
    }
    return { rows, fromKeys };
  };
}

/** Aggregate data (across all cells + all tiers) for the aggregate_fallback
 *  block. 'aggregate' tier cells already carry cross-tenant pooled samples.
 *  Mirrors the pre-split inline collection block exactly. */
function collectAggregateData(
  cells: CellSamples2D[], rowCells: FamilyCRowsPerCell[] | null,
  familyASignals: readonly string[],
): { aggregateSamples: Record<string, number[]>; aggregateRows: number[][] } {
  const aggregateSamples: Record<string, number[]> = {};
  for (const signal of familyASignals) aggregateSamples[signal] = [];
  const aggregateRows: number[][] = [];
  for (const cell of cells) {
    if (cell.tier !== 'aggregate') continue;  // avoid double-counting
    for (const signal of familyASignals) {
      const s = cell.perSignal[signal];
      if (s) for (const v of s) aggregateSamples[signal].push(v);
    }
  }
  if (rowCells) for (const c of rowCells) if (c.tier === 'aggregate') for (const r of c.rows) aggregateRows.push(r);
  return { aggregateSamples, aggregateRows };
}

/** REPLY-50 D2 — dispatch-wrapper factory. Returns `dispatchBuildCell`:
 *  pool-dispatched calls run in a worker thread; serial fallback runs
 *  in-process. Either path returns a FamilyCPerCell identical to the direct
 *  buildFamilyCPerCell invocation. */
function makeDispatchBuildCell(
  pool: CellWorkerPool | null, agg: CompileAggregator,
): (
  rows: number[][], opts: CompilerOptions,
  key: Record<string, string | number>, mmdAlpha?: number,
) => Promise<FamilyCPerCell> {
  return async (
    rows: number[][],
    opts: CompilerOptions,
    key: Record<string, string | number>,
    mmdAlpha?: number,
  ): Promise<FamilyCPerCell> => {
    if (pool) {
      const reply = await pool.run({ rows, opts, key, alphaMMD: mmdAlpha });
      if (!reply.result) throw new Error(`worker returned no result for key ${JSON.stringify(key)}`);
      // Slice-3d — unpack structured reply into the compile-local aggregator.
      agg.timings.cov_estimation_ns += reply.result.timings.cov_estimation_ns;
      agg.timings.mmd_bootstrap_ns += reply.result.timings.mmd_bootstrap_ns;
      agg.timings.mmd_bootstrap_skipped_cells += reply.result.timings.mmd_bootstrap_skipped_cells;
      agg.timings.mcd_skipped_low_variance_cells += reply.result.timings.mcd_skipped_low_variance_cells;
      for (const d of reply.result.diagnostics.d6b_cells) agg.d6b_cells.push(d);
      return reply.result.result;
    }
    return buildFamilyCPerCell(rows, opts, key, mmdAlpha, agg);
  };
}

/** Pass 3 — stitch cellResults into entry.family_C. Addition #23 D3 per-tier
 *  covariance sample-size fallback applies here. Mirrors the pre-split inline
 *  loop exactly. */
function stitchPass3(
  pendingBuildTasks: PendingBuildTask[],
  cellResults: Array<FamilyCPerCell | null>,
  cellEntries: BaselineCellEntry[],
  aggregateFamilyC: FamilyCPerCell | undefined,
  mcdFloor: number,
  familyCSignals: readonly string[],
): void {
  for (let i = 0; i < pendingBuildTasks.length; i++) {
    const task = pendingBuildTasks[i];
    const cell = cellResults[i];
    const entry = cellEntries[task.entryIdx];
    const useAggregateFallback =
      task.tier !== 'aggregate' && aggregateFamilyC &&
      (cell === null || task.n_samples < mcdFloor);
    if (useAggregateFallback && aggregateFamilyC) {
      stitchAggregateFallback(entry, task, aggregateFamilyC, familyCSignals);
    } else if (cell) {
      stitchPerCellCalibration(entry, cell, familyCSignals);
    }
  }
}

/** Final assembly — build aggregate per-signal Family A, the
 *  aggregate_fallback block, dimensions, and the returned
 *  BaselineCellsConfig. Mirrors the pre-split tail exactly. */
function assembleBaselineCellsConfig(
  cellEntries: BaselineCellEntry[],
  familyASignals: readonly string[],
  aggregateSamples: Record<string, number[]>,
  aggregateFamilyC: FamilyCPerCell | undefined,
  agg: CompileAggregator,
  compilerOpts: CompilerOptions,
  twoD: boolean,
  tenantTierMap: Record<string, TenantTier> | null,
): BaselineCellsConfig {
  const aggregatePerSignal: Record<string, FamilyAPerSignalParams> = {};
  for (const signal of familyASignals) {
    const cls = resolveSignalClass(signal, compilerOpts.signal_classes);
    aggregatePerSignal[signal] = buildFamilyAPerSignal(
      aggregateSamples[signal], agg, cls);
  }
  const aggregateFallback: BaselineCellsConfig['aggregate_fallback'] = {
    family_A: { per_signal: aggregatePerSignal },
  };
  if (aggregateFamilyC) aggregateFallback.family_C = aggregateFamilyC;

  const dimensions: BaselineCellsConfig['dimensions'] =
    twoD ? ['hour_of_day', 'day_of_week'] : ['hour_of_day'];
  if (tenantTierMap) dimensions.push('tenant_tier');

  return {
    dimensions,
    cells: cellEntries,
    aggregate_fallback: aggregateFallback,
  };
}
