// engine/gates/health.ts — G1 Health Signal Service
//
// Answers: "Is this service healthy here, now?"
//
// Key signals (proposal §2):
//   KV cache hit rate, MFU trend, HBM spill, tokens/turn, TTFT/ITL SLO,
//   collective ops, behavioral regression, downstream errors, cost/request.
//
// Also includes AI quality signals: eval score, refusal rate, output length,
// tool call success rate. These are runtime health — they belong in G1.
//
// CRITICAL DESIGN CHANGE from monolithic shared.js:
//   This module does NOT know about risk tiers, time windows, or approval state.
//   It receives a PolicyContext from G2 (policy.ts) containing:
//     - thresholds: per-signal base thresholds
//     - warmup: suppression list and bypass thresholds
//     - downstreamRule: corroboration requirements
//   G1 evaluates signals against those thresholds. Period.

import { trendStrength, effectiveThreshold } from '../core';
import { QUALITY_ROLLBACK_DEFS, QUALITY_EXTEND_DEFS } from '../signals/quality';
import { evaluateFamilyA } from '../detectors/page-cusum';
import { evaluateFamilyABettingShadow, getOrCreateBetting } from '../detectors/betting-e-process';
import { evaluateFamilyC } from '../detectors/hotelling';
import { evaluateFamilyE, freshConformalEValueState } from '../detectors/conformal';
import { evaluateFamilyD, FAMILY_D_SIGNALS, freshSpectralEDetectorState } from '../detectors/spectral';
import { evaluateEMmd } from '../detectors/sequential-mmd';
import { evaluateFamilyCBettingEProcess } from '../detectors/family-c-betting-e-process';
import { shouldSuppress } from '../l0/schema-continuity';
import type {
  Metrics, Baseline, Flags, PolicyContext,
  RollbackDef, ExtendDef, FiredSignal, HealthResult,
  TrendBufferI, CompiledConfig, DetectorVerdict,
  SchemaContinuityRecord, SafeHotellingState, ConformalEValueState,
} from '../types';

// ── Rollback signal definitions ──────────────────────────────────
// Each check receives: (live, baseline, flags, policyCtx, trendBuffer)
// policyCtx comes from G2 — contains thresholds, warmup state, etc.

