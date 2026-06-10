// engine/core.ts — DeploySignal core infrastructure
// Stable utilities: TrendBuffer, trend helpers, warmup, verdict.
// Never rewritten by the self-improving loop — only signal thresholds in shared.js change.

import type {
  TrendSnapshot,
  TrendBufferI,
  TrendBufferOpts,
  SignalSnapshot,
  WindowSummary,
  WarmupConfig,
  WarmupState,
  ChangeType,
  RiskLevel,
  Scenario,
  HealthResult,
  Verdict,
  FpClassifierConfig,
} from './types';

// ── TrendBuffer ───────────────────────────────────────────────────
// Week-1 NS addition: three parallel ring buffers per signal.
//   data       — medium view (legacy, length `window`, default 10). Detectors
//                read this via get(). Audit writer snapshots it via .data.
//   dataShort  — short view (default length 5).
//   dataLong   — long view (default length 30).
// snapshot(key) returns the multi-scale SignalSnapshot. No detector reads it
// in Week 1; it exists to give later weeks a stable surface.

export interface TrendBufferCtor {
  new (windowSize?: number, opts?: TrendBufferOpts): TrendBufferI;
}

function TrendBufferImpl(this: TrendBufferI, windowSize?: number, opts?: TrendBufferOpts): void {
  this.window = windowSize || 10;
  this.windowShort = (opts && opts.short) || 5;
  this.windowLong  = (opts && opts.long)  || 30;
  this.data        = {};
  this.dataShort   = {};
  this.dataLong    = {};
  this.cusumStates   = {};
  this.mmdStates     = {};
  this.bettingStates = {};
  this.mixtureSupermartingaleStates = {};
}
TrendBufferImpl.prototype.push = function (this: TrendBufferI, key: string, value: number): void {
  if (!this.data[key]) this.data[key] = [];
  this.data[key].push(value);
  if (this.data[key].length > this.window) this.data[key].shift();

  if (!this.dataShort[key]) this.dataShort[key] = [];
  this.dataShort[key].push(value);
  if (this.dataShort[key].length > this.windowShort) this.dataShort[key].shift();

  if (!this.dataLong[key]) this.dataLong[key] = [];
  this.dataLong[key].push(value);
  if (this.dataLong[key].length > this.windowLong) this.dataLong[key].shift();
};
TrendBufferImpl.prototype.get = function (this: TrendBufferI, key: string): TrendSnapshot {
  const hist = this.data[key];
  if (!hist || hist.length < 4) {
    return {
      slope: 0, slopeNorm: 0, stable: false, cv: 1, mean: 0, roc: 0,
      min: 0, max: 0, range: 0, n: hist ? hist.length : 0, insufficient: true,
    };
  }
  const n = hist.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += hist[i]; sumXY += i * hist[i]; sumX2 += i * i; }
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const mean = sumY / n;
  const slopeNorm = mean !== 0 ? slope / Math.abs(mean) : 0;
  let variance = 0;
  for (let j = 0; j < n; j++) variance += Math.pow(hist[j] - mean, 2);
  const stdDev = Math.sqrt(variance / n);
  const cv = mean !== 0 ? stdDev / Math.abs(mean) : 1;
  let roc = 0;
  if (hist.length >= 3) {
    const rc = hist.slice(-3);
    roc = (rc[rc.length - 1] - rc[0]) / (rc.length - 1);
    roc = mean !== 0 ? roc / Math.abs(mean) : 0;
  }
  const stable = cv < 0.04 && Math.abs(slopeNorm) > 0.002;
  let tmin = hist[0], tmax = hist[0];
  for (let k = 1; k < n; k++) { if (hist[k] < tmin) tmin = hist[k]; if (hist[k] > tmax) tmax = hist[k]; }
  return { slope, slopeNorm, stable, cv, mean, roc, min: tmin, max: tmax, range: tmax - tmin, n, insufficient: false };
};
TrendBufferImpl.prototype.snapshot = function (this: TrendBufferI, key: string): SignalSnapshot {
  return {
    signal: key,
    short:  summarizeWindow(this.dataShort[key]),
    medium: summarizeWindow(this.data[key]),
    long:   summarizeWindow(this.dataLong[key]),
  };
};
TrendBufferImpl.prototype.reset = function (this: TrendBufferI): void {
  this.data = {};
  this.dataShort = {};
  this.dataLong = {};
  this.cusumStates = {};
  this.mmdStates = {};
  this.bettingStates = {};
  this.mixtureSupermartingaleStates = {};
};

export const TrendBuffer: TrendBufferCtor = TrendBufferImpl as unknown as TrendBufferCtor;

/** Compute a WindowSummary from a raw observation array. Matches the math in
 * TrendBuffer.get() for the same fields (mean, slopeNorm, cv, std) so a
 * snapshot's medium view agrees with get() bit-for-bit on those fields.
 * Empty/undefined input returns zeroes (n=0). */
