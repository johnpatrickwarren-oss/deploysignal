// engine/detectors/family-c-rff.ts —
// Q72 SLICE 2 (Phase 3.A.1) Random Fourier Features support module
// for the family_C betting-e-process detector. Replaces the biased
// kernel-of-empirical-mean streaming approximation (Q67 §Q67.4-ter)
// with an unbiased linear feature map: φ(x) ∈ R^D such that
//   K_RFF(x, y) := φ(x)·φ(y)
// is a Monte Carlo estimator of the RBF kernel K_RBF(x, y; σ); the
// Q-side empirical-mean of φ(X_j) is therefore an unbiased estimator
// of E_X[K(x, X)] (linearity of the inner product). See
// coordination/DIAGNOSTIC-Q72-PHASE-1-MMD-BETTING-STREAMING-BIAS-
// 2026-05-07.md for the bias derivation; this module ships the fix.
//
// Rahimi-Recht (NeurIPS 2007) Random Fourier Features:
//   φ(x) = sqrt(2/D) · [ cos(ω₁ᵀx + b₁), …, cos(ω_DᵀX + b_D) ]
// with ω_i ~ N(0, σ⁻²·I_d) and b_i ~ U(0, 2π) — produces an explicit
// feature map φ : R^d → R^D such that φ(x)·φ(y) ≈ K_RBF(x, y; σ) in
// expectation, with O(1/√D) approximation error.
//
// Determinism: cross-platform IEEE-754 + 32-bit-integer-arithmetic
// math only. Mulberry32 PRNG (pure 32-bit unsigned arithmetic) +
// Box-Muller transform (Math.log + Math.sqrt + Math.cos) + Math.cos
// at feature application — all standard libm operations that produce
// identical bit-level output on Darwin and Linux x86_64/aarch64.
// (Verified empirically at Q72 SLICE 2 close per Phase 3.C cross-
// platform-determinism gate.)
//
// Hyperparameter D — architect Phase-3.A pick: D = 256 default.
//   - For RBF on R^d=11, D = 256 features ≈ 23× the input dim;
//     Rahimi-Recht convergence: P(|K_RFF − K_RBF| < ε) ≥ 1 − 2·exp(
//     -D·ε²/8) per Lemma 1; at ε=0.1, D=256 gives prob ≥ 1 − 2·exp(
//     -3.2) ≈ 0.92 per pair — plenty for MMD-mean concentration.
//   - Halt-criterion (b) per Phase 3.A scope: if empirical FPR
//     convergence at D=256 insufficient, escalate to D=512/1024.
//
// Architectural placement: this module is library-grade primitive;
// callers are family_C_betting_e_process detector (runtime) +
// tools/calibrators/family-c.ts (compile-time μ_P^φ stamping). NO
// other detector touches RFF at SLICE 2 scope.

const TWO_PI = 2 * Math.PI;

/** Architect Phase 3.A default RFF dimension. Increase to 512 / 1024
 *  per halt-criterion (b) escalation if FPR convergence at D=256
 *  insufficient. */
export const RFF_DEFAULT_DIM = 256;

/** Mulberry32 — small, fast, deterministic seeded PRNG. Pure 32-bit
 *  unsigned-integer arithmetic; cross-platform safe (no FP libm
 *  variance for state evolution). Returns a function that yields
 *  uniform doubles in [0, 1) on each call. Period 2³².
 *
 *  Reference: github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
 *  (public domain). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate `count` standard-normal samples from the seeded uniform
 *  PRNG via the Box-Muller transform. Box-Muller produces samples in
 *  pairs (n1, n2) per uniform pair (u1, u2); we materialize the full
 *  array up front so callers can index deterministically without
 *  worrying about pair-truncation when `count` is odd. */
export function boxMullerNormals(rng: () => number, count: number): Float64Array {
  const out = new Float64Array(count);
  let i = 0;
  while (i < count) {
    // Guard against log(0) — Mulberry32 produces 0 only at one
    // 32-bit state; clamp to a tiny positive instead of NaN.
    const u1 = Math.max(rng(), 1e-300);
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = TWO_PI * u2;
    out[i] = r * Math.cos(theta);
    i++;
    if (i < count) {
      out[i] = r * Math.sin(theta);
      i++;
    }
  }
  return out;
}

/** RFF feature-map prerequisites — ω matrix (D × d) and b vector (D)
 *  derived deterministically from a seed integer. Pre-cell seed
 *  guarantees calibrator-time and runtime-time agreement on the
 *  feature map without persisting the full matrices in the compiled
 *  config (D×d×n_cells = ~3 MB for our scale; rejected as schema
 *  bloat per architect Phase 3.A pick). */
export interface RffFeatureMap {
  /** ω matrix; ω[i] ∈ R^d sampled from N(0, σ⁻²·I_d). Outer index i
   *  ∈ [0, D); inner index j ∈ [0, d). */
  omega: number[][];
  /** b vector; b[i] sampled from U(0, 2π). */
  b: number[];
  /** D — number of Fourier features. */
  D: number;
  /** d — input dimension. */
  d: number;
  /** Bandwidth σ used to set ω_i scale. Stored for audit visibility;
   *  caller passes this same value at applyRffFeatureMap (kernel
   *  approximation depends on σ — must match calibration-time σ). */
  bandwidth: number;
}

