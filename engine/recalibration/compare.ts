// engine/recalibration/compare.ts — Addition #15 baseline-maintenance
// lifecycle. Candidate-vs-active CompiledConfig comparison: signal-mean
// extraction, per-signal delta report + predicted false-positive
// behavior, and the pre-shadow readiness gates a candidate must clear
// before it's allowed into pending_shadow (plan §C Task 4).
//
// D6 (engine/tools split): pure, no fs, no I/O.
//
// *** PER-CELL-WEIGHTED EXTRACTION (follow-up to the Tasks 3-5
// *** aggregate-only review finding; load-bearing, read before touching
// *** classification/comparison call sites) ***
// `extractSignalMeansPerCellWeighted` is the default extraction used by
// `compareCandidateVsActive` (and by tools/recalibrate/_recalibrate-
// candidate.ts's classification call site). For each signal it averages
// every `baseline_cells.cells[]` entry's own per-cell value, weighted by
// the cell's `n_samples`, mirroring what the RUNTIME detectors
// (engine/detectors — Family A betting/Page-CUSUM, Family C Hotelling)
// actually consult: a cell whose `confidence` is `'strict'` or
// `'pooled'` contributes ITS OWN per-cell value; a cell whose
// `confidence` is `'aggregate'` or `'none'` contributes
// `aggregate_fallback`'s value instead — exactly the substitution
// `engine/detectors/_page-cusum-params.ts`'s `buildMSPRTParams`
// (lines ~57-68) makes at runtime. A cell that lacks per-cell data for a
// signal entirely (legacy/malformed) contributes nothing, again matching
// runtime (no MSPRT params -> no evaluation for that cell/signal).
// Weighting is by `n_samples` because that's the field
// `BaselineCellEntry` actually carries for per-cell sample counts (no
// separate "n" field exists); if a future cell shape ever lacks
// `n_samples`, `weightedMean` below falls back to an unweighted mean of
// the populated per-cell values rather than throwing.
//
// This is STILL a summary statistic, not a cell-by-cell equivalence:
// averaging per-cell values (even weighted) can hide divergence where
// some cells moved one way and others moved the opposite way — the
// direction classification built on top of it
// (engine/recalibration/classify.ts) remains an APPROXIMATION of what
// the runtime evaluates per cell at serve time, just a materially
// tighter one than the old aggregate-only extraction (which ignored
// `cells[]` completely). Shadow validation (the actual per-scenario
// replay gate) remains the empirical backstop this approximation can't
// replace. `ComparisonResult.extraction_basis` records which extraction
// actually ran — `'per_cell_weighted'` when at least one config carried
// real per-cell data to weight, `'aggregate_fallback_only'` when neither
// active nor candidate had any (pre-Week-3 legacy configs, or configs
// whose cells are all bare key/n_samples/confidence with no family
// blocks) — so the CandidateRecord.comparison this lands on carries the
// caveat machine-readably rather than only in this code comment. The
// old `extractSignalMeans` (aggregate_fallback-only) stays exported for
// callers that explicitly want the pre-fix aggregate view.

import type { BaselineCellEntry, CompiledConfig } from '../types';
import { FAMILY_C_SIGNALS } from '../detectors/hotelling';
import { DRIFT_SAMPLE_WINDOW_MAX } from '../drift/baseline-drift-detector';
import { relativeDelta } from './classify';

