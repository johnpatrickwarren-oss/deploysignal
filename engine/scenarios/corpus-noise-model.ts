// engine/scenarios/corpus-noise-model.ts — consumer API for the derived corpus
// noise model (C30, studies/corpus-noise-v2).
//
// The incumbent model in slow_burn.ts is `v = mean × (1 + c·U[0,1])` with invented
// constants. This module exposes what could actually be sourced from the real trace
// bundles in runs/baselines/, and — the point of the exercise — refuses to supply
// anything that could not.
//
// A consumer asking for a signal whose parameters are CANNOT-BE-SOURCED gets a
// thrown error naming the admissibility criterion, not a default. That is deliberate:
// a silent fallback is how invented constants enter a study in the first place.
//
//   import { noiseModel, samplerFor, cannotBeSourced } from './corpus-noise-model';
//
//   const sample = samplerFor('cost_req', 42);   // seeded; deterministic
//   const v = baseline * sample();               // multiplicative, per tick
//
//   samplerFor('p99_latency', 42);               // throws: A1, no source exists

import model from './corpus-noise-model.json';

export type ParameterGroup = 'marginal' | 'serial' | 'periodic';

export interface CannotBeSourced {
  status: 'cannot_be_sourced';
  criterion: string;
  reason: string;
  what_would_be_needed: string;
}

export interface SourcedMarginal {
  status: 'sourced';
  cv: number;
  family: 'empirical' | 'uniform' | 'gamma' | 'lognormal';
  family_params: Record<string, number> | null;
  /** 101-point quantile grid of the standardized residual, present iff family === 'empirical'. */
  empirical_quantiles_z: number[] | null;
  ks_distances: Record<string, number | null>;
  best_parametric: string;
  best_parametric_ks: number;
  sample_skewness: number;
  n: number;
  /** The invented constant this replaces, where one existed. */
  incumbent_cv: number | null;
  source: string;
}

/** AR(1) was fitted but the pre-registered adequacy check rejected it (§4 S.3). */
export interface Ar1Inadequate {
  status: 'ar1_inadequate';
  criterion: string;
  reason: string;
  phi_not_published: number;
  acf_lags_2_5: { lag: number; rho: number; pairs: number }[];
  source: string;
}

type MarginalRecord = SourcedMarginal | CannotBeSourced;
type SerialRecord = CannotBeSourced | Ar1Inadequate | { status: 'sourced'; phi: number; source: string };
type PeriodicRecord = CannotBeSourced | { status: 'sourced'; source: string };

export interface SignalRecord {
  marginal: MarginalRecord;
  serial: SerialRecord;
  periodic: PeriodicRecord;
  provenance: Record<string, unknown> | null;
}

export interface NoiseModel {
  $schema_version: number;
  name: string;
  version: number;
  derived_by: string;
  preregistration: string;
  run: string;
  tick_seconds: number;
  frame: string;
  incumbent_model: Record<string, unknown>;
  signals: Record<string, SignalRecord>;
}

export const noiseModel = model as unknown as NoiseModel;

/** Every signal the artifact carries a record for. */
export function signals(): string[] {
  return Object.keys(noiseModel.signals);
}

/** The record for one signal. Throws if the artifact has no entry at all. */
export function recordFor(signal: string): SignalRecord {
  const rec = noiseModel.signals[signal];
  if (!rec) throw new Error(`corpus-noise-model: no record for signal '${signal}'`);
  return rec;
}

/** True iff this parameter group could not be sourced for this signal. */
export function cannotBeSourced(signal: string, group: ParameterGroup): boolean {
  return recordFor(signal)[group].status !== 'sourced';
}

/**
 * Assert a group is usable, or throw with the criterion and what would lift it.
 * Call this rather than reading `.status` by hand — the error text is the finding.
 */
export function assertSourced(signal: string, group: ParameterGroup): void {
  const g = recordFor(signal)[group] as Record<string, unknown>;
  if (g.status === 'sourced') return;
  const criterion = (g.criterion as string) ?? g.status;
  const reason = (g.reason as string) ?? '(no reason recorded)';
  const needed = (g.what_would_be_needed as string) ?? '';
  throw new Error(
    `corpus-noise-model: ${signal}.${group} is not sourced [${criterion}]. ${reason}`
    + (needed ? ` To lift this: ${needed}.` : '')
    + ' Do not substitute a default — see studies/corpus-noise-v2/REPORT.md.',
  );
}

/** mulberry32 — the calibrators' own PRNG primitive; deterministic from a seed. */
function mulberry32(a: number): () => number {
  return function next(): number {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear interpolation into the 101-point standardized quantile grid. */
function empiricalQuantile(grid: number[], u: number): number {
  const x = Math.min(1, Math.max(0, u)) * (grid.length - 1);
  const lo = Math.floor(x), hi = Math.ceil(x);
  return lo === hi ? grid[lo] : grid[lo] + (grid[hi] - grid[lo]) * (x - lo);
}

/**
 * A seeded multiplicative noise sampler for one signal: each call returns a factor
 * to multiply a per-cell baseline mean by, so `v_t = mean × sampler()`.
 *
 * iid by construction. The serial structure is NOT applied, because for the one
 * signal with a real source AR(1) was rejected by the pre-registered adequacy check
 * — see REPORT.md §4. A consumer that needs serial dependence must not get it from
 * here; `assertSourced(signal, 'serial')` will throw and say so.
 *
 * Throws if the marginal could not be sourced.
 */
export function samplerFor(signal: string, seed: number): () => number {
  assertSourced(signal, 'marginal');
  const m = recordFor(signal).marginal as SourcedMarginal;
  const rng = mulberry32(seed);
  if (m.family === 'empirical') {
    const grid = m.empirical_quantiles_z;
    if (!grid) throw new Error(`corpus-noise-model: ${signal} claims family 'empirical' with no quantile grid`);
    return () => 1 + m.cv * empiricalQuantile(grid, rng());
  }
  if (m.family === 'uniform') {
    const lo = m.family_params?.lo ?? -Math.sqrt(3);
    const hi = m.family_params?.hi ?? Math.sqrt(3);
    return () => 1 + m.cv * (lo + (hi - lo) * rng());
  }
  throw new Error(
    `corpus-noise-model: no sampler implemented for family '${m.family}' on ${signal}. `
    + 'Only families the derivation actually selected are implemented.',
  );
}

/** The signals whose marginal is sourced — what a sweep can legitimately drive. */
export function sourcedSignals(): string[] {
  return signals().filter((s) => !cannotBeSourced(s, 'marginal'));
}
