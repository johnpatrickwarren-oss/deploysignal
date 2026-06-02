"use strict";
// tools/calibrators/family-a.ts — End-phase slice 3b (D-54-3).
//
// Per-signal Family A calibration. Option 3 side-effect-free pattern
// per ARCHITECT-REPLY-54b: pure function returning { result, timings };
// caller accumulates timings in calibrate.ts local aggregator.
//
// Q2.A — accepts a `signalClass` parameter that drives a class-
// appropriate forward transform applied to baseline samples before
// meanStd derivation. Closes V1.H1 architecturally (bounded-probability
// signal saturation collapsing σ² → FP zero) by mapping bounded /
// heavy-tail / counts samples into a space where the Gaussian-H₀
// assumption underlying betting-e-process construction holds. Symmetric
// transform application at runtime (in engine/detectors/betting-e-
// process.ts) preserves the (μ, σ) calibration consistency between
// calibration-space and detection-space. P1 floor stays as belt-and-
// suspenders defense-in-depth for any residual edge case.
Object.defineProperty(exports, "__esModule", { value: true });
exports.FAMILY_A_BETTING_BOOTSTRAP_SEED = exports.SIGMA_SQUARED_FLOOR_CV_SQUARED = exports.TAU_SQUARED_DIV = exports.standardNormalLocal = exports.mulberry32Local = void 0;
exports.meanStd = meanStd;
exports.buildFamilyAPerSignal = buildFamilyAPerSignal;
exports.bootstrapBettingSlidingBufferThreshold = bootstrapBettingSlidingBufferThreshold;
const signal_classes_1 = require("../../engine/signal-classes");
const family_a_mixture_supermartingale_1 = require("../../engine/detectors/family-a-mixture-supermartingale");
const _family_a_rng_1 = require("./_family-a-rng");
const _family_a_betting_bootstrap_1 = require("./_family-a-betting-bootstrap");
// Re-export RNG helpers so existing `family-a.ts` import sites keep working.
var _family_a_rng_2 = require("./_family-a-rng");
Object.defineProperty(exports, "mulberry32Local", { enumerable: true, get: function () { return _family_a_rng_2.mulberry32Local; } });
Object.defineProperty(exports, "standardNormalLocal", { enumerable: true, get: function () { return _family_a_rng_2.standardNormalLocal; } });
/** τ² = δ_min² / TAU_SQUARED_DIV per ARCHITECT-REPLY-05.md.
 *  Page-CUSUM mixture-prior variance: prior concentrates around
 *  practical-significance-sized effects. */
exports.TAU_SQUARED_DIV = 4;
/** P1 calibration variance floor coefficient — `σ²_floor = ε_f · μ²`
 *  with `ε_f = 10⁻⁶` corresponds to a coefficient-of-variation floor
 *  of 10⁻³ on per-signal calibration. Per ARCHITECT-REPLY-52ge §69-71;
 *  closes V1.H1 (tool_success_rate σ² FP underflow on bounded-
 *  probability signals saturating near 1.0).
 *
 *  Rationale: under iid-bootstrap E3 methodology, `evaluateBettingEProcess`
 *  computes `z_t = (x_t − μ) / (B · σ_calibration)` with B = 3. When
 *  σ_calibration collapses to floating-point zero (saturated bounded-
 *  probability signal), z_t saturates at ±1 every tick; asymmetric
 *  saturation pushes the GRAPA bet positive and Ville's wealth
 *  martingale supermartingale property breaks. The floor caps the
 *  ratio σ_calibration / |μ| at ≥ 10⁻³, keeping z_t finite for any
 *  realistic observation tail.
 */
exports.SIGMA_SQUARED_FLOOR_CV_SQUARED = 1e-6;
/** Sample mean + population standard deviation, with P1 σ² floor
 *  applied to closure of V1.H1 calibration variance degeneracy.
 *  Returns `sigma_floor_applied` for audit visibility per
 *  ARCHITECT-REPLY-52ge §128-178. */