/** Extract a flat signal -> mean map from a CompiledConfig's aggregate
 *  (cell-independent) baseline block: the union of Family A's
 *  per-signal `baseline_mean` and Family C's `mean_vector` (indexed by
 *  `cfg.family_c_signals`, falling back to the hardcoded FAMILY_C_SIGNALS
 *  order the same way the runtime Hotelling detector does).
 *
 *  Reads `aggregate_fallback` specifically, not per-cell entries — see
 *  this module's header PER-CELL-WEIGHTED EXTRACTION note.
 *  `BaselineCellsConfig.aggregate_fallback` is a required field on any
 *  compiled config that has `baseline_cells` at all, so it's always the
 *  well-defined single "one set of means per config" view; but it is
 *  NOT what the runtime consults first (per-cell params are), so this is
 *  an approximation, not an equivalence. Kept as the fallback tail of
 *  `extractSignalMeansPerCellWeighted` (the default extraction used by
 *  `compareCandidateVsActive`) and exported standalone for callers that
 *  want the pre-fix aggregate-only view explicitly.
 *
 *  On overlap between Family A and Family C for the same signal (e.g.
 *  p99_latency, ttft, downstream_err, cost_req), Family C's value wins
 *  — per Q2.B.4 coherence, both should already agree in raw space to
 *  near float precision, but Family C's mean_vector is the multivariate
 *  joint-calibration source of truth for cross-family-covered signals.
 *
 *  Returns `{}` when the config has no `baseline_cells` at all
 *  (pre-Week-3 legacy configs) — nothing to compare. */
export function extractSignalMeans(cfg: CompiledConfig): Record<string, number> {
  const means: Record<string, number> = {};
  const agg = cfg.baseline_cells?.aggregate_fallback;
  if (!agg) return means;

  if (agg.family_A) {
    for (const [signal, params] of Object.entries(agg.family_A.per_signal)) {
      means[signal] = params.baseline_mean;
    }
  }
  if (agg.family_C) {
    const order = cfg.family_c_signals ?? FAMILY_C_SIGNALS;
    agg.family_C.mean_vector.forEach((value, idx) => {
      const signal = order[idx];
      if (signal !== undefined) means[signal] = value;
    });
  }
  return means;
}

/** One cell's contribution to a signal's weighted mean: the value it
 *  contributes (either its own per-cell value, or the aggregate value
 *  when the cell's confidence routes it there) plus the weight
 *  (`n_samples`) it contributes with. */
interface CellContribution {
  value: number;
  weight: number;
}

/** Sample-count-weighted mean over a signal's per-cell contributions.
 *  Falls back to an unweighted mean when every contribution carries
 *  zero (or negative) weight — defensive: `BaselineCellEntry.n_samples`
 *  is a required field today, but a hand-built/legacy cell with
 *  `n_samples: 0` shouldn't make the whole signal's mean divide-by-zero
 *  to NaN when there's a perfectly good unweighted mean available.
 *  Returns `undefined` when there are no contributions at all. */
function weightedMean(contributions: CellContribution[]): number | undefined {
  if (contributions.length === 0) return undefined;
  const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight <= 0) {
    return contributions.reduce((sum, c) => sum + c.value, 0) / contributions.length;
  }
  return contributions.reduce((sum, c) => sum + c.value * c.weight, 0) / totalWeight;
}

/** True when `cfg` carries at least one `baseline_cells.cells[]` entry
 *  with real per-cell Family A or Family C data under `'strict'` or
 *  `'pooled'` confidence — i.e. at least one cell the runtime would
 *  actually consult for ITS OWN params rather than routing straight to
 *  `aggregate_fallback`. Configs whose cells are all bare
 *  key/n_samples/confidence (no `family_A`/`family_C` blocks — the
 *  shape recalibration's own unit-test fixtures use) or all
 *  `'aggregate'`/`'none'` confidence report `false` here: for those,
 *  `extractSignalMeansPerCellWeighted` degenerates to exactly
 *  `extractSignalMeans`'s aggregate-only values, so `extraction_basis`
 *  should say so honestly rather than claim a per-cell computation that
 *  had nothing but the aggregate to work with. */
function hasPerCellSignalData(cfg: CompiledConfig): boolean {
  const cells = cfg.baseline_cells?.cells;
  if (!cells) return false;
  return cells.some((cell) => {
    if (cell.confidence === 'aggregate' || cell.confidence === 'none') return false;
    const hasFamilyA = !!cell.family_A && Object.keys(cell.family_A.per_signal).length > 0;
    const hasFamilyC = !!cell.family_C && cell.family_C.mean_vector.length > 0;
    return hasFamilyA || hasFamilyC;
  });
}

