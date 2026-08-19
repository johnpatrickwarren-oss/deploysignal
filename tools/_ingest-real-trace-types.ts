// tools/_ingest-real-trace-types.ts — shared BundleRun / IngestReport
// types for the real-data schema-map layer (extracted from
// tools/ingest-real-trace.ts; behavior-preserving split).

import type { BaselineProvenance } from '../engine/types';

export interface BundleRun {
  tenant_id: string;
  signal_series: Record<string, number[]>;
  /** C37 (2026-08-18) — non-signal series (e.g. requests_per_tick, the
   *  empty-vs-zero-cost disambiguator). Kept OUTSIDE signal_series because the
   *  family-D calibrator stamps per signal_series key: a counts key placed
   *  there grew its own family_D spectral params on all 840 cells (measured on
   *  the v2 leak check). No calibration path reads this field. */
  auxiliary_series?: Record<string, number[]>;
  hour_of_day?: number[];
  day_of_week?: number[];
}

export interface IngestReport {
  source: BaselineProvenance;
  n_runs: number;
  n_ticks_total: number;
  signals_populated: string[];
  /** Structured log of caveat-driven filters applied (per D2). */
  filters_applied: string[];
}