const ROLLBACK_DEFS: RollbackDef[] = ([
  // p99 latency
  {
    id: 'p99', label: 'p99 Latency',
    check: function (m, b, _f, pol, tb) {
      const t = tb ? tb.get('p99_latency') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const base = pol.thresholds.p99 ? (pol.thresholds.p99.base ?? 1.20) : 1.20;
      const rocBypassVal = (pol._tick !== undefined && pol._tick < 6) ? 0.15 : 0.025;
      const thr = effectiveThreshold(base, 0.06, t, 'rise', rocBypassVal);
      return (m.p99_latency as number) / (b.p99_latency as number) >= thr;
    },
  },
  // TTFT
  {
    id: 'ttft', label: 'TTFT',
    check: function (m, b, _f, pol, tb) {
      const t = tb ? tb.get('ttft') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const base = pol.thresholds.ttft ? (pol.thresholds.ttft.base ?? 1.20) : 1.20;
      const thr = effectiveThreshold(base, 0.06, t, 'rise', 0.025);
      return (m.ttft as number) / (b.ttft as number) >= thr;
    },
  },
  // Compound latency: both p99 AND ttft over threshold; CV < 0.03 required
  {
    id: 'compound_lat', label: 'Compound Latency',
    check: function (m, b, _f, pol, tb) {
      const tp = tb ? tb.get('p99_latency') : null;
      const tt = tb ? tb.get('ttft') : null;
      if (!tp || tp.n < 4 || tp.insufficient) return false;
      if (!tt || tt.n < 4 || tt.insufficient) return false;
      if (tp.cv >= 0.03) return false;
      if (tt.cv >= 0.03) return false;
      const base = pol.thresholds.compound ? (pol.thresholds.compound.base ?? 1.12) : 1.12;
      const thrP = effectiveThreshold(base, 0.03, tp, 'rise', 0.030);
      const thrT = effectiveThreshold(base, 0.03, tt, 'rise', 0.030);
      return (m.p99_latency as number) / (b.p99_latency as number) >= thrP
          && (m.ttft as number) / (b.ttft as number) >= thrT;
    },
  },
  // Token economics: tokens + cost both sustained, OR extreme token inflation alone
  {
    id: 'tok_econ', label: 'Token Economics',
    check: function (m, b, _f, pol, tb) {
      const t = tb ? tb.get('tokens_turn') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const baseTok  = pol.thresholds.tok_econ ? (pol.thresholds.tok_econ.baseTok  ?? 1.25) : 1.25;
      const baseCost = pol.thresholds.tok_econ ? (pol.thresholds.tok_econ.baseCost ?? 1.20) : 1.20;
      const thrTok   = effectiveThreshold(baseTok, 0.05, t, 'rise', 0.030);
      const thrCost  = effectiveThreshold(baseCost, 0.04, tb ? tb.get('cost_req') : null, 'rise', 0.030);
      const tr = (m.tokens_turn as number) / (b.tokens_turn as number);
      const cr = (m.cost_req as number) / (b.cost_req as number);
      // Normal path: both tokens and cost sustained above thresholds
      if (tr >= thrTok && cr >= thrCost) return true;
      // Extreme inflation bypass: tokens very elevated (>1.5x) with a confirmed upward trend,
      // regardless of whether cost has caught up yet. Use trendStrength, not cv, since
      // a rising token trend will naturally have high cv.
      if (tr >= 1.5 && trendStrength(t, 'rise') >= 0.3) return true;
      return false;
    },
  },
  // Tokens alone: cost not tracking proportionally
  {
    id: 'tokens', label: 'Tokens/Turn',
    check: function (m, b, _f, pol, tb) {
      const t = tb ? tb.get('tokens_turn') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const base = pol.thresholds.tokens ? (pol.thresholds.tokens.base ?? 1.25) : 1.25;
      const thr = effectiveThreshold(base, 0.06, t, 'rise', null);
      const tr = (m.tokens_turn as number) / (b.tokens_turn as number);
      if (tr < thr) return false;
      const cr = (m.cost_req as number) / (b.cost_req as number);
      return cr < (1 + (tr - 1) * 0.9) * 0.85;
    },
  },
  // Cost disproportionate to token volume
  {
    id: 'cost', label: 'Cost/Request',
    check: function (m, b, _f, pol, tb) {
      const t = tb ? tb.get('cost_req') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const base = pol.thresholds.cost ? (pol.thresholds.cost.base ?? 1.20) : 1.20;
      const thr = effectiveThreshold(base, 0.05, t, 'rise', 0.030);
      const cr = (m.cost_req as number) / (b.cost_req as number);
      if (cr < thr) return false;
      return cr > 1 + ((m.tokens_turn as number) / (b.tokens_turn as number) - 1) * 1.1;
    },
  },
  // Downstream errors: uses G2's corroboration rule
  {
    id: 'downstream', label: 'Downstream Errors',
    check: function (m, b, _f, pol, tb) {
      const t = tb ? tb.get('downstream_err') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const rule = pol.downstreamRule || { base: 1.50 };
      const base = rule.base || 1.50;
      const thr = effectiveThreshold(base, 0.08, t, 'rise', 0.040);
      if ((m.downstream_err as number) <= (b.downstream_err as number) * thr) return false;
      // Corroboration check: if rule says so and we're past the hour threshold
      if (rule.requiresCorroboration === false) return true;
      if (rule.requiresCorroborationAfterHours && pol.hoursElapsed < rule.requiresCorroborationAfterHours) return true;
      // Need at least one corroborating signal
      return (m.p99_latency as number) / (b.p99_latency as number) > 1.05 ||
             (m.ttft as number) / (b.ttft as number) > 1.05 ||
             (m.tokens_turn as number) / (b.tokens_turn as number) > 1.03;
    },
  },
  // Collective ops: relative degradation; requires slopeNorm>=0.015 + HBM correlation
  {
    id: 'collective', label: 'Collective Ops',
    check: function (m, b, _f, _pol, tb) {
      const t = tb ? tb.get('collective_ops') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const tHbm = tb ? tb.get('hbm_spill') : null;
      const relDrop = ((b.collective_ops as number) - (m.collective_ops as number)) / (b.collective_ops as number);
      // Absolute drop override: >7% collective degradation with HBM corroboration.
      // Must be checked BEFORE the slope guard so flapping/oscillating patterns aren't
      // rejected by slopeNorm < 0.015 when the absolute degradation is already significant.
      if (relDrop >= 0.07 && tHbm && tHbm.slopeNorm >= 0.005) return true;
      const str = trendStrength(t, 'fall');
      if (t.slopeNorm !== undefined && Math.abs(t.slopeNorm) < 0.015 && str < 0.5) return false;
      if (tHbm && !tHbm.insufficient && tHbm.n >= 4) {
        if (tHbm.slopeNorm < 0.005) return false;
      }
      const dropThr = 0.0003 - 0.0001 * str;
      return relDrop >= dropThr;
    },
  },
  // Behavioral regression
  {
    id: 'behavioral', label: 'Behavioral Regression',
    check: function (m, b, _f, pol, tb) {
      const t = tb ? tb.get('corpus_delta') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const base = pol.thresholds.behavioral ? (pol.thresholds.behavioral.base ?? 1.18) : 1.18;
      const thr = effectiveThreshold(base, 0.05, t, 'rise', 0.030);
      return (m.corpus_delta as number) / (b.corpus_delta as number) >= thr;
    },
  },
  // GPU efficiency: model_weights only, after 12h warmup
  {
    id: 'gpu_eff', label: 'GPU Efficiency Regression',
    check: function (m, b, _f, pol, tb) {
      if (pol.changeType !== 'model_weights' || pol.hoursElapsed < 12) return false;
      const tm = tb ? tb.get('mfu') : null;
      const tl = tb ? tb.get('p99_latency') : null;
      if (!tm || tm.n < 4 || tm.insufficient) return false;
      if (!tl || tl.n < 4 || tl.insufficient) return false;
      const mfuBase = 0.12, latBase = 0.08;
      const mfuThr = mfuBase - 0.03 * trendStrength(tm, 'fall');
      const latThr = latBase - 0.02 * trendStrength(tl, 'rise');
      const mfuDrop = ((b.mfu as number) - (m.mfu as number)) / (b.mfu as number);
      if (mfuDrop < mfuThr) return false;
      // Corroboration: p99 latency rising OR HBM pressure rising.
      // Oscillating MFU degradation may not show in latency until late;
      // HBM rise is an earlier indicator of GPU memory saturation.
      const latOk = ((m.p99_latency as number) - (b.p99_latency as number)) / (b.p99_latency as number) >= latThr;
      if (latOk) return true;
      const tHbm = tb ? tb.get('hbm_spill') : null;
      return !!(tHbm && !tHbm.insufficient && tHbm.n >= 4 &&
                (m.hbm_spill as number) / (b.hbm_spill as number) >= 1.20 && tHbm.slopeNorm >= 0.005);
    },
  },
  // MFU collapse: >=20% sustained MFU drop, any changeType.
  // Catches GPU efficiency disasters that gpu_eff misses (serving_code, or pre-12h model_weights).
  {
    id: 'mfu_collapse', label: 'MFU Collapse',
    check: function (m, b, _f, _pol, tb) {
      const t = tb ? tb.get('mfu') : null;
      if (!t || t.n < 6 || t.insufficient) return false;
      const drop = ((b.mfu as number) - (m.mfu as number)) / (b.mfu as number);
      if (drop < 0.20) return false;
      return trendStrength(t, 'fall') >= 0.3;
    },
  },
  // Capacity: minTick=6, stable HBM, >=2 of {HBM, KV, p99} signals
  {
    id: 'capacity', label: 'Capacity Constraint',
    check: function (m, b, _f, _pol, tb) {
      const tHbm = tb ? tb.get('hbm_spill') : null;
      const tKv  = tb ? tb.get('kv_cache') : null;
      if (!tHbm || tHbm.n < 6) return false;
      if (!tKv  || tKv.n  < 6) return false;
      if (tHbm.insufficient) return false;
      if (tKv.insufficient)  return false;
      if (!tHbm.stable) return false;
      if (tHbm.slopeNorm < 0.005) return false;
      const hbmRatio = (m.hbm_spill as number) / (b.hbm_spill as number);
      const kvRatio  = (m.kv_cache as number)  / (b.kv_cache as number);
      const tLat = tb ? tb.get('p99_latency') : null;
      let sigCount = 0;
      if (hbmRatio >= 1.30 && tHbm.slopeNorm >= 0.008) sigCount++;
      if (kvRatio <= 0.90 && tKv.slopeNorm < -0.005) sigCount++;
      if (tLat && !tLat.insufficient && tLat.n >= 4 && tLat.slopeNorm >= 0.008) sigCount++;
      return sigCount >= 2;
    },
  },
  // HBM spill standalone: sustained rising HBM without requiring MFU correlation.
  // Catches thermal pressure and memory-isolated degradation patterns.
  // NOTE: cv is NOT used here — a linearly rising signal has naturally high cv
  // (the distribution is wide). trendStrength captures directional consistency.
  {
    id: 'hbm_spill_roll', label: 'HBM Spill (Sustained)',
    check: function (m, b, _f, _pol, tb) {
      const t = tb ? tb.get('hbm_spill') : null;
      if (!t || t.n < 8 || t.insufficient) return false;
      if (t.slopeNorm < 0.006) return false;
      if (trendStrength(t, 'rise') < 0.3) return false;
      const ratio = (m.hbm_spill as number) / (b.hbm_spill as number);
      return ratio >= 1.28;
    },
  },
  // HBM sustained elevation: moderate HBM rise that falls below hbm_spill_roll thresholds
  // (slopeNorm < 0.006, ratio < 1.28) but represents genuine memory pressure buildup.
  // Catches cache-bounce / cache-invalidation bugs producing slow, steady HBM rise.
  {
    id: 'hbm_elevation', label: 'HBM Sustained Elevation',
    check: function (m, b, _f, _pol, tb) {
      const t = tb ? tb.get('hbm_spill') : null;
      if (!t || t.n < 8 || t.insufficient) return false;
      if (t.slopeNorm < 0.002) return false;
      if (trendStrength(t, 'rise') <= 0) return false;
      return (m.hbm_spill as number) / ((b.hbm_spill as number) || 1) >= 1.08;
    },
  },
  // KV cache saturation plateau: cache has hit the utilization ceiling and flatlined.
  // ratio >= 1.04 with near-zero slope and near-zero variance means cache is pinned at max
  // capacity — a precursor to HBM eviction cascades on any additional load.
  // Catches cache-warmup masking patterns where improving metrics hide a capacity cliff.
  {
    id: 'kv_saturation', label: 'KV Cache Saturation',
    check: function (m, b, _f, _pol, tb) {
      const tKv = tb ? tb.get('kv_cache') : null;
      if (!tKv || tKv.n < 6 || tKv.insufficient) return false;
      if ((m.kv_cache as number) / ((b.kv_cache as number) || 1) < 1.04) return false;
      if (Math.abs(tKv.slopeNorm) > 0.002) return false;
      return tKv.cv < 0.005;
    },
  },
  // Slowbleed: 4+ metrics drifting consistently at low but sustained magnitude.
  // Catches coordinated multi-metric degradation that individually evades per-signal thresholds.
  {
    id: 'slowbleed', label: 'Slow Bleed (Multi-Metric Drift)',
    check: function (m, b, _f, _pol, tb) {
      if (!tb) return false;
      const checks: Array<{ key: string; dir: 'rise' | 'fall' }> = [
        { key: 'p99_latency',    dir: 'rise' },
        { key: 'ttft',           dir: 'rise' },
        { key: 'tokens_turn',    dir: 'rise' },
        { key: 'cost_req',       dir: 'rise' },
        { key: 'hbm_spill',      dir: 'rise' },
        { key: 'downstream_err', dir: 'rise' },
        { key: 'corpus_delta',   dir: 'rise' },
        { key: 'kv_cache',       dir: 'fall' },
        { key: 'mfu',            dir: 'fall' },
      ];
      let drifting = 0;
      for (let i = 0; i < checks.length; i++) {
        const c = checks[i];
        const t = tb.get(c.key);
        if (!t || t.n < 6 || t.insufficient) continue;
        const sn = t.slopeNorm;
        // Consistent low-magnitude directional drift: slopeNorm 0.001-0.010
        const inRange = c.dir === 'rise'
          ? (sn >= 0.001 && sn < 0.010)
          : (sn <= -0.001 && sn > -0.010);
        if (!inRange) continue;
        // Do NOT gate on cv — a trending signal has naturally high cv.
        // Instead gate on trendStrength > 0 to confirm directional consistency.
        if (trendStrength(t, c.dir === 'rise' ? 'rise' : 'fall') <= 0) continue;
        // Ratio must actually be moving in the bad direction
        const val = m[c.key];
        const base = b[c.key];
        if (!val || !base) continue;
        const ratio = val / base;
        const badDir = c.dir === 'rise' ? ratio > 1.02 : ratio < 0.98;
        if (badDir) drifting++;
      }
      return drifting >= 4;
    },
  },
  // Flag-based signals: security findings, artifact content, provenance, contracts
  // These are still "health" — they're runtime safety signals, not policy decisions.
  { id: 'security',   label: 'Security Finding',  check: function (_m, _b, f) { return !!(f && f.security); } },
  {
    id: 'artifact', label: 'Artifact Content',
    check: function (_m, _b, f, _pol, tb) {
      if (!f || !f.artifact_content) return false;
      const tAny = tb ? tb.get('p99_latency') : null;
      const obsCount = tAny ? tAny.n : 0;
      if (obsCount < 4) return false;
      if (tAny && !tAny.insufficient && tAny.cv >= 0.15 && obsCount < 5) return false;
      const severity = f.artifact_severity || 'critical';
      if (severity === 'critical') return true;
      return obsCount >= 4;
    },
  },
  { id: 'provenance', label: 'Provenance/Hash',  check: function (_m, _b, f) { return !!(f && f.provenance); } },
  { id: 'contract',   label: 'Contract Tests',   check: function (_m, _b, f) { return !!(f && f.contract); } },

] as RollbackDef[]).concat(QUALITY_ROLLBACK_DEFS);