/** Compute the RFF feature map (ω matrix + b vector) deterministically
 *  from `seed`. The same seed produces byte-identical output across
 *  platforms (Mulberry32 + Box-Muller use only IEEE-754 standard libm
 *  operations on finite inputs — empirically verified at Q72 SLICE 2
 *  Phase 3.C cross-platform-determinism gate).
 *
 *  ω_{i,j} ~ N(0, σ⁻²) — equivalently, ~ N(0,1) / σ.
 *  b_i      ~ U(0, 2π). */
export function computeRffFeatureMap(
  seed: number, D: number, d: number, bandwidth: number,
): RffFeatureMap {
  if (!(D > 0)) throw new RangeError(`RFF D must be > 0; got ${D}`);
  if (!(d > 0)) throw new RangeError(`RFF d must be > 0; got ${d}`);
  if (!(bandwidth > 0)) throw new RangeError(`RFF bandwidth must be > 0; got ${bandwidth}`);
  const rng = mulberry32(seed);
  const inv_sigma = 1 / bandwidth;

  // Generate D × d standard normals up-front so Box-Muller pair
  // truncation doesn't depend on per-row layout.
  const normals = boxMullerNormals(rng, D * d);
  const omega: number[][] = new Array(D);
  for (let i = 0; i < D; i++) {
    const row = new Array<number>(d);
    for (let j = 0; j < d; j++) {
      row[j] = normals[i * d + j] * inv_sigma;
    }
    omega[i] = row;
  }

  // Generate D uniforms for b_i ∈ [0, 2π).
  const b = new Array<number>(D);
  for (let i = 0; i < D; i++) b[i] = rng() * TWO_PI;

  return { omega, b, D, d, bandwidth };
}

/** Apply the RFF feature map: φ(x) = sqrt(2/D) · [cos(ω₁ᵀx + b₁), …,
 *  cos(ω_DᵀX + b_D)]. Returns a freshly-allocated Float64Array of
 *  length D. Caller can convert to number[] if needed (kept as
 *  Float64Array for cross-platform-bit-stable summation and inner
 *  products). */
export function applyRffFeatureMap(x: number[], fm: RffFeatureMap): Float64Array {
  if (x.length !== fm.d) {
    throw new RangeError(
      `RFF input dim mismatch: feature map d=${fm.d}, x.length=${x.length}`,
    );
  }
  const D = fm.D;
  const scale = Math.sqrt(2 / D);
  const phi = new Float64Array(D);
  for (let i = 0; i < D; i++) {
    const omegaRow = fm.omega[i];
    let dot = 0;
    for (let j = 0; j < fm.d; j++) dot += omegaRow[j] * x[j];
    phi[i] = scale * Math.cos(dot + fm.b[i]);
  }
  return phi;
}

/** Compute the mean of φ(x) over a baseline pool. Used at calibration
 *  time to compute μ_P^φ = (1/N_P) Σ_i φ(X_{P,i}); the calibrator
 *  persists this vector in `cell.betting_e_process_params.baseline_rff_mean`
 *  so the runtime detector skips re-evaluating the P-side at every
 *  tick.
 *
 *  Returns Float64Array of length fm.D. Empty pool returns zeros. */
export function rffMeanOverPool(
  pool: ReadonlyArray<ReadonlyArray<number>>,
  fm: RffFeatureMap,
): Float64Array {
  const D = fm.D;
  const sum = new Float64Array(D);
  if (pool.length === 0) return sum;
  for (const x of pool) {
    const phi = applyRffFeatureMap(x as number[], fm);
    for (let i = 0; i < D; i++) sum[i] += phi[i];
  }
  const m = pool.length;
  for (let i = 0; i < D; i++) sum[i] /= m;
  return sum;
}

/** Inner product of two Float64Arrays of equal length D. Used for
 *  the runtime witness: F_t = φ(x_t) · (μ_P^φ - μ_Q^φ). */
export function rffDot(a: Float64Array | ReadonlyArray<number>, b: Float64Array | ReadonlyArray<number>): number {
  const D = a.length;
  if (b.length !== D) {
    throw new RangeError(`RFF dot product dim mismatch: ${D} vs ${b.length}`);
  }
  let s = 0;
  for (let i = 0; i < D; i++) s += a[i] * b[i];
  return s;
}

/** Derive a 32-bit unsigned-integer seed from the cell key — used by
 *  the calibrator + runtime to deterministically generate the RFF
 *  feature map for a given cell. Mirrors the existing `baselinePoolSeed`
 *  pattern from sequential-mmd.ts. Hash construction: string concat
 *  cell-key components, then Java-style String.hashCode (cumulative
 *  31·h + char) → mask to 32-bit unsigned.
 *
 *  NOTE: hash collisions across distinct cell keys are tolerable
 *  because the seed only feeds RFF feature map generation; collisions
 *  produce the SAME feature map for distinct cells, which is
 *  statistically benign (the cells already share RBF bandwidth from
 *  the same calibrator pass). */
export function rffCellSeed(cellKey: { hour_of_day: number; day_of_week?: number; tier?: string }): number {
  const s = `q72-rff-${cellKey.hour_of_day}-${cellKey.day_of_week ?? -1}-${cellKey.tier ?? 'none'}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 31) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
