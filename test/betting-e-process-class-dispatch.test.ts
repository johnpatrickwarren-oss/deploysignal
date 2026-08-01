// test/betting-e-process-class-dispatch.test.ts — Q2.A acceptance #8.
//
// Empirical Ville-bound regression test. For each of the four signal
// classes, generate iid H₀ samples in raw space, apply the class-
// appropriate forward transform, run the betting-e-process wealth
// martingale across N trajectories × T ticks, and assert FPR ≤ the
// Wilson-CI upper bound on α (per spec acceptance criterion 8).
//
// Per ARCHITECT-REPLY-52gk pair-review: this test serves as the
// load-bearing empirical validation for the WSR-2024 GRAPA betting
// composability with class transforms. If passes, the formal-property
// gap (Ville inequality on transformed-then-bet pipelines) is closed
// empirically. If fails, architect re-disposition.
//
// Parameters chosen for meaningful pair-review evidence at low CI cost:
//   α = 0.01 (threshold 1/α = 100) — reachable wealth in T ticks
//   N = 1000 trajectories per class
//   T = 100 ticks per trajectory
//   bound = α + 3·sqrt(α(1−α)/N) ≈ 0.01 + 0.0094 ≈ 0.0194
// Total work ≈ 4 × 100k state updates ≈ ~1s wall-clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  freshBettingState, updateBettingState,
} from '../engine/detectors/betting-e-process';
import {
  transformForClass, type SignalClass,
} from '@johnpatrickwarren-oss/deploysignal-engine/signal-classes';

// ── Deterministic generators ──────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  let u = rng();
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Bernoulli sample at probability p. Used to generate
 *  bounded_probability iid H₀ samples in {0, 1}. */
function bernoulli(rng: () => number, p: number): number {
  return rng() < p ? 1 : 0;
}

/** Log-normal sample with given log-mean μ and log-std σ. Used to
 *  generate heavy_tail iid H₀ samples in (0, ∞). */
function logNormal(rng: () => number, mu: number, sigma: number): number {
  return Math.exp(mu + sigma * gaussian(rng));
}

/** Poisson sample via Knuth's algorithm. Used to generate counts iid
 *  H₀ samples in {0, 1, 2, ...}. λ should be ≥ 1 for Anscombe to be
 *  in its useful range. */
function poisson(rng: () => number, lambda: number): number {
  // Knuth: generate u ~ U(0,1) until product < e^{-λ}.
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  while (true) {
    k += 1;
    p *= rng();
    if (p < L) return k - 1;
    if (k > lambda + 100) return k - 1; // safety guard for very large λ
  }
}

// ── Test parameters ──────────────────────────────────────────────

const ALPHA = 0.01;
const THRESHOLD = 1 / ALPHA;        // 100
const N_TRAJECTORIES = 1000;
const T_TICKS = 100;
// Wilson-CI upper bound on observed FPR. With α=0.01 and N=1000,
// this is ~0.0194.
const FPR_BOUND = ALPHA + 3 * Math.sqrt(ALPHA * (1 - ALPHA) / N_TRAJECTORIES);

// ── Per-class iid H₀ generators (raw space) ──────────────────────

interface ClassFixture {
  signalClass: SignalClass;
  /** Generate one raw-space sample under iid H₀. */
  sample: (rng: () => number) => number;
  /** Population mean + variance in TRANSFORMED space; used as the
   *  detector's calibration (μ', σ²'). Computed analytically when
   *  possible; otherwise estimated via a large-N pre-run. */
  transformedCalibration: (rng: () => number) => { mean: number; sigmaSquared: number };
}

const FIXTURES: ClassFixture[] = [
  {
    signalClass: 'gaussian_like',
    // N(100, 5²) — typical p99_latency-like.
    sample: (rng) => 100 + 5 * gaussian(rng),
    transformedCalibration: () => ({ mean: 100, sigmaSquared: 25 }),
  },
  {
    signalClass: 'bounded_probability',
    // Bernoulli(0.99) — saturated tool_success_rate-like.
    sample: (rng) => bernoulli(rng, 0.99),
    transformedCalibration: (rng) => {
      // Empirical (μ', σ'²) on logit-transformed Bernoulli(0.99).
      // Logit-transformed values cluster at logit(0.99) ≈ 4.595 and
      // logit(0.01) ≈ -4.595 (clipped at LOGIT_BOUNDARY_EPS for x=0).
      // Use a 5000-sample pre-run; fixed seed for stability.
      const N = 5000;
      const ts: number[] = [];
      for (let i = 0; i < N; i++) {
        ts.push(transformForClass(bernoulli(rng, 0.99), 'bounded_probability'));
      }
      let sum = 0;
      for (const v of ts) sum += v;
      const mean = sum / N;
      let sq = 0;
      for (const v of ts) sq += (v - mean) ** 2;
      return { mean, sigmaSquared: sq / N };
    },
  },
  {
    signalClass: 'heavy_tail',
    // log-normal(μ_log = -5.3, σ_log = 0.4) — cost_req-like
    // (raw mean ≈ 0.0054; tail decay).
    sample: (rng) => logNormal(rng, -5.3, 0.4),
    transformedCalibration: () => ({ mean: -5.3, sigmaSquared: 0.16 }),
  },
  {
    signalClass: 'counts',
    // Poisson(λ=20) — moderate-rate count signal.
    sample: (rng) => poisson(rng, 20),
    transformedCalibration: (rng) => {
      // Anscombe-transformed Poisson(λ) has approximate mean
      // 2√(λ + 3/8) ≈ 2√20.375 ≈ 9.028 and variance ≈ 1.
      // Empirical pre-run on 5000 samples.
      const N = 5000;
      const ts: number[] = [];
      for (let i = 0; i < N; i++) {
        ts.push(transformForClass(poisson(rng, 20), 'counts'));
      }
      let sum = 0;
      for (const v of ts) sum += v;
      const mean = sum / N;
      let sq = 0;
      for (const v of ts) sq += (v - mean) ** 2;
      return { mean, sigmaSquared: sq / N };
    },
  },
];