// ── Extend signal definitions ────────────────────────────────────

const EXTEND_DEFS: ExtendDef[] = ([
  { id: 'borderline', label: 'Borderline Latency', check: function (m, b, _f, pol, tb) {
    const base = pol.thresholds.p99 ? (pol.thresholds.p99.base ?? 1.20) : 1.20;
    const t = tb ? tb.get('p99_latency') : null;
    const upper = effectiveThreshold(base, 0.06, t, 'rise', 0.025);
    const d = (m.p99_latency as number) / (b.p99_latency as number);
    return d >= 1.08 && d < upper;
  } },
  { id: 'kv_low', label: 'KV Cache Low', check: function (m, b, _f, _pol, tb) {
    const t = tb ? tb.get('kv_cache') : null;
    const thr = effectiveThreshold(0.95, 0.03, t, 'fall', null);
    return (m.kv_cache as number) < (b.kv_cache as number) * thr || (m.kv_cache as number) < 0.85;
  } },
  { id: 'mfu_delta', label: 'MFU Drift', check: function (m, b, _f, _pol, tb) {
    const t = tb ? tb.get('mfu') : null;
    const str = trendStrength(t, 'fall');
    const thr = 0.10 - 0.03 * str;
    return Math.abs((m.mfu as number) - (b.mfu as number)) / (b.mfu as number) > thr;
  } },
  { id: 'hbm_spill', label: 'HBM Spill Rate', check: function (m, b, _f, _pol, tb) {
    const t = tb ? tb.get('hbm_spill') : null;
    const thr = effectiveThreshold(1.30, 0.08, t, 'rise', 0.040);
    return (m.hbm_spill as number) > (b.hbm_spill as number) * thr;
  } },
  { id: 'mem_pressure', label: 'Memory Pressure', check: function (m, b) {
    return ((m.kv_cache as number) < (b.kv_cache as number) * 0.95 || (m.kv_cache as number) < 0.85)
        && (m.hbm_spill as number) > 0.025;
  } },
  { id: 'low_traffic', label: 'Traffic Volume', check: function (m) {
    return (m.traffic_pct as number) < 0.60;
  } },
  { id: 'mixed', label: 'Signal Consistency', check: function (m, b, _f, pol, tb) {
    const base = pol.thresholds.p99 ? (pol.thresholds.p99.base ?? 1.20) : 1.20;
    const t = tb ? tb.get('p99_latency') : null;
    const upper = effectiveThreshold(base, 0.06, t, 'rise', 0.025);
    const ratio = (m.p99_latency as number) / (b.p99_latency as number);
    const bl = ratio >= 1.08 && ratio < upper;
    const kv = (m.kv_cache as number) < (b.kv_cache as number) * 0.97 && (m.kv_cache as number) >= 0.85;
    return bl || kv;
  } },
  { id: 'toolchain', label: 'Toolchain SCA', check: function (_m, _b, f) { return !!(f && f.toolchain); } },

] as ExtendDef[]).concat(QUALITY_EXTEND_DEFS);


