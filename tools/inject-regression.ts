// tools/inject-regression.ts — REPLY-52 D4 regression harness.
//
// Pure function that mutates a baseline sample series (per-signal
// number[][] across runs) by applying a RegressionProfile at a
// chosen T_inject tick. No I/O; no dependency on DS engine. Used
// by shadow-compare tests (D5) + report-card builder (D6).
//
// Design invariants:
//   - Pre-T_inject ticks are NEVER mutated (regression starts at
//     T_inject; baseline noise stays intact before injection).
//   - Step-function semantic for `tick_offset`: at any tick t ≥
//     T_inject, the applicable delta for each signal is the one
//     with the largest `tick_offset ≤ (t − T_inject)` in the
//     profile's `injection_points`. Between offsets the delta is
//     constant (step; not linear ramp).
//   - delta_kind dispatch (architect D4 refinement):
//       absolute: v' = v + delta (native units).
//       relative_to_baseline_sigma: v' = v + delta × σ_baseline.
//       relative_to_baseline_mean: v' = v + delta × μ_baseline.
//   - σ / μ are computed from the pre-injection window
//     (ticks 0..T_inject − 1) per signal per run. Post-injection
//     stats would leak regression noise into the reference shape.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import type {
  RegressionProfile, RegressionInjectionPoint, RegressionDeltaKind,
} from '../engine/types';
import { validateAgainstSchema } from '../advisory/agent/schema-validator';
import type { SchemaNode } from '../advisory/agent/schema-validator';

// ── Profile loading + validation ────────────────────────────────────

let _schemaCache: SchemaNode | null = null;
function regressionProfileSchema(): SchemaNode {
  if (_schemaCache) return _schemaCache;
  const schemaPath = path.join(
    _repoRoot(), 'regression-profiles', 'schema', 'regression-profile.schema.json',
  );
  _schemaCache = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as SchemaNode;
  return _schemaCache;
}

function _repoRoot(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found from tools/inject-regression.ts');
}

export function loadRegressionProfile(profileId: string): RegressionProfile {
  const file = path.join(
    _repoRoot(), 'regression-profiles', `${profileId}.yaml`,
  );
  if (!fs.existsSync(file)) {
    throw new Error(`regression profile "${profileId}" not found at ${file}`);
  }
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) as unknown;
  const result = validateAgainstSchema(raw, regressionProfileSchema());
  if (!result.valid) {
    throw new Error(
      `regression profile "${profileId}" failed schema validation:\n  `
      + result.errors.join('\n  '),
    );
  }
  const parsed = raw as RegressionProfile;
  if (parsed.id !== profileId) {
    throw new Error(
      `regression profile file ${file} has id="${parsed.id}"; expected "${profileId}"`,
    );
  }
  return parsed;
}

export function loadAllRegressionProfiles(): RegressionProfile[] {
  const dir = path.join(_repoRoot(), 'regression-profiles');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  return files.map((f) => loadRegressionProfile(f.replace(/\.yaml$/, '')));
}

// ── Injection ───────────────────────────────────────────────────────

export interface SignalSeriesPerRun {
  /** Per-signal float arrays; every signal array has the same
   *  length (ticks_per_run). */
  signal_series: Record<string, number[]>;
  /** Parallel tick-indexed arrays from the bundle (optional; the
   *  injector doesn't read them — caller passes through). */
  [key: string]: unknown;
}

/** Find the applicable step delta for `signal` at a given
 *  `tick_after_inject` (≥ 0). Returns `null` when the profile has
 *  no injection point active at this tick for this signal.
 *  Step semantic: among all points matching the signal with
 *  `tick_offset ≤ tick_after_inject`, the one with the max
 *  `tick_offset` wins. */
function _applicableDelta(
  profile: RegressionProfile,
  signal: string,
  tickAfterInject: number,
): RegressionInjectionPoint | null {
  let best: RegressionInjectionPoint | null = null;
  for (const pt of profile.injection_points) {
    if (pt.signal !== signal) continue;
    if (pt.tick_offset > tickAfterInject) continue;
    if (best === null || pt.tick_offset > best.tick_offset) best = pt;
  }
  return best;
}

/** Apply a single delta to a baseline value per `delta_kind`. */
export function applyDelta(
  baselineValue: number,
  delta: number,
  kind: RegressionDeltaKind,
  baselineMean: number,
  baselineSigma: number,
): number {
  switch (kind) {
    case 'absolute':
      return baselineValue + delta;
    case 'relative_to_baseline_sigma':
      return baselineValue + delta * baselineSigma;
    case 'relative_to_baseline_mean':
      return baselineValue + delta * baselineMean;
  }
}

/** Compute mean + std (population sigma; N not N-1) over a numeric
 *  slice. Returns {mean: 0, sigma: 0} on empty input — harmless
 *  for delta_kind='absolute' (sigma ignored), and signals the
 *  injector that σ-scaled deltas can't apply to a pre-tick-0 window. */
function _meanSigma(values: number[]): { mean: number; sigma: number } {
  if (values.length === 0) return { mean: 0, sigma: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) { const d = v - mean; sq += d * d; }
  return { mean, sigma: Math.sqrt(sq / values.length) };
}

export interface InjectReport {
  profile_id: string;
  injection_tick: number;
  affected_signals: string[];
  /** Per-signal summary of the first + final applied delta (absolute
   *  value after kind-dispatch). Useful for test assertions + report-
   *  card cells. */
  per_signal_stats: Record<string, {
    baseline_mean: number;
    baseline_sigma: number;
    first_applied_delta: number;
    final_applied_delta: number;
  }>;
}

/** Inject a regression into a per-run signal_series in-place (caller
 *  should clone if they want the original preserved). Returns a
 *  report suitable for test assertions + report-card summary.
 *  Applies only to signals listed in `profile.affected_signals`;
 *  other signals left untouched. */
export function injectRegression(
  run: SignalSeriesPerRun,
  profile: RegressionProfile,
  injectionTick: number,
): InjectReport {
  const report: InjectReport = {
    profile_id: profile.id,
    injection_tick: injectionTick,
    affected_signals: profile.affected_signals.slice(),
    per_signal_stats: {},
  };

  for (const signal of profile.affected_signals) {
    const series = run.signal_series[signal];
    if (!series) continue; // Signal not present on this run; skip.
    const ticks = series.length;
    if (injectionTick >= ticks) continue; // Nothing to mutate.

    // Baseline stats from the pre-injection window.
    const baseline = series.slice(0, injectionTick);
    const { mean, sigma } = _meanSigma(baseline);

    let firstApplied: number | null = null;
    let lastApplied = 0;
    for (let t = injectionTick; t < ticks; t++) {
      const tAfter = t - injectionTick;
      const pt = _applicableDelta(profile, signal, tAfter);
      if (!pt) continue;
      const before = series[t];
      const after = applyDelta(before, pt.delta, pt.delta_kind, mean, sigma);
      series[t] = after;
      const applied = after - before;
      if (firstApplied === null) firstApplied = applied;
      lastApplied = applied;
    }
    report.per_signal_stats[signal] = {
      baseline_mean: mean,
      baseline_sigma: sigma,
      first_applied_delta: firstApplied ?? 0,
      final_applied_delta: lastApplied,
    };
  }

  return report;
}
