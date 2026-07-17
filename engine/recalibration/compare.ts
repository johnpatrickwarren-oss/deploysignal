// engine/recalibration/compare.ts — Addition #15 baseline-maintenance
// lifecycle. Candidate-vs-active CompiledConfig comparison: signal-mean
// extraction, per-signal delta report + predicted false-positive
// behavior, and the pre-shadow readiness gates a candidate must clear
// before it's allowed into pending_shadow (plan §C Task 4).
//
// D6 (engine/tools split): pure, no fs, no I/O.
//
// *** AGGREGATE-ONLY LIMITATION (Tasks 3-5 review addition; load-bearing,
// *** read before touching classification/comparison call sites) ***
// `extractSignalMeans` below reads `baseline_cells.aggregate_fallback`
// ONLY. It never touches `baseline_cells.cells[]` (the per-cell
// family_A/family_C params keyed by hour_of_day / day_of_week / etc).
// The RUNTIME detectors (engine/detectors — Family A betting, Family C
// Hotelling) do the opposite: they consult the matching cell's per-cell
// params FIRST and fall back to `aggregate_fallback` only when a cell
// lacks strict/adequate confidence. So `compareCandidateVsActive` and
// the direction classification built on top of it
// (engine/recalibration/classify.ts) are an AGGREGATE-VIEW
// APPROXIMATION of what the runtime actually evaluates per cell — a
// candidate that looks like an "improvement" in aggregate could still
// diverge from a per-cell view. `ComparisonResult.extraction_basis =
// 'aggregate_fallback_only'` carries this caveat machine-readably onto
// every CandidateRecord.comparison so it survives past the code comment.

import type { CompiledConfig } from '../types';
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
 *  this module's header AGGREGATE-ONLY LIMITATION note. In short:
 *  `BaselineCellsConfig.aggregate_fallback` is a required field on any
 *  compiled config that has `baseline_cells` at all, so it's always the
 *  well-defined single "one set of means per config" view; but it is
 *  NOT what the runtime consults first (per-cell params are), so this is
 *  an approximation, not an equivalence. Per-cell comparison is out of
 *  scope for this addition (which compares whole compiled baselines,
 *  not individual cells).
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
  /** Machine-readable caveat (Tasks 3-5 review addition): this
   *  comparison is built exclusively from `extractSignalMeans`, which
   *  reads `baseline_cells.aggregate_fallback` only. Runtime Family A/C
   *  detectors consult PER-CELL params first, falling back to the
   *  aggregate only when a cell lacks strict/adequate confidence — so
   *  this comparison (and the direction classification derived from it,
   *  engine/recalibration/classify.ts) is an AGGREGATE-VIEW
   *  APPROXIMATION of what the runtime actually evaluates per cell, not
   *  a cell-by-cell equivalence. `'aggregate_fallback_only'` is
   *  currently the module's only extraction basis — the field exists so
   *  the operator-facing CandidateRecord.comparison carries this
   *  limitation machine-readably rather than only in a code comment. */
  extraction_basis: 'aggregate_fallback_only';
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
 *  changed" not "is that change good". */
export function compareCandidateVsActive(
  active: CompiledConfig,
  candidate: CompiledConfig,
): ComparisonResult {
  const activeMeans = extractSignalMeans(active);
  const candidateMeans = extractSignalMeans(candidate);

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
    extraction_basis: 'aggregate_fallback_only',
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
