// engine/scenarios/slow_burn.ts — slow-burn and quality-regression scenario definitions
// These scenarios complement the base 8 by testing failure modes that unfold gradually
// or are only detectable via quality signals, not infrastructure metrics alone.
//
// Scenario taxonomy:
//   KNOWN BAD (should rollback):  silent_corruption, gradual_leak, cascade_failure, canary_regression
//   CLEAN (should NOT rollback):  cold_start
//
// New metrics used (optional — base scenarios lack them, signals gate on presence):
//   eval_score       (0–1)     — model quality benchmark proxy
//   refusal_rate     (0–1)     — fraction of requests refused by model
//   output_len_p50   (tokens)  — median output length

import type { Scenario } from '../types';

type DriftFn = (i: number, p: { [key: string]: number }) => { [key: string]: number };

interface SlowBurnScenario extends Scenario {
  id: string;
  name: string;
  driftParams: { [key: string]: number };
  drift: DriftFn;
}

export const SLOW_BURN_SCENARIOS: SlowBurnScenario[] = [

  // ── silent_corruption ─────────────────────────────────────────────
  // Infrastructure looks healthy. Only quality signals detect this.
  // Represents: model weight poisoning, silent quantization error, subtle fine-tune regression.
  {
    id: 'silent_corruption', name: 'Silent Quality Corruption',
    riskLevel: 'critical', bakeHours: 84, author: 'human', changeType: 'model_weights', timeWindow: 'ok',
    flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
    baseline: {
      p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042,
      downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997,
      corpus_delta: 0.04, traffic_pct: 1.0,
      eval_score: 0.87, refusal_rate: 0.015, output_len_p50: 185,
    },
    driftParams: { evalDropRate: 0.006, refusalOnset: 8, refusalMultiplier: 3.5 },
    drift: function (i, p) {
      // Infrastructure: flat with noise — looks completely healthy
      const infra: { [key: string]: number } = {
        p99_latency: 1 + 0.008 * Math.random(),
        ttft:        1 + 0.008 * Math.random(),
        tokens_turn: 1 + 0.006 * Math.random(),
        kv_cache:    1 - 0.002 * Math.random(),
        cost_req:    1 + 0.006 * Math.random(),
        downstream_err: 1 + 0.03 * Math.random(),
        mfu:         1 - 0.003 * Math.random(),
        hbm_spill:   1 + 0.01 * Math.random(),
        collective_ops: 1 - 0.00003 * Math.random(),
        corpus_delta: 1 + 0.01 * Math.random(),
        traffic_pct: 1,
      };
      // Quality: eval_score begins degrading at tick 4 (trend needs 4+ obs to confirm)
      const evalOnset = 4;
      let evalDrop = i >= evalOnset ? 1 - (i - evalOnset + 1) * (p.evalDropRate || 0.006) : 1;
      evalDrop = Math.max(0.55, evalDrop);
      // Refusal rate spikes after evalDrop is well established
      const refMult = i >= (p.refusalOnset || 8) ? (p.refusalMultiplier || 3.5) : 1 + 0.1 * Math.random();
      // Output length shrinks as model becomes more conservative (correlated with refusals)
      const lenMult = i >= (p.refusalOnset || 8) ? 0.82 + 0.02 * Math.random() : 1 + 0.02 * (Math.random() - 0.5);
      return Object.assign(infra, {
        eval_score:     evalDrop,
        refusal_rate:   refMult,
        output_len_p50: lenMult,
      });
    },
  },

  // ── gradual_leak ──────────────────────────────────────────────────
  // HBM memory leak grows at 0.3%/tick — barely detectable until tick 15+.
  // Represents: memory allocator leak, KV cache eviction pressure buildup.
  // Tests whether sustained-trend detection fires before hard threshold breach.
  {
    id: 'gradual_leak', name: 'Gradual Memory Leak',
    riskLevel: 'critical', bakeHours: 84, author: 'human', changeType: 'serving_code', timeWindow: 'ok',
    flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
    baseline: {
      p99_latency: 183, ttft: 217, tokens_turn: 415, kv_cache: 0.89, cost_req: 0.0041,
      downstream_err: 0.11, mfu: 0.72, hbm_spill: 0.018, collective_ops: 0.9997,
      corpus_delta: 0.04, traffic_pct: 1.0,
    },
    driftParams: { hbmRate: 0.003, kvRate: 0.004, latOnset: 10 },
    drift: function (i, p) {
      // HBM spill: slow linear accumulation from tick 0
      const hbm = 1 + i * (p.hbmRate || 0.003) + 0.005 * Math.random();
      // KV cache slowly degrades as eviction pressure rises
      const kv = 1 - i * (p.kvRate || 0.004) * 0.8 - 0.002 * Math.random();
      // Latency: stays flat until memory pressure is severe (tick 10+)
      const lat = i >= (p.latOnset || 10)
        ? 1 + (i - (p.latOnset || 10)) * 0.012 + 0.008 * Math.random()
        : 1 + 0.008 * Math.random();
      return {
        p99_latency: lat, ttft: 1 + (lat - 1) * 0.6,
        tokens_turn: 1 + 0.007 * Math.random(),
        kv_cache: kv,
        cost_req: 1 + 0.006 * Math.random(),
        downstream_err: 1 + 0.02 * Math.random(),
        mfu: 1 - 0.003 * Math.random(),
        hbm_spill: hbm,
        collective_ops: 1 - 0.00004 * Math.random(),
        corpus_delta: 1 + 0.01 * Math.random(),
        traffic_pct: 1,
      };
    },
  },

  // ── canary_regression ─────────────────────────────────────────────
  // Only 10% of traffic on new version. Metrics represent the canary slice,
  // showing full degradation. traffic_pct=0.10 indicates blast radius.
  // Represents: partial rollout where canary shows cache/latency regression.
  {
    id: 'canary_regression', name: 'Canary Regression',
    riskLevel: 'high', bakeHours: 72, author: 'human', changeType: 'serving_code', timeWindow: 'ok',
    flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
    baseline: {
      p99_latency: 180, ttft: 212, tokens_turn: 412, kv_cache: 0.88, cost_req: 0.0040,
      downstream_err: 0.10, mfu: 0.71, hbm_spill: 0.018, collective_ops: 0.9997,
      corpus_delta: 0.05, traffic_pct: 0.10,  // 10% canary slice
    },
    driftParams: { tokenSlope: 0.040, costSlope: 0.038, latSlope: 0.015, onsetTick: 2 },
    drift: function (i, p) {
      const on = p.onsetTick || 2;
      const tm = i < on ? 1 + 0.01 * Math.random() : 1 + (i - on + 1) * (p.tokenSlope || 0.040);
      const cm = i < on ? 1 + 0.008 * Math.random() : 1 + (i - on + 1) * (p.costSlope || 0.038);
      const lm = i < on ? 1 + 0.01 * Math.random() : 1 + (i - on)     * (p.latSlope || 0.015);
      return {
        p99_latency: lm, ttft: 1 + (lm - 1) * 0.7,
        tokens_turn: tm, kv_cache: 0.88 + 0.004 * Math.sin(i / 4),
        cost_req: cm,
        downstream_err: 1 + 0.025 * Math.random(),
        mfu: 0.71 + 0.003 * Math.sin(i / 5),
        hbm_spill: 0.018 + 0.002 * Math.random(),
        collective_ops: 0.9997 - 0.00004 * Math.random(),
        corpus_delta: 1 + (i < on ? 0.01 : (i - on) * 0.032) * Math.random(),
        traffic_pct: 0.10,  // fixed: canary fraction never drifts
      };
    },
  },

  // ── cascade_failure ───────────────────────────────────────────────
  // Phase 1 (tick 3+): downstream error spike
  // Phase 2 (tick 5+): latency rises from retry overhead
  // Phase 3 (tick 7+): token count increases (retry payloads)
  // Represents: upstream dependency failure cascading into model serving layer.
  {
    id: 'cascade_failure', name: 'Cascade Failure',
    riskLevel: 'critical', bakeHours: 84, author: 'human', changeType: 'serving_code', timeWindow: 'ok',
    flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
    baseline: {
      p99_latency: 182, ttft: 215, tokens_turn: 415, kv_cache: 0.89, cost_req: 0.0041,
      downstream_err: 0.11, mfu: 0.72, hbm_spill: 0.019, collective_ops: 0.9997,
      corpus_delta: 0.04, traffic_pct: 1.0,
    },
    driftParams: { errOnset: 3, latOnset: 5, tokenOnset: 7, errSlope: 0.18, latSlope: 0.09, tokenSlope: 0.025 },
    drift: function (i, p) {
      const errOn = p.errOnset || 3;
      const latOn = p.latOnset || 5;
      const tokOn = p.tokenOnset || 7;
      const errMult = i >= errOn ? 1 + (i - errOn + 1) * (p.errSlope   || 0.18) : 1 + 0.02 * Math.random();
      const latMult = i >= latOn ? 1 + (i - latOn + 1) * (p.latSlope   || 0.09) : 1 + 0.008 * Math.random();
      const tokMult = i >= tokOn ? 1 + (i - tokOn + 1) * (p.tokenSlope || 0.025) : 1 + 0.007 * Math.random();
      return {
        p99_latency:    latMult,
        ttft:           1 + (latMult - 1) * 0.5,
        tokens_turn:    tokMult,
        kv_cache:       1 - 0.002 * Math.random(),
        cost_req:       1 + (tokMult - 1) * 0.9,
        downstream_err: errMult,
        mfu:            i >= latOn ? 1 - (i - latOn) * 0.008 : 1 - 0.002 * Math.random(),
        hbm_spill:      1 + 0.01 * Math.random(),
        collective_ops: 1 - 0.00004 * Math.random(),
        corpus_delta:   1 + 0.01 * Math.random(),
        traffic_pct:    1,
      };
    },
  },

  // ── cold_start ────────────────────────────────────────────────────
  // CLEAN scenario — should NOT trigger rollback.
  // High latency ticks 0–4 (cold start / KV cache re-warm), then normalizes.
  // Tests that early-tick guards prevent false rollbacks during known transients.
  {
    id: 'cold_start', name: 'Cold Start Transient',
    riskLevel: 'critical', bakeHours: 84, author: 'human', changeType: 'model_weights', timeWindow: 'ok',
    flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
    baseline: {
      p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042,
      downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997,
      corpus_delta: 0.04, traffic_pct: 1.0,
    },
    driftParams: { spikeHeight: 2.8, spikeTicks: 4 },
    drift: function (i, p) {
      const spikeTicks = p.spikeTicks || 4;
      const spikeHeight = p.spikeHeight || 2.8;
      // Sharp spike at tick 0, decays exponentially to normal by tick spikeTicks
      const decay = i < spikeTicks ? Math.exp(-i * 1.2) : 0;
      const latMult = 1 + (spikeHeight - 1) * decay + 0.008 * Math.random();
      const kvMult = i < spikeTicks ? 1 - 0.15 * decay : 1 - 0.002 * Math.random();
      return {
        p99_latency:    latMult,
        ttft:           1 + (latMult - 1) * 0.8,
        tokens_turn:    1 + 0.008 * Math.random(),
        kv_cache:       kvMult,
        cost_req:       1 + 0.008 * Math.random(),
        downstream_err: 1 + 0.04 * Math.random(),
        mfu:            1 - 0.005 * Math.random(),
        hbm_spill:      1 + 0.01 * Math.random(),
        collective_ops: 1 - 0.00004 * Math.random(),
        corpus_delta:   1 + 0.015 * Math.random(),
        traffic_pct:    1,
      };
    },
  },
];

// Scenarios that should NOT trigger rollback (used by runner to track FP rate)
export const CLEAN_SCENARIO_IDS: Set<string> = new Set(['cold_start']);

// Scenarios that SHOULD trigger rollback (used by loop to track TP rate)
export const KNOWN_BAD_SCENARIO_IDS: string[] = ['silent_corruption', 'gradual_leak', 'cascade_failure', 'canary_regression'];