function meanStd(xs) {
    if (xs.length === 0) {
        return { mean: 0, std: 0, sigma_floor_applied: false };
    }
    let sum = 0;
    for (const x of xs)
        sum += x;
    const mean = sum / xs.length;
    let variance = 0;
    for (const x of xs)
        variance += (x - mean) ** 2;
    variance /= xs.length;
    // P1 floor per ARCHITECT-REPLY-52ge §69-71:
    //   σ²_floor = max(ε_f · μ², 1·10⁻⁶ · μ²)
    // Belt-and-suspenders: ε_f · μ² catches any cell with μ so small
    // that 1·10⁻⁶ · μ² underflows below ε_f · μ² in floating-point.
    const muSquared = mean * mean;
    const sigmaSquaredFloor = Math.max(Number.EPSILON * muSquared, exports.SIGMA_SQUARED_FLOOR_CV_SQUARED * muSquared);
    const sigmaFloorApplied = variance < sigmaSquaredFloor;
    const sigmaSquared = Math.max(variance, sigmaSquaredFloor);
    return {
        mean,
        std: Math.sqrt(sigmaSquared),
        sigma_floor_applied: sigmaFloorApplied,
    };
}
function buildFamilyAPerSignal(samples, contextOrClass = {}) {
    // Backward-compat: callers passing `SignalClass` directly (pre-Q2.B.5
    // signature). Detect by string vs object.
    const context = typeof contextOrClass === 'string'
        ? { signalClass: contextOrClass }
        : contextOrClass;
    const signalClass = context.signalClass ?? 'gaussian_like';
    const sigmaCDiagonal = context.sigma_c_diagonal;
    const t = process.hrtime.bigint();
    // Transformed-space stats drive δ_min / τ² / runtime-consumed (μ', σ').
    const transformed = signalClass === 'gaussian_like'
        ? samples
        : samples.map((s) => (0, signal_classes_1.transformForClass)(s, signalClass));
    const { mean, std, sigma_floor_applied } = meanStd(transformed);
    const sigma2 = std * std;
    const deltaMin = Math.max(0.05 * mean, 2 * std);
    const tauSquared = (deltaMin * deltaMin) / exports.TAU_SQUARED_DIV;
    // Raw-space arithmetic mean — Q2.B.4 coherence audit consumes this
    // in same-space terms as Family C's per-cell mean_vector.
    let meanRaw = 0;
    if (samples.length > 0) {
        let sum = 0;
        for (const s of samples)
            sum += s;
        meanRaw = sum / samples.length;
    }
    // Q2.B.5 — raw-space σ² for Page-CUSUM consumption.
    // Overlapping signals: σ²_raw = μ_raw² · Σ_C_blended[i,i].
    // Family-A-only signals: raw per-cell sample variance (with P1 floor).
    let baselineSigmaSquaredRaw;
    if (sigmaCDiagonal !== undefined) {
        baselineSigmaSquaredRaw = meanRaw * meanRaw * sigmaCDiagonal;
    }
    else {
        // Compute raw-space σ² from raw samples directly.
        let varianceRaw = 0;
        if (samples.length > 0) {
            for (const s of samples)
                varianceRaw += (s - meanRaw) ** 2;
            varianceRaw /= samples.length;
        }
        baselineSigmaSquaredRaw = varianceRaw;
    }
    // P1 floor as defense-in-depth (belt-and-suspenders; should never
    // trigger on Σ-coherence-derived raw σ², but caps any FP underflow
    // edge case symmetrically with the transformed-space σ² floor).
    const muRawSquared = meanRaw * meanRaw;
    const rawFloor = Math.max(Number.EPSILON * muRawSquared, exports.SIGMA_SQUARED_FLOOR_CV_SQUARED * muRawSquared);
    if (baselineSigmaSquaredRaw < rawFloor) {
        baselineSigmaSquaredRaw = rawFloor;
    }
    // Q66.A.b — Yule-Walker AR(1) phi estimation on transformed centered
    // residuals. Estimated in transformed space because runtime detector
    // pre-whitens x_centered which is centered against `baseline_mean`
    // (transformed mean per Q2.A). Phi clipped to [-0.95, +0.95] inside
    // the helper for numerical stability. Per axis 4.b reinforcement,
    // estimation is on baseline-mean-centered series (NOT raw series).
    const ar1Phi = (0, family_a_mixture_supermartingale_1.computePerSignalAr1Phi)(transformed, mean);
    const result = {
        baseline_mean: mean,
        baseline_mean_raw: meanRaw,
        baseline_sigma_squared: sigma2,
        baseline_sigma_squared_raw: baselineSigmaSquaredRaw,
        tau_squared: tauSquared,
        delta_min: deltaMin,
        ar1_phi: ar1Phi,
    };
    // Stamp the class on every emit (incl. gaussian_like) so audit
    // consumers can introspect the calibration without re-resolving
    // against DEFAULT_SIGNAL_CLASSES.
    result.signal_class = signalClass;
    // Q66 Phase-3.d.A close (item g) — derive + stamp mixture-supermartingale
    // hyperparams per Q66.1 derivation table (§ Phase-3.d.A SLICE 1 spec).
    // Runtime mixture-supermartingale variant (default at Phase-3.d.A close)
    // consumes this field; absence triggers runtime on-the-fly derivation
    // (degraded perf; recompile recommended). For signal classes without
    // a Phase-3.d.A SLICE 1 implementation (categorical → Phase-3.d.A.b),
    // derivation returns undefined and the field is omitted.
    const mixtureParams = (0, family_a_mixture_supermartingale_1.deriveMixtureSupermartingaleParams)(result);
    if (mixtureParams !== undefined) {
        result.mixture_supermartingale_params = mixtureParams;
    }
    if (sigma_floor_applied) {
        result.sigma_floor_applied = true;
    }
    return {
        result,
        timings: { tau2_fit_ns: process.hrtime.bigint() - t },
    };
}
// ── Q2.B.6.3 sliding-buffer betting wealth recalibration ────────────
/** Q2.B.6.3 — Family A betting bootstrap seed. Fixed so recompiles are
 *  deterministic. Mirrors Family D / Family C bootstrap-seed pattern. */