// ── Public API ───────────────────────────────────────────────────

/** Week 2+3 Family A/C context. Optional — when omitted, the
 *  ratio-detector path is unchanged. When `compiledConfig.baseline_cells`
 *  has Family A populated, Page-CUSUM promotes to primary; when Family C
 *  is populated, Hotelling T² runs alongside at the end of the cascade. */
export interface HealthOpts {
  compiledConfig?: CompiledConfig | null;
  currentHourOfDay?: number;
  /** Week 3: day-of-week (0..6) for 2-D cell lookup. When absent, cell
   *  matching ignores day_of_week (works for 1-D configs). */
  currentDayOfWeek?: number;
  ticksSinceDeploy?: number;
  deployAgeDays?: number;
  /** Week 5 §S6: Addition #8 schema-continuity class for the live stream
   *  this tick. Threaded through to Family A/C/D/E detectors; Family B is
   *  unaffected per spec. */
  schemaContinuityClass?: SchemaContinuityRecord['schema_continuity'];
  /** Week 6+ Addition #13 (per ARCHITECT-REPLY-31 correction): signals
   *  whose live observation lies inside the operator's ignore band.
   *  Threaded to Family A (single-signal mSPRT) only — Family A
   *  suppresses the specific matching signal with
   *  `suppression_reason: 'ignore_threshold'` and emits
   *  `ignore_threshold_trigger_signal: signalId`. Multivariate families
   *  (C Hotelling T², E conformal Mahalanobis) evaluate the full joint
   *  vector regardless of `ignoredSignals` state — in-band signals
   *  contribute near-zero to the Mahalanobis quadratic form naturally,
   *  so explicit suppression would be redundant and would silence those
   *  families on other-signal drift the operator didn't intend to
   *  ignore. Family B structural signatures are similarly unaffected.
   *  Absent → treated as an empty set. */
  ignoredSignals?: Set<string>;
  /** Addition #23 — tenant_id for the request(s) this tick. Detector-
   *  family shadow evaluators resolve this to `tenant_tier` via
   *  `compiledConfig.tenant_tier_map` and look up `(hour, day,
   *  tenant_tier)` cells. Absent or unmapped → `'aggregate'` tier
   *  (backward compat with pre-#23 configs). */
  tenantId?: string;
}

