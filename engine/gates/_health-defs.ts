// engine/gates/_health-defs.ts — G1 rollback/extend signal definitions.
//
// The ratio-detector check tables for the Health Signal Service. Moved
// verbatim from health.ts; the facade re-exports ROLLBACK_DEFS / EXTEND_DEFS.

import { trendStrength, effectiveThreshold } from '@johnpatrickwarren-oss/deploysignal-engine/core';
import { QUALITY_ROLLBACK_DEFS, QUALITY_EXTEND_DEFS } from '../signals/quality';
import type { RollbackDef, ExtendDef } from '../types';

// ── Rollback signal definitions ──────────────────────────────────
// Each check receives: (live, baseline, flags, policyCtx, trendBuffer)
// policyCtx comes from G2 — contains thresholds, warmup state, etc.

export const ROLLBACK_DEFS: RollbackDef[] = ([
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

export const EXTEND_DEFS: ExtendDef[] = ([
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
