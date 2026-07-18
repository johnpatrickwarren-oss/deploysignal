// engine/types/_config-baseline-bundle.ts — baseline bundle / cell shapes,
// bake profiles, and regression-profile types. Split out of the
// engine/types/config.ts god-file; re-exported verbatim from there to
// preserve the facade export surface.

import type { CellKey } from './primitives';
import type { FamilyAPerSignalParams } from './families/a';
import type { FamilyCPerCell } from './families/c';
import type { FamilyDPerSignal } from './families/d';
import type { ConformalParams } from './families/e';
import type { BaselineProvenance } from './_config-compiled';

/** REPLY-51b R4-2 — fast-path metadata read from the baseline bundle
 *  manifest without materializing samples. Consumed by the profile-
 *  dispatch layer to reconcile profile-requested cell dimensions
 *  against what the baseline actually supports (three-case per
 *  REPLY-51a D4). */
export interface BundleMetadata {
  /** Which cell-matrix dimensions the baseline carries enough
   *  metadata to emit along. hour_of_day is always true for any
   *  well-formed bundle (cell_dim !== null). day_of_week true when
   *  cell_dim === 'hour_of_day_x_day_of_week'. tenant_tier true
   *  when manifest.tenants > 1 (or bundle carries per-run tenant_id).
   *  workload_class + region currently always false (no manifest
   *  support; post-phase additions). */
  available_dimensions: {
    hour_of_day: boolean;
    day_of_week: boolean;
    workload_class: boolean;
    tenant_tier: boolean;
    region: boolean;
  };
  /** Total sample count (for diagnostic + audit); sum of
   *  n_runs × ticks_per_run from the manifest. */
  sample_count: number;
  /** Temporal span in days covered by the bundle. When not
   *  explicitly stamped on the manifest, defaults to 0 (reader
   *  treats 0 as "unknown"). */
  temporal_span_days: number;
  /** Matches manifest.version / bundle.version (e.g., `'synthetic-v1'`). */
  source_id: string;
  /** Bundle-generator version stamp for audit provenance.
   *  Defaults to `source_id` when the manifest doesn't expose a
   *  distinct ingestion-tool version. */
  ingestion_version: string;
}

// ── REPLY-52 regression-profile types ────────────────────────────────
//
// Hand-curated regression profiles per §D4 — used by
// tools/inject-regression.ts to mutate baseline sample series at a
// chosen T_inject tick for shadow-compare validation. v1 profiles
// derived from public postmortems; no ML inference on postmortem
// narratives per architect anti-scope.

/** Delta-scale discriminator per REPLY-52 D4 architect refinement.
 *  Profile authors declare intent explicitly; no default. */
export type RegressionDeltaKind =
  | 'absolute'
  | 'relative_to_baseline_sigma'
  | 'relative_to_baseline_mean';

export interface RegressionInjectionPoint {
  /** Ticks after T_inject at which this delta activates. Step-
   *  function semantic: latest applicable offset wins. */
  tick_offset: number;
  signal: string;
  delta_kind: RegressionDeltaKind;
  /** Signed magnitude. Units depend on `delta_kind`. */
  delta: number;
}

export interface RegressionProfile {
  id: string;
  source: string;
  duration_minutes: number;
  affected_signals: string[];
  injection_points: RegressionInjectionPoint[];
  expected_detection: {
    family: 'A' | 'B' | 'C' | 'D' | 'E';
    signal?: string;
    notes?: string;
  };
}

/** Healthy-baseline input to the compiler. `signal_series` is a per-signal
 * array of tick values, all arrays the same length within a run.
 *
 * Week 2: adds optional `cell_dim` and per-run `hour_of_day[]` so the
 * compiler can slice the baseline by context cell. `cell_dim` is absent on
 * Week-1 bundles; consumers must treat absence as "no cell structure". */