/** Ratio detector IDs whose per-signal job is owned by Family A CUSUM
 *  once the swap in 2.1.g lands. Fires for these IDs get redirected to
 *  `HealthResult.family_A_legacy_shadow` for one comparison cycle.
 *  Composite detectors that *reference* these signals (`compound_lat`,
 *  `tok_econ`, `slowbleed`) stay on the primary path — they key on
 *  multi-signal structure, not a single CUSUM-covered signal. */
const FAMILY_A_RETIRED_RATIO_IDS = new Set<string>([
  'p99', 'ttft', 'downstream', 'cost',
  'eval_quality_drop', 'tool_call_degradation',
]);

/**
 * Evaluate health signals against live metrics.
 *
 * G1 ONLY evaluates health. It does NOT check time windows (G2),
 * deployment state (G3), blast radius (G4), or approval (G5).
 */
export function evaluateHealth(
  liveMetrics: Metrics,
  baseline: Baseline,
  flags: Flags,
  policyCtx: PolicyContext,
  tb: TrendBufferI | null,
  opts?: HealthOpts,
): HealthResult {
  const warmup = policyCtx.warmup || { active: false, suppressedIds: [], grace: false, pct: 100 };
  const sup = warmup.suppressedIds || [];
  const bypass: { [id: string]: boolean } = {};

  // Warmup absolute bypass: if metric exceeds bypass threshold even during warmup, fire anyway
  if (warmup.active && warmup.absoluteBypass) {
    if ((liveMetrics.tokens_turn as number) / (baseline.tokens_turn as number) >= warmup.absoluteBypass.tokens_turn) {
      bypass['tokens'] = true; bypass['tok_econ'] = true;
    }
    if ((liveMetrics.p99_latency as number) / (baseline.p99_latency as number) >= warmup.absoluteBypass.p99_latency) {
      bypass['p99'] = true;
    }
    if (warmup.absoluteBypass.cost_req &&
        (liveMetrics.cost_req as number) / (baseline.cost_req as number) >= warmup.absoluteBypass.cost_req) {
      bypass['cost'] = true;
    }
  }

  const rollbackFired: FiredSignal[] = [];
  const extendFired: FiredSignal[] = [];
  const legacyShadow: FiredSignal[] = [];
  // Post-2.1.g swap: when Family A is compiled (W3: under the unified
  // `baseline_cells` schema with a family_A block populated for at least
  // one cell), ratio fires for Family A's 6 primary SLIs redirect to
  // `family_A_legacy_shadow`. Page-CUSUM fires become the primary source
  // of truth for those signals. Other ratio detectors (structural
  // signatures, compound, tokens, etc.) stay on the primary path.
  const familyAPromoted = !!opts?.compiledConfig?.baseline_cells?.cells.some((c) => c.family_A);

  // Evaluate rollback signals
  ROLLBACK_DEFS.forEach(function (d) {
    if (sup.indexOf(d.id) >= 0 && !bypass[d.id]) return;  // suppressed during warmup
    if (d.check(liveMetrics, baseline, flags, policyCtx, tb)) {
      if (familyAPromoted && FAMILY_A_RETIRED_RATIO_IDS.has(d.id)) {
        legacyShadow.push({ id: d.id, label: d.label });
      } else {
        rollbackFired.push({ id: d.id, label: d.label });
      }
    }
  });

  // Evaluate extend signals
  EXTEND_DEFS.forEach(function (d) {
    if (sup.indexOf(d.id) >= 0) return;
    if (d.check(liveMetrics, baseline, flags, policyCtx, tb)) {
      extendFired.push({ id: d.id, label: d.label });
    }
  });

  const result: HealthResult = {
    rollback:   rollbackFired,
    extend:     extendFired,
    warmup,
    suppressed: sup,
  };

  // Family A Page-CUSUM (per ARCHITECT-REPLY-05.md). Primary detector for
  // the 6 primary SLIs when `compiledConfig.baseline_cells.*.family_A` is
  // populated. CUSUM state persists on the TrendBuffer for the deploy
  // lifetime. Errors silently swallowed — a shadow crash must not fail
  // the primary gate.
  if (familyAPromoted && tb) {
    try {
      // Q66 Phase-3.d.A close (item g) — dispatch wrapper reads
      // cfg.page_cusum_variant (default 'mixture_supermartingale') and
      // delegates to either the Howard-Ramdas-2021 Ville-bounded path
      // (default) or the classical reset-at-zero path (with deprecation
      // warning; retires at Phase-3.d.C). Both state maps threaded; the
      // unused one stays empty across the deploy lifetime.
      if (!tb.mixtureSupermartingaleStates) tb.mixtureSupermartingaleStates = {};
      const shadow: DetectorVerdict[] = evaluateFamilyA(
        opts!.compiledConfig!,
        liveMetrics,
        tb.cusumStates,
        tb.mixtureSupermartingaleStates,
        {
          hourOfDay:         opts!.currentHourOfDay ?? new Date().getHours(),
          dayOfWeek:         opts!.currentDayOfWeek,
          ticksSinceDeploy:  opts!.ticksSinceDeploy ?? 0,
          deployAgeDays:     opts!.deployAgeDays ?? 0,
          trafficPct:        (liveMetrics.traffic_pct as number) ?? 1.0,
          schemaContinuityClass: opts!.schemaContinuityClass,
          ignoredSignals:    opts?.ignoredSignals,
          tenantId:          opts?.tenantId,
        },
      );
      result.family_A_shadow = shadow;
      // Promote Page-CUSUM fires to primary rollback entries. Provenance
      // (S_n, threshold, α) lives in `family_A_shadow` — the rollback
      // array carries the minimum v1-schema-compatible surface.
      for (const v of shadow) {
        if (v.verdict !== 'fire' || !v.signal) continue;
        const id = 'family_A_' + v.signal;
        if (sup.indexOf(id) >= 0) continue;  // warmup-suppressed per convention
        rollbackFired.push({ id, label: 'Family A ' + v.signal });
      }
    } catch (_e) {
      // Shadow-mode errors are silent by design. The Week 4 audit schema
      // bump introduces a dedicated error channel.
    }

    // Addition #17 (ARCHITECT-REPLY-34) — co-shipped betting e-process
    // shadow. Runs alongside Page-CUSUM on the same cell params under a
    // 50/50 α-split of the per-signal Bonferroni budget. Both detectors
    // emit independent per-signal verdicts; fires promote to
    // `family_A_betting_{signal}` rollback entries so audit records
    // distinguish them from Page-CUSUM fires.
    try {
      if (!tb.bettingStates) tb.bettingStates = {};
      const bettingShadow: DetectorVerdict[] = evaluateFamilyABettingShadow(
        opts!.compiledConfig!,
        liveMetrics,
        tb.bettingStates,
        {
          hourOfDay:         opts!.currentHourOfDay ?? new Date().getHours(),
          dayOfWeek:         opts!.currentDayOfWeek,
          ticksSinceDeploy:  opts!.ticksSinceDeploy ?? 0,
          deployAgeDays:     opts!.deployAgeDays ?? 0,
          trafficPct:        (liveMetrics.traffic_pct as number) ?? 1.0,
          schemaContinuityClass: opts!.schemaContinuityClass,
          ignoredSignals:    opts?.ignoredSignals,
          tenantId:          opts?.tenantId,
        },
      );
      if (bettingShadow.length > 0) {
        // Extend the existing family_A_shadow array so audit consumers
        // see one contiguous Family A block; fires get a distinct
        // rollback id via the 'family_A_betting_' prefix.
        result.family_A_shadow = (result.family_A_shadow ?? []).concat(bettingShadow);
        for (const v of bettingShadow) {
          if (v.verdict !== 'fire' || !v.signal) continue;
          const id = 'family_A_betting_' + v.signal;
          if (sup.indexOf(id) >= 0) continue;
          rollbackFired.push({ id, label: 'Family A betting ' + v.signal });
        }
      }
      // Touch getOrCreateBetting so the re-export binds at runtime
      // even when FAMILY_A_PRIMARY_SIGNALS emits zero ticks (defensive
      // against tree-shakers — shim is also consumed inside the detector).
      void getOrCreateBetting;
    } catch (_e) {
      // Mirror the Page-CUSUM silent-shadow posture; a betting crash
      // must not fail the primary gate.
    }
    if (legacyShadow.length > 0) result.family_A_legacy_shadow = legacyShadow;
  }

  // Family C (Hotelling T²) — W3 addition. End of the cascade; any fire
  // adds a `family_C` rollback entry. Stateless (per-tick test); error
  // swallowing identical to Family A.
  const familyCEnabled = !!opts?.compiledConfig?.baseline_cells?.cells.some((c) => c.family_C);
  if (familyCEnabled) {
    // Addition #20 — safe-Hotelling dispatch threads a per-(deploy, cell)
    // state store through evaluateFamilyC. Legacy chi_square cells ignore
    // the store (stateless); safe_test cells lazy-allocate wealth state
    // keyed by `__sh_<tier>_<h>_<d>`. Pre-#20 TrendBuffers without
    // `safeHotellingStates` degrade gracefully via the `??= {}`.
    const shStates: Record<string, SafeHotellingState> | undefined = tb
      ? (tb.safeHotellingStates ??= {})
      : undefined;
    try {
      const v = evaluateFamilyC(opts!.compiledConfig!, liveMetrics, {
        hourOfDay:        opts!.currentHourOfDay ?? new Date().getHours(),
        dayOfWeek:        opts!.currentDayOfWeek,
        ticksSinceDeploy: opts!.ticksSinceDeploy ?? 0,
        deployAgeDays:    opts!.deployAgeDays ?? 0,
        trafficPct:       (liveMetrics.traffic_pct as number) ?? 1.0,
        schemaContinuityClass: opts!.schemaContinuityClass,
        tenantId:         opts?.tenantId,
      }, shStates);
      if (v) {
        result.family_C_verdict = v;
        if (v.verdict === 'fire' && sup.indexOf('family_C') < 0) {
          rollbackFired.push({ id: 'family_C', label: 'Family C (multivariate)' });
        }
      }
    } catch (_e) {
      // Silent — see Family A comment above.
    }
    // Q68 Phase-3.d.C consolidation — classical Sequential MMD (Addition
    // #18 bootstrap-null) retired. Family C MMD dispatch routes solely
    // through Q67 v2 canonical betting-e-process variant
    // (`evaluateFamilyCBettingEProcess`) + Option-B Addition #20
    // (`evaluateEMmd`) for backward-compat with pre-Q67 cells lacking
    // betting_e_process_params (Option-B is Ville-bounded by construction;
    // preserved at Q68 .C scope).
    if (tb) {
      // Addition #20 — e-MMD (betting e-process) parallel call. Self-
      // gates on `e_mmd_params` presence (absent → pre-#20 cell or
      // bootstrap-null variant cell; evaluateEMmd returns null). Also
      // self-gates when Q67 v2 `betting_e_process_params` are populated
      // (Q67 v2 supersedes Option-B per § Q67.5).
      // Emits its own detector_id via verdict.signal='sequential_mmd_e_process'
      // so audit can distinguish from the bootstrap-null path.
      try {
        const eStates = (tb.eMmdStates ??= {}) as Record<string, unknown>;
        const emmd = evaluateEMmd(opts!.compiledConfig!, liveMetrics, eStates, {
          hourOfDay:        opts!.currentHourOfDay ?? new Date().getHours(),
          dayOfWeek:        opts!.currentDayOfWeek,
          ticksSinceDeploy: opts!.ticksSinceDeploy ?? 0,
          deployAgeDays:    opts!.deployAgeDays ?? 0,
          trafficPct:       (liveMetrics.traffic_pct as number) ?? 1.0,
          schemaContinuityClass: opts!.schemaContinuityClass,
          tenantId:         opts?.tenantId,
        });
        if (emmd) {
          // Reuse family_C_mmd_verdict slot since bootstrap_null and
          // betting_e_process are mutually exclusive per cell.variant.
          result.family_C_mmd_verdict = emmd;
          if (emmd.verdict === 'fire' && sup.indexOf('family_C_mmd') < 0) {
            rollbackFired.push({ id: 'family_C_mmd', label: 'Family C (e-MMD)' });
          }
        }
      } catch (_e) { /* silent */ }
      // Q67 SPEC § Q67.2 — canonical Shekhar-Ramdas-2023 betting-e-process
      // parallel call. Self-gates on `mmd_variant === 'betting_e_process'`
      // AND `betting_e_process_params` populated (Q67 v2 compile output);
      // returns null on pre-Q67 cells, letting the parallel evaluateEMmd
      // and evaluateSequentialMMD calls cover those variants. Emits its
      // own detector_id via verdict.signal='sequential_mmd_betting_e_process'
      // so audit distinguishes Q67 v2 from Option-B and bootstrap-null.
      try {
        const fcbStates = (tb.familyCBettingStates ??= {}) as Record<string, unknown>;
        const fcb = evaluateFamilyCBettingEProcess(
          opts!.compiledConfig!, liveMetrics, fcbStates, {
            hourOfDay:        opts!.currentHourOfDay ?? new Date().getHours(),
            dayOfWeek:        opts!.currentDayOfWeek,
            ticksSinceDeploy: opts!.ticksSinceDeploy ?? 0,
            deployAgeDays:    opts!.deployAgeDays ?? 0,
            trafficPct:       (liveMetrics.traffic_pct as number) ?? 1.0,
            schemaContinuityClass: opts!.schemaContinuityClass,
            tenantId:         opts?.tenantId,
          });
        if (fcb) {
          // Reuse family_C_mmd_verdict slot — Q67 v2, Option-B, and
          // bootstrap-null are mutually exclusive per cell.variant +
          // cell-params layout (supersession guards in evaluateEMmd +
          // evaluateSequentialMMD enforce single-route).
          result.family_C_mmd_verdict = fcb;
          if (fcb.verdict === 'fire' && sup.indexOf('family_C_mmd') < 0) {
            rollbackFired.push({ id: 'family_C_mmd', label: 'Family C (canonical betting-e-process)' });
          }
        }
      } catch (_e) { /* silent */ }
    }
  }

  // Family D (ACF oscillation) — W4 addition. Per-signal; consumes the
  // TrendBuffer's long view (default 30 samples). Fires push
  // `family_D_${signal}` into rollback. Silent error swallow per Family A.
  const familyDEnabled = !!opts?.compiledConfig?.baseline_cells?.aggregate_fallback.family_D;
  if (familyDEnabled && tb) {
    try {
      const out: DetectorVerdict[] = [];
      // W5 §S6: schema-continuity suppression must fire before the
      // window-fill gate below. Otherwise 'breaking' runs with an
      // underfilled buffer would produce family.D.verdict === 'clean'
      // instead of 'suppressed', contradicting Addition #8.
      const klass = opts!.schemaContinuityClass;
      if (klass && shouldSuppress(klass, 'D')) {
        const reason = klass === 'observability_stack'
          ? 'observability_stack_deploy' : 'schema_continuity_breaking';
        for (const sig of FAMILY_D_SIGNALS) {
          out.push({
            verdict: 'suppressed', statistic: null, threshold: null,
            alpha_consumed: 0, alpha_spent: 0,
            reason_code: reason, family: 'D', signal: sig,
          });
        }
      } else {
        // Addition #21 — lazy-allocate spectral-e-detector state store
        // per-(deploy, signal). Each signal owns its own wealth martingale;
        // legacy bootstrap-null path ignores the state (stateless). Pre-#21
        // TrendBuffers without `spectralEDetectorStates` degrade gracefully
        // via the `??= {}` — legacy variant dispatch still works without
        // a state store populated.
        const spectralStates = tb.spectralEDetectorStates ??= {};
        for (const sig of FAMILY_D_SIGNALS) {
          const longView = tb.dataLong[sig];
          if (!longView || longView.length < 20) continue;
          const sigState = spectralStates[sig] ??= freshSpectralEDetectorState();
          const v = evaluateFamilyD(opts!.compiledConfig!, sig, longView, {
            hourOfDay:        opts!.currentHourOfDay ?? new Date().getHours(),
            dayOfWeek:        opts!.currentDayOfWeek,
            ticksSinceDeploy: opts!.ticksSinceDeploy ?? 0,
            deployAgeDays:    opts!.deployAgeDays    ?? 0,
            trafficPct:       (liveMetrics.traffic_pct as number) ?? 1.0,
            schemaContinuityClass: opts!.schemaContinuityClass,
          }, sigState);
          if (v) out.push(v);
        }
      }
      if (out.length > 0) {
        result.family_D_shadow = out;
        for (const v of out) {
          if (v.verdict !== 'fire' || !v.signal) continue;
          const id = 'family_D_' + v.signal;
          if (sup.indexOf(id) >= 0) continue;
          rollbackFired.push({ id, label: 'Family D ' + v.signal });
        }
      }
    } catch (_e) { /* silent */ }
  }

  // Family E (conformal novelty) — W4 addition. Single multivariate test;
  // fires push `family_E` into rollback.
  const familyEEnabled = !!opts?.compiledConfig?.baseline_cells?.aggregate_fallback.family_E;
  if (familyEEnabled) {
    // Addition #22 — lazy-allocate weighted-conformal-e-value state
    // store per-(deploy, cell). Cell-keyed (`e_<tier>_<h>_<d>`) so
    // multi-tenant deployments keep per-cell wealth. Pre-#22
    // TrendBuffers without `conformalEValueStates` degrade gracefully
    // via `??= {}` — legacy unweighted/weighted paths ignore the store.
    const eCellKey = `e_${opts!.tenantId ?? 'none'}_${opts!.currentHourOfDay ?? 0}_${opts!.currentDayOfWeek ?? -1}`;
    const eStates: Record<string, ConformalEValueState> | undefined = tb
      ? (tb.conformalEValueStates ??= {})
      : undefined;
    const eState = eStates
      ? (eStates[eCellKey] ??= freshConformalEValueState())
      : undefined;
    try {
      const v = evaluateFamilyE(opts!.compiledConfig!, liveMetrics, {
        hourOfDay:        opts!.currentHourOfDay ?? new Date().getHours(),
        dayOfWeek:        opts!.currentDayOfWeek,
        ticksSinceDeploy: opts!.ticksSinceDeploy ?? 0,
        deployAgeDays:    opts!.deployAgeDays    ?? 0,
        trafficPct:       (liveMetrics.traffic_pct as number) ?? 1.0,
        schemaContinuityClass: opts!.schemaContinuityClass,
        tenantId:         opts?.tenantId,
      }, eState);
      if (v) {
        result.family_E_verdict = v;
        if (v.verdict === 'fire' && sup.indexOf('family_E') < 0) {
          rollbackFired.push({ id: 'family_E', label: 'Family E (novelty)' });
        }
      }
    } catch (_e) { /* silent */ }
  }

  return result;
}

export { ROLLBACK_DEFS, EXTEND_DEFS };