// ── Test runner: one fire-rate measurement per class ─────────────

function measureFireRate(fx: ClassFixture, rngSeed: number): number {
  // Use a separate seed for calibration vs trajectory rngs so the
  // pre-run doesn't bleed into trajectory state.
  const calibRng = mulberry32(rngSeed ^ 0xCA11);
  const { mean: muT, sigmaSquared: sigma2T } = fx.transformedCalibration(calibRng);

  const trajRng = mulberry32(rngSeed);
  let fires = 0;
  for (let i = 0; i < N_TRAJECTORIES; i++) {
    const state = freshBettingState();
    let fired = false;
    for (let t = 0; t < T_TICKS; t++) {
      const raw = fx.sample(trajRng);
      const transformed = transformForClass(raw, fx.signalClass);
      // Per-tick α ignored for the Ville-bound regression — wealth
      // accumulation is what we test; α-budget bookkeeping is a
      // separate orthogonal concern.
      const M = updateBettingState(state, transformed, muT, sigma2T, 0);
      if (M >= THRESHOLD) {
        fired = true;
        break;
      }
    }
    if (fired) fires++;
  }
  return fires / N_TRAJECTORIES;
}

// ── Per-class assertions ─────────────────────────────────────────

test('Q2.A Ville-bound: gaussian_like iid H₀ — FPR ≤ α + 3·sqrt(α(1−α)/N)', () => {
  const fpr = measureFireRate(FIXTURES[0], 0xC0DE0001);
  assert.ok(fpr <= FPR_BOUND,
    `gaussian_like FPR ${fpr.toFixed(5)} exceeds bound ${FPR_BOUND.toFixed(5)}`);
});

test('Q2.A Ville-bound: bounded_probability iid Bernoulli(0.99) H₀ — FPR ≤ bound', () => {
  const fpr = measureFireRate(FIXTURES[1], 0xC0DE0002);
  assert.ok(fpr <= FPR_BOUND,
    `bounded_probability FPR ${fpr.toFixed(5)} exceeds bound ${FPR_BOUND.toFixed(5)}; `
    + 'V1.H1-class regression — saturated samples may have collapsed σ² in transformed space');
});

test('Q2.A Ville-bound: heavy_tail iid log-normal H₀ — FPR ≤ bound', () => {
  const fpr = measureFireRate(FIXTURES[2], 0xC0DE0003);
  assert.ok(fpr <= FPR_BOUND,
    `heavy_tail FPR ${fpr.toFixed(5)} exceeds bound ${FPR_BOUND.toFixed(5)}`);
});

test('Q2.A Ville-bound: counts iid Poisson(20) H₀ — FPR ≤ bound', () => {
  const fpr = measureFireRate(FIXTURES[3], 0xC0DE0004);
  assert.ok(fpr <= FPR_BOUND,
    `counts FPR ${fpr.toFixed(5)} exceeds bound ${FPR_BOUND.toFixed(5)}`);
});

test('Q2.A Ville-bound: all four classes report FPR; summary for PR description', () => {
  // Final summary test prints per-class FPR for transparent pair-review
  // reporting in PR description (per prediction-confidence-calibration
  // discipline). This test always passes — it's a reporting test, not
  // a gate. Gate tests above each assert FPR ≤ bound independently.
  const summary: Array<{ class: SignalClass; fpr: number }> = [];
  for (let i = 0; i < FIXTURES.length; i++) {
    summary.push({
      class: FIXTURES[i].signalClass,
      fpr: measureFireRate(FIXTURES[i], 0xC0DE1000 + i),
    });
  }
  for (const r of summary) {
    console.log(`  Q2.A class=${r.class.padEnd(20)} fpr=${r.fpr.toFixed(5)} `
      + `bound=${FPR_BOUND.toFixed(5)} margin=${(FPR_BOUND - r.fpr).toFixed(5)}`);
  }
  assert.ok(summary.length === 4);
});