/** One signal's per-cell contributions, shared by the Family A and
 *  Family C branches of `extractSignalMeansPerCellWeighted` below: walk
 *  every cell, routing a `'aggregate'`/`'none'`-confidence cell to
 *  `aggValue` (weighted by ITS OWN `n_samples`, per the runtime
 *  substitution this module mirrors) and any other cell to whatever
 *  `perCellValue` finds on it — `undefined` (no per-cell data for this
 *  signal on this cell) contributes nothing, matching runtime's "no
 *  MSPRT params -> no evaluation" behavior for that cell/signal. */
function contributionsForSignal(
  cells: BaselineCellEntry[],
  aggValue: number,
  perCellValue: (cell: BaselineCellEntry) => number | undefined,
): CellContribution[] {
  const contributions: CellContribution[] = [];
  for (const cell of cells) {
    if (cell.confidence === 'aggregate' || cell.confidence === 'none') {
      contributions.push({ value: aggValue, weight: cell.n_samples });
      continue;
    }
    const value = perCellValue(cell);
    if (value !== undefined) contributions.push({ value, weight: cell.n_samples });
  }
  return contributions;
}

/** Extract a flat signal -> mean map from a CompiledConfig, weighting
 *  each cell's own per-cell value by `n_samples` — see this module's
 *  header PER-CELL-WEIGHTED EXTRACTION note for the full rationale and
 *  the confidence-gating semantics mirrored from
 *  `engine/detectors/_page-cusum-params.ts`'s `buildMSPRTParams`.
 *
 *  Signal universe is still defined by `aggregate_fallback` (same as
 *  `extractSignalMeans`) — a signal has to appear there to be in scope
 *  for comparison at all; per-cell data only refines ITS VALUE, it
 *  doesn't expand which signals are compared. Family C's per-signal
 *  value wins on overlap with Family A, same tie-break as
 *  `extractSignalMeans`.
 *
 *  Falls back to `extractSignalMeans`'s aggregate value for a signal
 *  whenever no cell ends up contributing anything for it (empty
 *  `cells[]`, or every cell lacking that signal's per-cell data) —
 *  including the whole-config case where `baseline_cells` is absent. */
export function extractSignalMeansPerCellWeighted(cfg: CompiledConfig): Record<string, number> {
  const means: Record<string, number> = {};
  const bc = cfg.baseline_cells;
  if (!bc) return means;
  const agg = bc.aggregate_fallback;
  const cells = bc.cells;

  if (agg.family_A) {
    for (const [signal, params] of Object.entries(agg.family_A.per_signal)) {
      const contributions = contributionsForSignal(
        cells, params.baseline_mean, (cell) => cell.family_A?.per_signal[signal]?.baseline_mean,
      );
      means[signal] = weightedMean(contributions) ?? params.baseline_mean;
    }
  }
  if (agg.family_C) {
    const order = cfg.family_c_signals ?? FAMILY_C_SIGNALS;
    agg.family_C.mean_vector.forEach((aggValue, idx) => {
      const signal = order[idx];
      if (signal === undefined) return;
      const contributions = contributionsForSignal(cells, aggValue, (cell) => cell.family_C?.mean_vector[idx]);
      means[signal] = weightedMean(contributions) ?? aggValue;
    });
  }
  return means;
}

export interface SignalDelta {
  active_mean: number;
  candidate_mean: number;
  delta_absolute: number;
  delta_relative: number;
}

/** Predicted effect on Family A's false-positive behavior. A signal's
 *  detectability margin is governed jointly by `delta_min` (minimum
 *  detectable effect the mixture prior is tuned for) and
 *  `baseline_sigma_squared` (noise floor) — both rising means the
 *  detector tolerates a wider band before firing ('looser': fewer false
 *  positives, less sensitive to small drifts); both falling means the
 *  opposite ('tighter'). Any other combination (one up one down, or no
 *  change) is 'unchanged' for that signal. */
export type PredictedFpBehavior = 'looser' | 'tighter' | 'unchanged';