exports.FAMILY_A_BETTING_BOOTSTRAP_SEED = 0xFA03B >>> 0;
/** Mirror engine/detectors/betting-e-process.ts:boundedZ + GRAPA/ONS
 *  bet selection + wealth update. Inlined here so the calibrator stays
 *  self-contained relative to dist/ layout (matches family-c.ts
 *  bootstrapHotellingSlidingBufferThreshold pattern).
 *
 *  Q2.B.6.3 closure: the runtime betting wealth process M_t = M_{t-1} ·
 *  (1 + λ_t · z_t) is martingale under iid H₀ where z_t are mean-zero
 *  independent. Under joint AR(1) H₀ with non-trivial ρ, conditional
 *  E[z_t | z_{t-1}] = ρ·z_{t-1} ≠ 0; running mean drifts; bet drifts;
 *  wealth process is NOT martingale; Ville bound empirically violated
 *  (cost_req cell at (17,4,aggregate): empirical 11.55% FPR vs 0% iid).
 *
 *  Same architectural pattern as Q2.B.6.2 family_C safe_test under AR(1).
 *  Fix: bootstrap MAX wealth per trajectory under joint AR(1) H₀;
 *  (1−α) quantile gives the sliding-buffer-aware threshold. */
function bootstrapBettingSlidingBufferThreshold(baselineMean, sigmaSquared, rho, alpha, seed) {
    // N=500 matches Q2.B.6.1 Step 5 family_D + Q2.B.6.2 family_C precedent.
    // Per-trajectory MAX wealth has lower MC variance than single-tick
    // statistics; 500 iters keeps tail-quantile estimate stable.
    const N_BOOTSTRAPS = 500;
    const N_TICKS = 100;
    const BURN_IN = 10;
    const sigma = Math.sqrt(Math.max(sigmaSquared, 0));
    const epsScale = Math.sqrt(Math.max(0, 1 - rho * rho));
    // Match runtime constants from engine/detectors/betting-e-process.ts.
    const WEALTH_FLOOR = 1e-12;
    const { pickBet, boundedZ } = (0, _family_a_betting_bootstrap_1.makeBettingBetSelectors)(baselineMean, sigma);
    const rng = (0, _family_a_rng_1.mulberry32Local)(seed);
    const maxStatistics = new Array(N_BOOTSTRAPS);
    for (let traj = 0; traj < N_BOOTSTRAPS; traj++) {
        maxStatistics[traj] = (0, _family_a_betting_bootstrap_1.simulateNullMaxWealth)(rng, baselineMean, sigma, rho, epsScale, N_TICKS, BURN_IN, WEALTH_FLOOR, pickBet, boundedZ);
    }
    const { threshold, null_max_mean, null_max_std } = (0, _family_a_betting_bootstrap_1.summarizeBootstrapMaxStatistics)(maxStatistics, N_BOOTSTRAPS, alpha);
    return {
        threshold,
        bootstrap_n: N_BOOTSTRAPS,
        null_max_mean,
        null_max_std,
    };
}