export interface BaselineBundle {
  version: string;
  generated_at: string;
  seed: number;
  /** Week 2 PM-critique item 2: 'hour_of_day'. W3 ARCHITECT-REPLY-09.md:
   *  extends to 'hour_of_day_x_day_of_week'. When 2-D, each run carries a
   *  `day_of_week[]` array alongside `hour_of_day[]`. */
  cell_dim?: 'hour_of_day' | 'hour_of_day_x_day_of_week';
  /** R2 Task 2 (refresh window selection) — uniform tick duration in
   *  seconds, from `manifest.tick_seconds`. Absent on every checked-in
   *  bundle today (no manifest carries it, plan §A.3); additive. A
   *  bundle is "timestamped" iff this field is present AND every run
   *  has `start_iso` — tick `t` of a run then occupies instant
   *  `start_iso + t * tick_seconds`; membership tests use the tick's
   *  start instant against half-open `[start, end)` windows. Mixed
   *  presence (this set but some run lacks `start_iso`, or vice versa)
   *  is an error at selection time, not at load time. */
  tick_seconds?: number;
  /** R2 Task 2 — baseline provenance carried from `manifest.
   *  baseline_provenance` (real-bundle manifests already carry it;
   *  synthetic bundles omit it). Additive; threaded through by
   *  `loadBundle` for D10 honest-stamping consumption. */
  baseline_provenance?: BaselineProvenance;
  runs: Array<{
    tenant_id?: string;
    signal_series: Record<string, number[]>;
    /** Hour-of-day label per tick (0..23). Present iff `cell_dim` is set. */
    hour_of_day?: number[];
    /** Day-of-week label per tick (0..6, Sun=0). Present iff
     *  `cell_dim === 'hour_of_day_x_day_of_week'`. */
    day_of_week?: number[];
    /** R2 Task 2 — ISO-8601 UTC instant of the run's tick 0. Present iff
     *  the source bundle.jsonl row carries it (comes along for free
     *  since rows are parsed verbatim by `loadBundle`); absent on
     *  every non-timestamped bundle. */
    start_iso?: string;
  }>;
}

// ── Baseline cells + detector types ──────────────────────────────
// Week 2 scaffolded Family A on a flat `family_A.cells[hour]` map;
// Week 3 (ARCHITECT-REPLY-09.md Q1) migrates that into a unified
// `baseline_cells` matrix and adds Family C per-cell covariance.

/** One cell in the `baseline_cells.cells` array. */
export interface BaselineCellEntry {
  key: CellKey;
  n_samples: number;
  confidence: 'strict' | 'pooled' | 'aggregate' | 'none';
  /** Populated iff `confidence === 'pooled'`; lists the adjacent cells
   *  whose samples were combined to hit `min_samples_pooled`. */
  pooled_from?: CellKey[];
  /** True when pooling inflated the effective variance; Reviewer X4
   *  signals this so L3 fusion can widen thresholds conservatively. */
  variance_inflated?: boolean;
  family_A?: { per_signal: Record<string, FamilyAPerSignalParams> };
  family_C?: FamilyCPerCell;
  /** Week 4: per-cell conformal calibration for Family E novelty detection. */
  family_E?: ConformalParams;
  /** Week 4: per-cell spectral null distribution for Family D ACF peaks.
   *  Keyed by signal because ACF is per-signal. */
  family_D?: Record<string, FamilyDPerSignal>;
}

export interface BaselineCellsConfig {
  dimensions: Array<'hour_of_day' | 'day_of_week' | 'workload_class' | 'tenant_slice' | 'tenant_tier' | 'region'>;
  cells: BaselineCellEntry[];
  aggregate_fallback: {
    family_A?: { per_signal: Record<string, FamilyAPerSignalParams> };
    family_C?: FamilyCPerCell;
    family_E?: ConformalParams;
    family_D?: Record<string, FamilyDPerSignal>;
  };
}

/** Signal-level bake profile per Addition #4. Not cell-varying — all cells
 *  for a given signal share the same profile; diurnal time-to-stability
 *  variation is encoded in per-cell `baseline_sigma_squared` instead. */
export interface BakeProfile {
  min_ticks_before_eligible: number;
  min_observation_window: number;
  max_deploy_window_days: number;
}