export interface ComparisonResult {
  per_signal_deltas: Record<string, SignalDelta>;
  /** Dominant per-signal fp-behavior verdict across every Family A
   *  signal present on both active and candidate. Ties (including the
   *  zero-Family-A-signals case) resolve to 'unchanged' — the
   *  conservative "nothing conclusively shifted" default. */
  predicted_fp_behavior: PredictedFpBehavior;
  alpha_budget_changed: boolean;
  cells_active: number;
  cells_candidate: number;
  /** Machine-readable extraction-provenance field (Tasks 3-5 review
   *  addition; upgraded by the per-cell-weighted follow-up). This
   *  comparison is built from `extractSignalMeansPerCellWeighted`, which
   *  averages each signal's per-cell values weighted by `n_samples`,
   *  mirroring runtime's per-cell-first / aggregate-fallback confidence
   *  gating (see this module's header PER-CELL-WEIGHTED EXTRACTION
   *  note). `'per_cell_weighted'` means at least one of active/candidate
   *  actually had real per-cell data to weight; `'aggregate_fallback_only'`
   *  means neither did, so the computation degenerated to exactly the
   *  old aggregate-only `extractSignalMeans` values (pre-Week-3 legacy
   *  configs, or configs whose cells carry no family_A/family_C blocks
   *  of their own). Either way, this remains a SUMMARY STATISTIC, not a
   *  cell-by-cell equivalence — the direction classification derived
   *  from it (engine/recalibration/classify.ts) is an APPROXIMATION of
   *  what the runtime evaluates per cell at serve time; shadow
   *  validation is the empirical gate that actually exercises per-cell
   *  behavior. */
  extraction_basis: 'per_cell_weighted' | 'aggregate_fallback_only';
}

function perSignalFpBehavior(
  activeParams: { delta_min: number; baseline_sigma_squared: number } | undefined,
  candidateParams: { delta_min: number; baseline_sigma_squared: number } | undefined,
): PredictedFpBehavior | null {
  if (!activeParams || !candidateParams) return null;
  const deltaMinUp = candidateParams.delta_min > activeParams.delta_min;
  const deltaMinDown = candidateParams.delta_min < activeParams.delta_min;
  const sigmaUp = candidateParams.baseline_sigma_squared > activeParams.baseline_sigma_squared;
  const sigmaDown = candidateParams.baseline_sigma_squared < activeParams.baseline_sigma_squared;
  if (deltaMinUp && sigmaUp) return 'looser';
  if (deltaMinDown && sigmaDown) return 'tighter';
  return 'unchanged';
}

function dominantFpBehavior(verdicts: PredictedFpBehavior[]): PredictedFpBehavior {
  const counts: Record<PredictedFpBehavior, number> = { looser: 0, tighter: 0, unchanged: 0 };
  for (const v of verdicts) counts[v] += 1;
  const ranked = (Object.entries(counts) as Array<[PredictedFpBehavior, number]>)
    .sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] === 0) return 'unchanged';
  if (ranked[1] && ranked[0][1] === ranked[1][1]) return 'unchanged'; // tie -> conservative default
  return ranked[0][0];
}

/** Compare a candidate CompiledConfig against the currently-active one.
 *  Pure numeric report — no verdict/classification here (that's
 *  engine/recalibration/classify.ts, Task 3); this module answers "what
 *  changed" not "is that change good". Uses the per-cell-weighted
 *  extraction by default (see header note); pass configs through
 *  `extractSignalMeans` yourself and diff them manually if the old
 *  aggregate-only view is specifically what's wanted. */