function summarizeWindow(hist: number[] | undefined): WindowSummary {
  if (!hist || hist.length === 0) {
    return { n: 0, mean: 0, std: 0, slopeNorm: 0, cv: 0, trendStrength: 0 };
  }
  const n = hist.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += hist[i]; sumXY += i * hist[i]; sumX2 += i * i; }
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const mean = sumY / n;
  const slopeNorm = mean !== 0 ? slope / Math.abs(mean) : 0;
  let variance = 0;
  for (let j = 0; j < n; j++) variance += Math.pow(hist[j] - mean, 2);
  const std = Math.sqrt(variance / n);
  const cv = mean !== 0 ? std / Math.abs(mean) : 0;
  // trendStrength toward whichever direction the slope points — a single scalar
  // summary of directional consistency. Matches the formula in trendStrength()
  // below; insufficient-data short-circuit uses n < 4 and stable/cv heuristics.
  let ts = 0;
  if (n >= 4) {
    const dir = slopeNorm >= 0 ? 1 : -1;
    const rawSlope = slopeNorm * dir;
    if (rawSlope > 0) {
      const slopeScore = Math.min(1.0, rawSlope / 0.05);
      const stable = cv < 0.04 && Math.abs(slopeNorm) > 0.002;
      const stabilityBonus = stable ? 0.2 : Math.max(0, 0.2 * (1 - cv / 0.10));
      const noisePenalty = cv > 0.15 ? Math.min(0.5, (cv - 0.15) / 0.15) : 0;
      ts = Math.max(0, Math.min(1.0, slopeScore + stabilityBonus - noisePenalty));
    }
  }
  return { n, mean, std, slopeNorm, cv, trendStrength: ts };
}

// ── trendStrength ─────────────────────────────────────────────────
// Returns 0.0–1.0. Higher = more confident in sustained directional trend.
export function trendStrength(t: TrendSnapshot | null | undefined, direction: 'rise' | 'fall'): number {
  if (!t || t.n < 4 || t.insufficient) return 0;
  const dir = direction === 'fall' ? -1 : 1;
  const rawSlope = t.slopeNorm * dir;
  if (rawSlope <= 0) return 0;
  const slopeScore = Math.min(1.0, rawSlope / 0.05);
  const stabilityBonus = t.stable ? 0.2 : Math.max(0, 0.2 * (1 - t.cv / 0.10));
  const noisePenalty = t.cv > 0.15 ? Math.min(0.5, (t.cv - 0.15) / 0.15) : 0;
  return Math.max(0, Math.min(1.0, slopeScore + stabilityBonus - noisePenalty));
}

// ── effectiveThreshold ────────────────────────────────────────────
// Applies trend discount to base threshold. Fast roc bypasses discount.
export function effectiveThreshold(
  baseThreshold: number,
  trendDiscount: number,
  t: TrendSnapshot | null | undefined,
  direction?: 'rise' | 'fall',
  rocBypass?: number | null,
): number {
  if (!t || t.n < 4 || t.insufficient) return baseThreshold;
  if (rocBypass != null && Math.abs(t.roc) >= rocBypass) return baseThreshold;
  // Strength is applied exactly once: a refactor slip previously computed
  // `discount = trendDiscount * strength` and then subtracted
  // `discount * strength`, quadratically weakening the discount
  // (remediation M3; fixed identically in deploysignal-engine).
  const strength = trendStrength(t, direction || 'rise');
  return baseThreshold - trendDiscount * strength;
}

// ── WARMUP_CONFIG ─────────────────────────────────────────────────
export const WARMUP_CONFIG: WarmupConfig = {
  triggeredBy: ['model_weights', 'all'],
  windowHours: { critical: 6, high: 8, medium: 10, low: 4 },
  graceWindowHours: 2,
  absoluteBypass: { tokens_turn: 1.35, p99_latency: 1.40, cost_req: 1.80 },
  suppressedSignals: ['tokens', 'tok_econ', 'cost', 'kv_low', 'hbm_spill', 'mfu_delta', 'mem_pressure'],
};

export function getWarmupState(sc: Scenario, hrs: number): WarmupState {
  const ct: ChangeType | undefined = sc.changeType;
  if (!ct || WARMUP_CONFIG.triggeredBy.indexOf(ct) < 0) {
    return { active: false, grace: false, suppressedIds: [], pct: 100 };
  }
  const rl: RiskLevel = sc.riskLevel || 'medium';
  const wH = WARMUP_CONFIG.windowHours[rl] || 6;
  const gH = WARMUP_CONFIG.graceWindowHours;
  const inW = hrs < wH;
  const inG = !inW && hrs < (wH + gH);
  return {
    active: inW,
    grace: inG,
    pct: Math.min(100, Math.round(hrs / wH * 100)),
    hoursRemaining: Math.max(0, wH - hrs),
    suppressedIds: inW ? WARMUP_CONFIG.suppressedSignals : [],
  };
}

// ── computeVerdict ────────────────────────────────────────────────
export function computeVerdict(signals: HealthResult, tick: number, totalTicks: number): Verdict {
  if (signals.rollback.length > 0) return 'rollback';
  if (tick >= totalTicks - 1 && signals.extend.length === 0) return 'proceed';
  if (signals.extend.length > 0) return 'extend';
  return 'baking';
}

// ── FP_CLASSIFIER_CONFIG ──────────────────────────────────────────
export const FP_CLASSIFIER_CONFIG: FpClassifierConfig = {
  capacityEarlyRollbackMinTick: 8,
};

export const TOTAL_TICKS = 32;
