// test/_c64-fixture.ts — shared fixture for the C64 (a)/(b) tests: every Family A signal is
// drawn from the compiled cell's own law (hour 20, day 3 of runs/compiled-configs/
// v2-with-family-a.json), so an unshifted signal is healthy BY CONSTRUCTION for the plug-ins
// and the calibration series is exactly null for safe-t. Seeded (mulberry32 + Box–Muller);
// no Math.random.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompiledConfig, Metrics } from '../dist/engine/types';

export const ROOT = path.resolve(__dirname, '..');
export const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v2-with-family-a.json');
export const HOUR = 20, DAY = 3;
export const SIGNALS = ['p99_latency', 'ttft', 'eval_score', 'tool_success_rate', 'downstream_err', 'cost_req'] as const;
export type Signal = typeof SIGNALS[number];

export function loadCfg(): CompiledConfig { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }

/** Per-signal (mean, sigma) of the compiled cell the tests evaluate against. */
export function cellLaw(cfg: CompiledConfig): Record<Signal, { mean: number; sigma: number }> {
  const cell = cfg.baseline_cells!.cells.find((c) => c.key.hour_of_day === HOUR && c.key.day_of_week === DAY)!;
  const out = {} as Record<Signal, { mean: number; sigma: number }>;
  for (const s of SIGNALS) {
    const p = cell.family_A!.per_signal[s]!;
    out[s] = { mean: p.baseline_mean, sigma: Math.sqrt(p.baseline_sigma_squared) };
  }
  return out;
}

export function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(seed: number): () => number {
  const r = mulberry32(seed);
  return () => {
    let u = 0; do { u = r(); } while (u <= 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
}

/** n draws from the signal's cell law, plus `shiftSigma` cell sigmas from index `shiftAfter`. */
export function cellSeries(law: { mean: number; sigma: number }, seed: number, n: number, shiftAfter = Infinity, shiftSigma = 0): number[] {
  const g = gauss(seed);
  return Array.from({ length: n }, (_, t) => law.mean + law.sigma * g() + (t >= shiftAfter ? shiftSigma * law.sigma : 0));
}

/** A full canary: per-signal series (seeded per signal), `shifted` signals stepped from tick 30. */
export function canary(cfg: CompiledConfig, seed: number, T: number, shifted: ReadonlyArray<Signal>, shiftSigma: number): Record<Signal, number[]> {
  const law = cellLaw(cfg);
  const out = {} as Record<Signal, number[]>;
  SIGNALS.forEach((s, k) => { out[s] = cellSeries(law[s], seed * 100 + k, T, shifted.includes(s) ? 30 : Infinity, shiftSigma); });
  return out;
}

/** Calibration series per signal from the same law (seeded apart from every canary). */
export function calibration(cfg: CompiledConfig, n = 500): Record<Signal, number[]> {
  const law = cellLaw(cfg);
  const out = {} as Record<Signal, number[]>;
  SIGNALS.forEach((s, k) => { out[s] = cellSeries(law[s], 7000 + k, n); });
  return out;
}

/** Scenario baseline = the cell means (ratio rules read ≈ 1 on healthy draws). */
export function scenarioBaseline(cfg: CompiledConfig): Record<string, number> {
  const law = cellLaw(cfg);
  const b: Record<string, number> = { tokens_turn: 418, kv_cache: 0.89, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0 };
  for (const s of SIGNALS) b[s] = law[s].mean;
  return b;
}
export function metricsAt(cfg: CompiledConfig, traj: Record<Signal, number[]>, i: number): Metrics {
  const m: Record<string, number> = { ...scenarioBaseline(cfg) };
  for (const s of SIGNALS) m[s] = traj[s][i];
  return m as unknown as Metrics;
}
export const FLAGS = { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true };
export const POLICY_CTX = { thresholds: {}, warmup: { active: false, suppressedIds: [], grace: false, pct: 100 } };
export function scenarioFor(cfg: CompiledConfig) {
  return { id: 'c64', riskLevel: 'critical', bakeHours: 84, author: 'human', changeType: 'model_weights', timeWindow: 'ok', flags: FLAGS, baseline: scenarioBaseline(cfg) };
}