export function compareCandidateVsActive(
  active: CompiledConfig,
  candidate: CompiledConfig,
): ComparisonResult {
  const activeMeans = extractSignalMeansPerCellWeighted(active);
  const candidateMeans = extractSignalMeansPerCellWeighted(candidate);

  const per_signal_deltas: Record<string, SignalDelta> = {};
  for (const signal of Object.keys(activeMeans)) {
    if (!(signal in candidateMeans)) continue;
    const a = activeMeans[signal];
    const c = candidateMeans[signal];
    per_signal_deltas[signal] = {
      active_mean: a,
      candidate_mean: c,
      delta_absolute: c - a,
      delta_relative: relativeDelta(a, c),
    };
  }

  const activeFamilyA = active.baseline_cells?.aggregate_fallback.family_A?.per_signal ?? {};
  const candidateFamilyA = candidate.baseline_cells?.aggregate_fallback.family_A?.per_signal ?? {};
  const fpVerdicts: PredictedFpBehavior[] = [];
  for (const signal of Object.keys(activeFamilyA)) {
    const verdict = perSignalFpBehavior(activeFamilyA[signal], candidateFamilyA[signal]);
    if (verdict !== null) fpVerdicts.push(verdict);
  }

  return {
    per_signal_deltas,
    predicted_fp_behavior: dominantFpBehavior(fpVerdicts),
    alpha_budget_changed: active.alpha_budget.total !== candidate.alpha_budget.total,
    cells_active: active.baseline_cells?.cells.length ?? 0,
    cells_candidate: candidate.baseline_cells?.cells.length ?? 0,
    extraction_basis: (hasPerCellSignalData(active) || hasPerCellSignalData(candidate))
      ? 'per_cell_weighted'
      : 'aggregate_fallback_only',
  };
}

// ── Readiness gates ──────────────────────────────────────────────────

/** Minimal source-window shape the readiness gates need — a subset of
 *  CandidateRecord.source_window (Task 2), kept independent here so
 *  this module doesn't have to import the candidate-record type. */
export interface ReadinessSourceWindow {
  start: string;
  end: string;
  n_samples: number;
}

/** Operator-declared exclusion window (plan §B store layout,
 *  exclusion-windows.json). `reason` / `declared_by` are carried for
 *  the CLI's gate-table rendering but aren't consulted by the gate
 *  logic itself. */
export interface ExclusionWindow {
  start: string;
  end: string;
  reason?: string;
  declared_by?: string;
}

export interface ReadinessGateOptions {
  /** Overrides the OQ-7 default (DRIFT_SAMPLE_WINDOW_MAX = 50). */
  minSourceSamples?: number;
}

export interface ReadinessGateResult {
  compiler_version_compatible: boolean;
  alpha_total_unchanged: boolean;
  signals_comparable: boolean;
  source_window_outside_exclusions: boolean;
  min_source_samples: boolean;
  all_passed: boolean;
}

function majorVersion(semver: string): string {
  return semver.split('.')[0] ?? semver;
}

/** Half-open [start, end) interval overlap — touching endpoints (one
 *  window's `end` equal to the other's `start`) are NOT an overlap.
 *  ISO-8601 UTC timestamps compare correctly lexicographically. */
function windowsOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Pre-shadow readiness gates (plan §C Task 4). A candidate that fails
 *  any gate never reaches pending_shadow — the CLI's `propose` handler
 *  builds a decided/rejected record directly from a failing result
 *  (exit 2), per plan §C Task 8. */
export function evaluateReadinessGates(
  active: CompiledConfig,
  candidate: CompiledConfig,
  sourceWindow: ReadinessSourceWindow,
  exclusions: ExclusionWindow[],
  opts: ReadinessGateOptions = {},
): ReadinessGateResult {
  const compiler_version_compatible = majorVersion(active.compiler_version) === majorVersion(candidate.compiler_version);
  const alpha_total_unchanged = active.alpha_budget.total === candidate.alpha_budget.total;

  const activeSignals = new Set(Object.keys(extractSignalMeans(active)));
  const candidateSignals = Object.keys(extractSignalMeans(candidate));
  const signals_comparable = candidateSignals.some((s) => activeSignals.has(s));

  const source_window_outside_exclusions = !exclusions.some((w) => windowsOverlap(sourceWindow, w));

  const minSourceSamples = opts.minSourceSamples ?? DRIFT_SAMPLE_WINDOW_MAX;
  const min_source_samples = sourceWindow.n_samples >= minSourceSamples;

  const all_passed = compiler_version_compatible
    && alpha_total_unchanged
    && signals_comparable
    && source_window_outside_exclusions
    && min_source_samples;

  return {
    compiler_version_compatible,
    alpha_total_unchanged,
    signals_comparable,
    source_window_outside_exclusions,
    min_source_samples,
    all_passed,
  };
}
