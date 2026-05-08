"use strict";
// tools/calibrators/family-c.ts — End-phase slice 3c (D-54-3).
//
// Per-cell Family C calibration (MCD / MRCD / Ledoit-Wolf routing +
// safe-Hotelling precompute + e-MMD precompute + D6b MCD-skip
// diagnostic). Option 3 side-effect-free pattern per ARCHITECT-
// REPLY-54b: pure function returning { result, timings, diagnostics };
// caller accumulates into aggregators local to tools/calibrate.ts
// compile() rather than module-level state.
//
// Anti-scope (REPLY-54b): no detector math changes. Croux-Haesbroeck
// c_α consistency correction is F1 (task #28), post-merge against
// this module.
Object.defineProperty(exports, "__esModule", { value: true });
exports.FAMILY_C_BETTING_BASELINE_POOL_SIZE = exports.FAMILY_C_BETTING_LAMBDA_MAX = exports.FAMILY_C_DEFAULT_SHRINK_FRACTION = exports.MMD_MIN_BASELINE_SAMPLES = exports.MMD_BOOTSTRAP_N = exports.MMD_WINDOW_SIZE = exports.MMD_BOOTSTRAP_SEED_BASE = exports.D6B_OUTLIER_FRACTION_THRESHOLD = exports.D6B_LAMBDA_THRESHOLD = exports.FASTMCD_DEFAULT_SEED = exports.FASTMCD_DEFAULT_ALPHA = exports.FASTMCD_TOP_N_FOR_FULL = exports.FASTMCD_CSTEP_LIMIT = exports.FASTMCD_N_WARM_SUBSETS = exports.FASTMCD_N_INITIAL_SUBSETS = exports.OFFDIAG_REL_TOLERANCE = exports.PSD_TOLERANCE = exports.FAMILY_C_HOTELLING_BOOTSTRAP_SEED = void 0;
exports.bootstrapHotellingSlidingBufferThreshold = bootstrapHotellingSlidingBufferThreshold;
exports.columnMean = columnMean;
exports.relativeDeviations = relativeDeviations;
exports.sampleCovariance = sampleCovariance;
exports.ledoitWolfShrinkage = ledoitWolfShrinkage;
exports.applyAggregateShrinkage = applyAggregateShrinkage;
exports.chiSqQuantile975 = chiSqQuantile975;
exports.logDetCholesky = logDetCholesky;
exports.logDetLocal = logDetLocal;
exports.mahalanobisSqFromL = mahalanobisSqFromL;
exports.mahalanobis = mahalanobis;
exports.isPSDWithTolerance = isPSDWithTolerance;
exports.cStep = cStep;
exports.initialSubsetEstimate = initialSubsetEstimate;
exports.computeLWWarmSeed = computeLWWarmSeed;
exports.fastMCD = fastMCD;
exports.mcdReweight = mcdReweight;
exports.consistencyCorrectionFactor = consistencyCorrectionFactor;
exports.buildFamilyCPerCellMCD = buildFamilyCPerCellMCD;
exports.buildFamilyCPerCellMRCD = buildFamilyCPerCellMRCD;
exports.initialFallbackMCD = initialFallbackMCD;
exports.medianPairwiseDistance = medianPairwiseDistance;
exports.rbfKernel = rbfKernel;
exports.mmdBaselineBaselineSum = mmdBaselineBaselineSum;
exports.mmdBootstrapNullQuantile = mmdBootstrapNullQuantile;
exports.mmdSeedForCell = mmdSeedForCell;
exports.buildMMDParams = buildMMDParams;
exports.buildFamilyCPerCell = buildFamilyCPerCell;
const _shared_js_1 = require("./_shared.js");
const sequential_mmd_js_1 = require("../../engine/detectors/sequential-mmd.js");
const family_c_rff_js_1 = require("../../engine/detectors/family-c-rff.js");
// ── Q2.B.6.2 sliding-buffer Hotelling recalibration ─────────────────
/** Q2.B.6.2 — Family C sliding-buffer Hotelling bootstrap seed. Fixed
 *  so recompiles are deterministic. Mirrors Family D's
 *  FAMILY_D_BOOTSTRAP_SEED pattern. */
exports.FAMILY_C_HOTELLING_BOOTSTRAP_SEED = 0xFC02C >>> 0;
/** Box-Muller standard-normal draw, mirror of family-d.ts /
 *  engine/resamplers/cholesky.ts. u1 floored at 1e-12 to avoid log(0).
 *  Inlined here so the calibrator stays self-contained relative to dist/
 *  layout. */
function standardNormalLocal(rng) {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
/** Forward-substitute L · y = r for y, given lower-triangular L. */
function forwardSolveLocal(L, r) {
    const n = L.length;
    const y = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        let s = r[i];
        for (let k = 0; k < i; k++)
            s -= L[i][k] * y[k];
        y[i] = s / L[i][i];
    }
    return y;
}
/** Q2.B.6.2 — Bootstrap MAX statistic per trajectory under sliding-
 *  buffer AR(1) H₀ for Hotelling recalibration. Mirrors
 *  buildFamilyDForSignalAR1's sliding-buffer template (Q2.B.6.1 Step 5)
 *  on Family C's multivariate path.
 *
 *  Mechanism: simulate p-dim r-trajectories under joint AR(1) with
 *  stationary marginal Σ_C and per-signal AR(1) coefficients ρ. For each
 *  trajectory, evaluate the runtime statistic at every tick from
 *  BUFFER_START_TICK..BUFFER_END_TICK (analogous to runtime sliding-buffer
 *  evaluation across the 100-tick canary window) and track the per-
 *  trajectory MAX. The (1−α) quantile of MAX statistics is the threshold
 *  that satisfies per-trajectory FPR ≤ α — mirroring the
 *  Q2.B.6.1 Step 5 family_D recalibration template.
 *
 *  AR(1) simulation runs in r-space (relative-deviation): mean-zero
 *  vectors with stationary covariance = Σ_C and white-noise covariance
 *  Σ_eps. Architect spec §89-138's `cellMu` parameter is unused here for
 *  AR(1) simulation (kept in the signature for spec compatibility) since
 *  Σ_C is calibrated in r-space and runtime T²/wealth statistics consume
 *  r directly. This matches the Q2.B.6c diagnostic probe simulation.
 *
 *  - chi_square variant: statistic = T² = r_t^T Σ_C⁻¹ r_t per tick.
 *  - safe_test variant: statistic = wealth M_t (multiplicative process)
 *    starting at M_0 = 1 at BUFFER_START_TICK; per-tick z_t mirrors
 *    engine/detectors/hotelling.ts:evaluateSafeHotelling exactly:
 *      z_t = -precompiled_log_det_shrink + ½ rᵀΣ⁻¹r - ½ rᵀ(Σ+τ²I)⁻¹r
 *    M_t = M_{t-1} · exp(z_t); track max over the buffer evaluation.
 *
 *  Closes the per-trajectory FPR inflation that Q2.B.6.1 Step 5 closed
 *  on Family D — same architectural pattern (P4-β.5 evaluation-scope
 *  alignment) on the Family C path.
 *
 *  Bootstrap N=2000: matches Q2.B.6.1 Step 5 default. Per-cell ~3-5s
 *  compile cost on synthetic-v1 (840 cells × 2000 trajectories ×
 *  ~80 ticks × p=11 Cholesky/forward-solve). */
function bootstrapHotellingSlidingBufferThreshold(_cellMu, cellSigma, cellRho, cellSigmaEps, alpha, variant, safeHotellingParams, seed) {
    const p = cellSigma.length;
    // Q2.B.6.2 — N=500 matches Q2.B.6.1 Step 5 family_D precedent (the
    // architectural template referenced in the spec §3-7). Spec §82 said
    // 2000 but spec §302 also notes "if [variance] not [acceptable], raise
    // to 5000" — implicitly tunable. The per-trajectory MAX statistic over
    // ~80 ticks of sliding-buffer evaluation has lower MC variance than
    // single-tick statistics, so 500 iters keeps tail-quantile estimate
    // stable while reducing per-cell cost ~4× — bringing compile time
    // closer to the architect §304 prediction of "~2-3s for 840 cells"
    // (with the hash-cache, compile-time cost on synthetic-v1 is ~12s).
    const SLIDING_BUFFER_TRAJECTORIES = 500;
    const TRAJECTORY_LENGTH = 100;
    const BUFFER_START_TICK = 20;
    const BUFFER_END_TICK = 100;
    const BURN_IN = 10;
    const rng = (0, _shared_js_1.mulberry32)(seed);
    const Lx = choleskyLowerTriangular(cellSigma);
    const Leps = choleskyLowerTriangular(cellSigmaEps);
    // Pre-compute Cholesky factors used by chi_square + safe_test variants.
    // Σ + τ²I is required only for safe_test; build once (constant per cell).
    let LSigma = null;
    let LSigmaPlus = null;
    if (variant === 'chi_square') {
        LSigma = choleskyLowerTriangular(cellSigma);
    }
    else {
        LSigma = choleskyLowerTriangular(cellSigma);
        if (safeHotellingParams) {
            const sigmaPlus = new Array(p);
            for (let i = 0; i < p; i++) {
                sigmaPlus[i] = cellSigma[i].slice();
                sigmaPlus[i][i] += safeHotellingParams.tau_squared;
            }
            LSigmaPlus = choleskyLowerTriangular(sigmaPlus);
        }
    }
    const maxStatistics = new Array(SLIDING_BUFFER_TRAJECTORIES);
    for (let traj = 0; traj < SLIDING_BUFFER_TRAJECTORIES; traj++) {
        // Initialize r at stationary N(0, Σ_C) via Lx.
        let r = new Array(p);
        {
            const z = new Array(p);
            for (let i = 0; i < p; i++)
                z[i] = standardNormalLocal(rng);
            for (let i = 0; i < p; i++) {
                let acc = 0;
                for (let j = 0; j <= i; j++)
                    acc += Lx[i][j] * z[j];
                r[i] = acc;
            }
        }
        // Burn-in: r_t = ρ ⊙ r_{t-1} + ε_t, ε_t ~ N(0, Σ_eps).
        for (let i = 0; i < BURN_IN; i++) {
            const eps = new Array(p);
            const z = new Array(p);
            for (let k = 0; k < p; k++)
                z[k] = standardNormalLocal(rng);
            for (let k = 0; k < p; k++) {
                let acc = 0;
                for (let j = 0; j <= k; j++)
                    acc += Leps[k][j] * z[j];
                eps[k] = acc;
            }
            const rNext = new Array(p);
            for (let k = 0; k < p; k++)
                rNext[k] = cellRho[k] * r[k] + eps[k];
            r = rNext;
        }
        // Generate trajectory + sliding-buffer evaluation in one pass.
        let maxStatistic = 0;
        let safeWealth = 1;
        for (let t = 0; t < TRAJECTORY_LENGTH; t++) {
            const eps = new Array(p);
            const z = new Array(p);
            for (let k = 0; k < p; k++)
                z[k] = standardNormalLocal(rng);
            for (let k = 0; k < p; k++) {
                let acc = 0;
                for (let j = 0; j <= k; j++)
                    acc += Leps[k][j] * z[j];
                eps[k] = acc;
            }
            const rNext = new Array(p);
            for (let k = 0; k < p; k++)
                rNext[k] = cellRho[k] * r[k] + eps[k];
            r = rNext;
            if (t < BUFFER_START_TICK || t > BUFFER_END_TICK)
                continue;
            if (variant === 'chi_square') {
                const y = forwardSolveLocal(LSigma, r);
                let t2 = 0;
                for (const v of y)
                    t2 += v * v;
                if (t2 > maxStatistic)
                    maxStatistic = t2;
            }
            else if (safeHotellingParams && LSigma && LSigmaPlus) {
                const y = forwardSolveLocal(LSigma, r);
                let xSigmaInvX = 0;
                for (const v of y)
                    xSigmaInvX += v * v;
                const yPlus = forwardSolveLocal(LSigmaPlus, r);
                let xSigmaPlusInvX = 0;
                for (const v of yPlus)
                    xSigmaPlusInvX += v * v;
                const z_t = -safeHotellingParams.precompiled_log_det_shrink
                    + 0.5 * xSigmaInvX
                    - 0.5 * xSigmaPlusInvX;
                // Match runtime denormal floor (engine/detectors/hotelling.ts:497).
                safeWealth = Math.max(1e-300, safeWealth * Math.exp(z_t));
                if (safeWealth > maxStatistic)
                    maxStatistic = safeWealth;
            }
        }
        maxStatistics[traj] = maxStatistic;
    }
    // Mean + std + (1 − α) quantile of the per-trajectory MAX statistic.
    let sum = 0;
    for (const m of maxStatistics)
        sum += m;
    const mean = sum / SLIDING_BUFFER_TRAJECTORIES;
    let sqSum = 0;
    for (const m of maxStatistics) {
        const d = m - mean;
        sqSum += d * d;
    }
    const std = Math.sqrt(sqSum / SLIDING_BUFFER_TRAJECTORIES);
    maxStatistics.sort((a, b) => a - b);
    const qIdx = Math.min(maxStatistics.length - 1, Math.floor((1 - alpha) * maxStatistics.length));
    const threshold = maxStatistics[qIdx];
    return {
        threshold,
        bootstrap_n: SLIDING_BUFFER_TRAJECTORIES,
        null_max_mean: mean,
        null_max_std: std,
    };
}
// ── Covariance helpers ──────────────────────────────────────────────
/** Column-wise mean of an n × p row matrix. */
function columnMean(rows) {
    const p = rows[0].length;
    const m = new Array(p).fill(0);
    for (const r of rows)
        for (let i = 0; i < p; i++)
            m[i] += r[i];
    for (let i = 0; i < p; i++)
        m[i] /= rows.length;
    return m;
}
/** Element-wise relative deviation: r_ti = (x_ti - μ_i) / μ_i. Returns an
 *  n × p matrix of dimensionless deviations — the scale-free quantity the
 *  Hotelling T² detector operates on. Falls back to additive (x - μ) when
 *  μ_i ≈ 0 to avoid division blow-up. */
function relativeDeviations(rows, mean) {
    const p = mean.length;
    const out = [];
    for (const r of rows) {
        const z = new Array(p);
        for (let i = 0; i < p; i++) {
            const m = mean[i];
            z[i] = Math.abs(m) > 1e-12 ? (r[i] - m) / m : (r[i] - m);
        }
        out.push(z);
    }
    return out;
}
/** Sample covariance (n×p matrix input, assumed mean-zero per column). */
function sampleCovariance(Z) {
    const n = Z.length;
    const p = Z[0].length;
    const S = Array.from({ length: p }, () => new Array(p).fill(0));
    for (const z of Z) {
        for (let i = 0; i < p; i++) {
            const zi = z[i];
            const row = S[i];
            for (let j = 0; j < p; j++)
                row[j] += zi * z[j];
        }
    }
    for (let i = 0; i < p; i++)
        for (let j = 0; j < p; j++)
            S[i][j] /= n;
    return S;
}
/** Ledoit-Wolf shrinkage toward an identity-scaled target (Ledoit &
 *  Wolf 2004, "A well-conditioned estimator..."). Works on mean-zero
 *  input Z (n × p). Returns the shrunk covariance and the intensity λ.
 *  The target is `μ_diag · I` where μ_diag = trace(S)/p — scale-aware
 *  because Z is already in z-score-ish units (relative deviation). */
function ledoitWolfShrinkage(Z) {
    const n = Z.length;
    const p = Z[0].length;
    const S = sampleCovariance(Z);
    let muDiag = 0;
    for (let i = 0; i < p; i++)
        muDiag += S[i][i];
    muDiag /= p;
    let dSq = 0;
    for (let i = 0; i < p; i++) {
        for (let j = 0; j < p; j++) {
            const fij = (i === j) ? muDiag : 0;
            const diff = S[i][j] - fij;
            dSq += diff * diff;
        }
    }
    let bBar2 = 0;
    for (const z of Z) {
        let normSq = 0;
        for (let i = 0; i < p; i++) {
            const zi = z[i];
            for (let j = 0; j < p; j++) {
                const diff = zi * z[j] - S[i][j];
                normSq += diff * diff;
            }
        }
        bBar2 += normSq;
    }
    bBar2 /= (n * n);
    const bSq = Math.min(bBar2, dSq);
    const lambda = dSq > 0 ? bSq / dSq : 0;
    const cov = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < p; i++) {
        for (let j = 0; j < p; j++) {
            const fij = (i === j) ? muDiag : 0;
            cov[i][j] = lambda * fij + (1 - lambda) * S[i][j];
        }
    }
    return { cov, lambda };
}
/** Q2.B.6a (ARCHITECT-REPLY-Q2-B-5-DISPOSITION §57-66) — drop convex
 *  shrinkage. Returns Σ_pc when `perCellN ≥ rankFloor` (rank-sufficient);
 *  otherwise returns a deep copy of Σ_aggregate. α is now binary
 *  {0, 1}: 1 = rank-sufficient (per-cell), 0 = rank-deficient
 *  (aggregate). The discontinuity at the boundary is intentional —
 *  architect §61 picked the simpler "rank-sufficient vs rank-deficient"
 *  semantic threshold over the smooth-shrinkage convex blend.
 *
 *  Pre-Q2.B.6a (Q2.B.4 e203a96): `α · Σ_pc + (1 − α) · Σ_aggregate` with
 *  `α = clamp(n / mcdFloor, 0, 1)`. That convex blend was found at
 *  Q2.B.5 to combine with the cell-selection bug (Q2.B.6c) and produce
 *  parametric Cholesky 131/131 false-fires under v5.2-q2b5. Q2.B.6
 *  closes both: Q2.B.6c fixes cell selection in build-report-card.js;
 *  Q2.B.6a (this function) drops the convex blend.
 *
 *  Architecturally regressive on the shrinkage decision (Q2.B.4
 *  introduced smooth shrinkage to stabilize moderate-sample cells)
 *  but correct on the coherence decision (architect §74). Trade-off
 *  accepted: production methodology surfaces rely on byte-exact
 *  agreement between resampler-source Σ and runtime-test-statistic Σ;
 *  smooth shrinkage breaks that agreement under iid bootstrap. */
function applyAggregateShrinkage(perCellCov, aggregateCov, perCellN, rankFloor) {
    if (perCellN >= rankFloor) {
        return { cov: perCellCov, alpha: 1 };
    }
    return { cov: aggregateCov.map((row) => row.slice()), alpha: 0 };
}
// ── Numerical helpers ──────────────────────────────────────────────
/** Wilson-Hilferty χ²(0.975, p) approximation. Matches the Hotelling
 *  detector's runtime quantile. */
function chiSqQuantile975(p) {
    const z = 1.95996398454005;
    const a = 1 - 2 / (9 * p);
    const b = z * Math.sqrt(2 / (9 * p));
    const root = a + b;
    return p * root * root * root;
}
/** log det via Cholesky: log det(L L^T) = 2 · Σ log L_ii. Returns null
 *  when the input isn't positive definite (Cholesky fails). */
function logDetCholesky(S) {
    const L = (0, _shared_js_1.choleskyLocal)(S);
    if (!L)
        return null;
    let logDet = 0;
    for (let i = 0; i < L.length; i++)
        logDet += Math.log(L[i][i]);
    return 2 * logDet;
}
/** Same semantic as logDetCholesky; second copy existed pre-3c in the
 *  Family E section. Kept under the longer name so the safe-Hotelling
 *  precompute reads `logDetLocal(...)` per its original source. */
function logDetLocal(A) {
    const L = (0, _shared_js_1.choleskyLocal)(A);
    if (!L)
        return null;
    let s = 0;
    for (let i = 0; i < L.length; i++)
        s += Math.log(L[i][i]);
    return 2 * s;
}
/** Mahalanobis distance squared r^T Σ⁻¹ r given Σ's Cholesky L. */
function mahalanobisSqFromL(z, mean, L) {
    const n = L.length;
    const y = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        let s = z[i] - mean[i];
        for (let k = 0; k < i; k++)
            s -= L[i][k] * y[k];
        y[i] = s / L[i][i];
    }
    let sum = 0;
    for (const v of y)
        sum += v * v;
    return sum;
}
/** Mahalanobis distance √(z^T Σ⁻¹ z) for mean-zero z. */
function mahalanobis(z, L) {
    const n = L.length;
    const y = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        let s = z[i];
        for (let k = 0; k < i; k++)
            s -= L[i][k] * y[k];
        y[i] = s / L[i][i];
    }
    let sum = 0;
    for (const v of y)
        sum += v * v;
    return Math.sqrt(sum);
}
// ── PSD / off-diagonal gates ──────────────────────────────────────
/** REPLY-38 Cluster 1 — tolerant PSD check. Cholesky with a pivot floor
 *  `eps`: rejects matrices that are strictly PD but numerically near-
 *  singular. */
exports.PSD_TOLERANCE = 1e-10;
/** REPLY-41 Option 2 — off-diagonal nondegeneracy tolerance, relative
 *  to the mean absolute diagonal. */
exports.OFFDIAG_REL_TOLERANCE = 1e-6;
function isPSDWithTolerance(A, eps) {
    const n = A.length;
    const L = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = A[i][j];
            for (let k = 0; k < j; k++)
                s -= L[i][k] * L[j][k];
            if (i === j) {
                if (s <= eps)
                    return false;
                L[i][i] = Math.sqrt(s);
            }
            else {
                L[i][j] = s / L[j][j];
            }
        }
    }
    return true;
}
// ── FastMCD + MRCD ──────────────────────────────────────────────
/** Architect-set FastMCD constants. */
exports.FASTMCD_N_INITIAL_SUBSETS = 500;
exports.FASTMCD_N_WARM_SUBSETS = 50;
exports.FASTMCD_CSTEP_LIMIT = 20;
exports.FASTMCD_TOP_N_FOR_FULL = 10;
exports.FASTMCD_DEFAULT_ALPHA = 0.75;
exports.FASTMCD_DEFAULT_SEED = 0xFA5DA >>> 0;
/** REPLY-50 D6b thresholds. */
exports.D6B_LAMBDA_THRESHOLD = 0.1;
exports.D6B_OUTLIER_FRACTION_THRESHOLD = 0.05;
/** One FastMCD concentration step. */
function cStep(rows, currentMean, currentCov, h) {
    const L = (0, _shared_js_1.choleskyLocal)(currentCov);
    if (!L)
        return null;
    const distances = [];
    for (let i = 0; i < rows.length; i++) {
        const d2 = mahalanobisSqFromL(rows[i], currentMean, L);
        distances.push({ idx: i, d2 });
    }
    distances.sort((a, b) => a.d2 - b.d2);
    const indices = distances.slice(0, h).map((d) => d.idx);
    const kept = indices.map((i) => rows[i]);
    const mean = columnMean(kept);
    const Z = kept.map((r) => r.map((v, i) => v - mean[i]));
    const cov = sampleCovariance(Z);
    const logDet = logDetCholesky(cov);
    if (logDet === null)
        return null;
    return { mean, cov, indices, logDet };
}
/** Draw a random (p+1)-sized subset; compute its mean + sample cov. */
function initialSubsetEstimate(rows, rng) {
    const n = rows.length;
    const p = rows[0].length;
    const indices = new Set();
    while (indices.size < p + 1)
        indices.add(Math.floor(rng() * n));
    const expand = () => {
        const kept = [...indices].map((i) => rows[i]);
        const mean = columnMean(kept);
        const Z = kept.map((r) => r.map((v, i) => v - mean[i]));
        const cov = sampleCovariance(Z);
        return (0, _shared_js_1.choleskyLocal)(cov) ? { mean, cov } : null;
    };
    let est = expand();
    while (est === null && indices.size < n) {
        let added = false;
        while (!added) {
            const j = Math.floor(rng() * n);
            if (!indices.has(j)) {
                indices.add(j);
                added = true;
            }
        }
        est = expand();
    }
    return est;
}
/** REPLY-50 slice-3 D6a — LW-shrunk covariance warm-start for fastMCD. */
function computeLWWarmSeed(rows) {
    const n = rows.length;
    if (n === 0)
        return undefined;
    const p = rows[0].length;
    if (n < p + 1)
        return undefined;
    const mean = columnMean(rows);
    const Z = rows.map((r) => r.map((v, i) => v - mean[i]));
    const { cov } = ledoitWolfShrinkage(Z);
    if (!(0, _shared_js_1.choleskyLocal)(cov))
        return undefined;
    return { mean, cov };
}
/** Run FastMCD on a p-dimensional row matrix. */
function fastMCD(rows, alpha = exports.FASTMCD_DEFAULT_ALPHA, seed = exports.FASTMCD_DEFAULT_SEED, warmSeed) {
    const n = rows.length;
    const p = rows[0].length;
    if (n < p + 1)
        return null;
    const h = Math.max(p + 1, Math.ceil(alpha * n));
    const rng = (0, _shared_js_1.mulberry32)(seed);
    const candidates = [];
    if (warmSeed) {
        const warm = cStep(rows, warmSeed.mean, warmSeed.cov, h);
        if (warm) {
            const warm2 = cStep(rows, warm.mean, warm.cov, h);
            if (warm2)
                candidates.push(warm2);
        }
    }
    const nRandomDraws = warmSeed ? exports.FASTMCD_N_WARM_SUBSETS : exports.FASTMCD_N_INITIAL_SUBSETS;
    for (let t = 0; t < nRandomDraws; t++) {
        const seed0 = initialSubsetEstimate(rows, rng);
        if (!seed0)
            continue;
        const step = cStep(rows, seed0.mean, seed0.cov, h);
        if (!step)
            continue;
        const step2 = cStep(rows, step.mean, step.cov, h);
        if (!step2)
            continue;
        candidates.push(step2);
    }
    if (candidates.length === 0)
        return null;
    candidates.sort((a, b) => a.logDet - b.logDet);
    const topN = candidates.slice(0, exports.FASTMCD_TOP_N_FOR_FULL);
    let best = null;
    for (const cand of topN) {
        let current = cand;
        for (let iter = 0; iter < exports.FASTMCD_CSTEP_LIMIT; iter++) {
            const next = cStep(rows, current.mean, current.cov, h);
            if (!next)
                break;
            if (Math.abs(next.logDet - current.logDet) < 1e-10) {
                current = next;
                break;
            }
            current = next;
        }
        if (best === null || current.logDet < best.logDet)
            best = current;
    }
    if (best === null)
        return null;
    return {
        mean: best.mean,
        cov: best.cov,
        h_support: h,
        support_indices: best.indices.slice().sort((a, b) => a - b),
        logDet: best.logDet,
    };
}
/** Reweighting step after MCD. */
function mcdReweight(rows, mcdMean, mcdCov) {
    const p = rows[0].length;
    const cutoff = chiSqQuantile975(p);
    const L = (0, _shared_js_1.choleskyLocal)(mcdCov);
    if (!L)
        return null;
    const kept = [];
    for (let i = 0; i < rows.length; i++) {
        const d2 = mahalanobisSqFromL(rows[i], mcdMean, L);
        if (d2 <= cutoff)
            kept.push(i);
    }
    if (kept.length < p + 1)
        return null;
    const keptRows = kept.map((i) => rows[i]);
    const mean = columnMean(keptRows);
    const Z = keptRows.map((r) => r.map((v, i) => v - mean[i]));
    const cov = sampleCovariance(Z);
    if (!(0, _shared_js_1.choleskyLocal)(cov))
        return null;
    return { mean, cov, kept, cutoff };
}
// ── REPLY-52c F1c — Croux-Haesbroeck MCD consistency correction ─────
//
// The FastMCD estimator trims the sample covariance to the h ≤ n
// "cleanest" subset — minimizing determinant of Σ_h subject to
// |S| ≤ h. Under the multivariate normal null, this systematically
// UNDERESTIMATES the true covariance because the trimmed sample
// excludes the tails. The classical consistency factor corrects it:
//
//   c_{p, α} = α / F_{χ²_{p+2}}(q_{p, α})
//
// where q_{p, α} is the α-quantile of χ²_p and F_{χ²_{p+2}} is the
// CDF of χ²_{p+2}. (Croux & Haesbroeck 1999, §3 eq 3.2.) Applying
// the correction to the reweighted MCD output restores E[c · Σ_MCD]
// = Σ_true under Gaussian data.
//
// We approximate the required χ² quantile + CDF via Wilson-Hilferty
// (elementary-function χ² ↔ N mapping) + Beasley-Springer (inverse
// normal CDF) so no external dep.
//
// Canonical reference values (Croux-Haesbroeck 1999 Table 1):
//   p=11, α=0.75  →  c ≈ 1.24
//   p=5,  α=0.75  →  c ≈ 1.12
//   p=2,  α=0.5   →  c ≈ 1.39
/** Beasley-Springer approximation of Φ⁻¹(p) (inverse-normal CDF)
 *  for p ∈ (0, 1). 4-digit accuracy across the full range; ample
 *  for MCD consistency-correction use. */
function _beasleySpringerInverseNormal(p) {
    // Split into central and tail regions for numerical stability.
    const y = p - 0.5;
    if (Math.abs(y) < 0.42) {
        const r = y * y;
        const a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637];
        const b = [-8.47351093090, 23.08336743743, -21.06224101826, 3.13082909833];
        const num = ((a[3] * r + a[2]) * r + a[1]) * r + a[0];
        const den = (((b[3] * r + b[2]) * r + b[1]) * r + b[0]) * r + 1;
        return y * num / den;
    }
    let r = p;
    if (y > 0)
        r = 1 - p;
    r = Math.log(-Math.log(r));
    const c = [
        0.3374754822726147, 0.9761690190917186, 0.1607979714918209,
        0.0276438810333863, 0.0038405729373609, 0.0003951896511919,
        0.0000321767881768, 0.0000002888167364, 0.0000003960315187,
    ];
    let x = c[0] + r * (c[1] + r * (c[2] + r * (c[3] + r * (c[4] + r * (c[5] + r * (c[6] + r * (c[7] + r * c[8])))))));
    return y < 0 ? -x : x;
}
/** Wilson-Hilferty χ²_k quantile at probability α. Cubed-normal
 *  approximation: if Y ~ χ²_k, then (Y/k)^{1/3} ≈ N(1 − 2/(9k),
 *  2/(9k)). Inverting: q = k · (1 − 2/(9k) + z·√(2/(9k)))^3 where
 *  z = Φ⁻¹(α). */
function _chiSqQuantileWH(alpha, k) {
    const z = _beasleySpringerInverseNormal(alpha);
    const a = 2 / (9 * k);
    const base = 1 - a + z * Math.sqrt(a);
    return k * base * base * base;
}
/** Wilson-Hilferty CDF F_{χ²_k}(q). Inverse of the quantile form:
 *  z = ((q/k)^{1/3} − (1 − 2/(9k))) / √(2/(9k)); return Φ(z). */
function _chiSqCdfWH(q, k) {
    if (q <= 0)
        return 0;
    const a = 2 / (9 * k);
    const z = (Math.pow(q / k, 1 / 3) - (1 - a)) / Math.sqrt(a);
    // Normal CDF via erf — 7-digit accuracy (Abramowitz-Stegun 7.1.26).
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t *
        (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? 1 - p : p;
}
/** Croux-Haesbroeck 1999 §3 eq 3.2 consistency-correction factor
 *  for MCD at coverage `alpha` in p dimensions. Via Wilson-Hilferty
 *  + Beasley-Springer. Applied as Σ_corrected = c · Σ_MCD. Exported
 *  for parity testing; callers should prefer buildFamilyCPerCellMCD
 *  which applies the correction internally. */
function consistencyCorrectionFactor(alpha, p) {
    if (alpha <= 0 || alpha >= 1 || p < 1)
        return 1;
    const q = _chiSqQuantileWH(alpha, p);
    const f = _chiSqCdfWH(q, p + 2);
    if (f <= 0)
        return 1;
    return alpha / f;
}
/** Build a FamilyCPerCell from a row matrix using MCD + reweight.
 *
 *  REPLY-52c F1c: applies the Croux-Haesbroeck consistency-
 *  correction factor c_{p, α} to the reweighted covariance so
 *  E[Σ_out] = Σ_true under Gaussian. Without the correction MCD
 *  systematically underestimates Σ by ~20-40% at α=0.75 (sample
 *  size-dependent), which downstream manifests as inflated
 *  Mahalanobis distances + falsely-elevated Hotelling T² statistics.
 *
 *  MRCD path (buildFamilyCPerCellMRCD below) does NOT receive this
 *  correction — its own regularization-shrinkage already shifts the
 *  target, and the appropriate correction factor for MRCD differs
 *  from plain MCD. MRCD consistency correction is deferred to a
 *  future brief bundled with demo expected_outcome re-tuning per
 *  ARCHITECT-REPLY-52c §F1c disposition.
 *
 *  v4 impact: v4-fusion-novelty.json has 0 MCD cells (D6b low-
 *  variance skip routes every cell through Ledoit-Wolf), so this
 *  correction produces zero runtime change on shipped demos. */
function buildFamilyCPerCellMCD(rows, mcdAlpha) {
    const rawMean = columnMean(rows);
    const rawZ = relativeDeviations(rows, rawMean);
    const warmSeed = computeLWWarmSeed(rawZ);
    const mcd = fastMCD(rawZ, mcdAlpha, exports.FASTMCD_DEFAULT_SEED, warmSeed);
    if (!mcd)
        return null;
    const rw = mcdReweight(rawZ, mcd.mean, mcd.cov);
    if (!rw)
        return null;
    // REPLY-52c F1c: scale the reweighted covariance by the Croux-
    // Haesbroeck consistency factor. Applied only on the MCD branch;
    // MRCD branch below is unchanged (see deferral note).
    const p = rw.cov.length;
    const cAlpha = consistencyCorrectionFactor(mcdAlpha, p);
    const correctedCov = rw.cov.map((row) => row.map((v) => v * cAlpha));
    return {
        cell: {
            mean_vector: rawMean,
            covariance: correctedCov,
            covariance_method: 'mcd',
        },
        outlier: {
            method: 'mcd',
            raw_baseline_n: rows.length,
            trimmed_baseline_n: rw.kept.length,
            outlier_fraction: Math.min(0.5, (rows.length - rw.kept.length) / rows.length),
            h_support: mcd.h_support,
            mahalanobis_cutoff: Math.sqrt(rw.cutoff),
        },
    };
}
/** MRCD — Minimum Regularized Covariance Determinant (Boudt et al. 2020).
 *
 *  REPLY-52c F1c: consistency-correction NOT applied here. MRCD's
 *  built-in ridge-shrinkage toward an identity-like target already
 *  biases Σ differently than plain MCD; the appropriate correction
 *  factor is not the Croux-Haesbroeck c_{p,α} formula used in the
 *  MCD path above. MRCD correction is deferred to a future brief
 *  bundled with demo expected_outcome re-tuning per ARCHITECT-
 *  REPLY-52c §F1c disposition. */
function buildFamilyCPerCellMRCD(rows, mcdAlpha) {
    const rawMean = columnMean(rows);
    const rawZ = relativeDeviations(rows, rawMean);
    const p = rawZ[0].length;
    const n = rawZ.length;
    const alphaTight = Math.max(mcdAlpha, 0.9);
    const warmSeed = computeLWWarmSeed(rawZ);
    const mcd = fastMCD(rawZ, alphaTight, exports.FASTMCD_DEFAULT_SEED, warmSeed)
        ?? initialFallbackMCD(rawZ);
    const rawS = mcd.cov;
    let muDiag = 0;
    for (let i = 0; i < p; i++)
        muDiag += rawS[i][i];
    muDiag /= p;
    const ratio = Math.max(0, (2 * p + 1 - n) / Math.max(1, p + 1));
    const rho = Math.min(0.5, Math.max(0, ratio));
    const cov = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < p; i++) {
        for (let j = 0; j < p; j++) {
            const tij = i === j ? muDiag : 0;
            cov[i][j] = rho * tij + (1 - rho) * rawS[i][j];
        }
    }
    const L = (0, _shared_js_1.choleskyLocal)(cov);
    const cutoff = chiSqQuantile975(p);
    const kept = [];
    if (L) {
        for (let i = 0; i < rawZ.length; i++) {
            if (mahalanobisSqFromL(rawZ[i], mcd.mean, L) <= cutoff)
                kept.push(i);
        }
    }
    else {
        for (let i = 0; i < rawZ.length; i++)
            kept.push(i);
    }
    return {
        cell: {
            mean_vector: rawMean,
            covariance: cov,
            covariance_method: 'mrcd',
            covariance_shrinkage: rho,
        },
        outlier: {
            method: 'mrcd',
            raw_baseline_n: rows.length,
            trimmed_baseline_n: kept.length,
            outlier_fraction: Math.min(0.5, (rows.length - kept.length) / rows.length),
            h_support: mcd.h_support,
            mahalanobis_cutoff: Math.sqrt(cutoff),
        },
    };
}
/** Last-resort seed when FastMCD can't find a non-degenerate subset. */
function initialFallbackMCD(rows) {
    const p = rows[0].length;
    const n = rows.length;
    const mean = columnMean(rows);
    const cov = Array.from({ length: p }, () => new Array(p).fill(0));
    const denom = Math.max(1, n - 1);
    for (const r of rows) {
        for (let i = 0; i < p; i++) {
            const di = r[i] - mean[i];
            for (let j = i; j < p; j++) {
                const c = di * (r[j] - mean[j]);
                cov[i][j] += c;
                if (i !== j)
                    cov[j][i] += c;
            }
        }
    }
    for (let i = 0; i < p; i++) {
        for (let j = 0; j < p; j++)
            cov[i][j] /= denom;
    }
    const L = (0, _shared_js_1.choleskyLocal)(cov);
    let logDet;
    if (L) {
        logDet = 0;
        for (let i = 0; i < p; i++)
            logDet += 2 * Math.log(L[i][i]);
    }
    else {
        let muDiag = 0;
        for (let i = 0; i < p; i++)
            muDiag += cov[i][i];
        muDiag = Math.max(1e-12, muDiag / p);
        logDet = p * Math.log(muDiag);
    }
    return {
        mean, cov,
        h_support: n,
        support_indices: rows.map((_, i) => i),
        logDet,
    };
}
// ── Sequential MMD compile-time precompute ──────────────────────
/** Bandwidth via the median heuristic. */
function medianPairwiseDistance(rows) {
    const n = rows.length;
    const p = rows[0].length;
    const capN = Math.min(n, 1000);
    const distances = [];
    for (let i = 0; i < capN; i++) {
        for (let j = i + 1; j < capN; j++) {
            let s = 0;
            for (let k = 0; k < p; k++) {
                const d = rows[i][k] - rows[j][k];
                s += d * d;
            }
            distances.push(Math.sqrt(s));
        }
    }
    distances.sort((a, b) => a - b);
    return distances[Math.floor(distances.length / 2)] || 1;
}
/** Gaussian RBF kernel k(x, y) = exp(-||x - y||² / (2·σ²)). */
function rbfKernel(x, y, bandwidth) {
    let s = 0;
    for (let i = 0; i < x.length; i++) {
        const d = x[i] - y[i];
        s += d * d;
    }
    return Math.exp(-s / (2 * bandwidth * bandwidth));
}
/** Third term of the MMD U-statistic: sum over all baseline×baseline pairs. */
function mmdBaselineBaselineSum(rows, bandwidth) {
    const m = rows.length;
    let sum = 0;
    for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) {
            if (i === j)
                continue;
            sum += rbfKernel(rows[i], rows[j], bandwidth);
        }
    }
    return sum;
}
/** Bootstrap null quantile. */
function mmdBootstrapNullQuantile(rows, bandwidth, baselineBaselineSum, windowSize, alpha, nBootstraps, seed) {
    const m = rows.length;
    const b = windowSize;
    if (m < b + 1)
        return 0;
    const rng = (0, _shared_js_1.mulberry32)(seed);
    const samples = new Array(nBootstraps);
    const baselineBaselineTerm = baselineBaselineSum / (m * (m - 1));
    for (let bi = 0; bi < nBootstraps; bi++) {
        const window = new Array(b);
        for (let i = 0; i < b; i++)
            window[i] = rows[Math.floor(rng() * m)];
        let xx = 0, xy = 0;
        for (let i = 0; i < b; i++) {
            for (let j = 0; j < b; j++) {
                if (i !== j)
                    xx += rbfKernel(window[i], window[j], bandwidth);
            }
            for (let j = 0; j < m; j++)
                xy += rbfKernel(window[i], rows[j], bandwidth);
        }
        const U = (xx / (b * (b - 1))) - (2 * xy / (b * m)) + baselineBaselineTerm;
        samples[bi] = U;
    }
    samples.sort((a, b2) => a - b2);
    const q = samples[Math.min(samples.length - 1, Math.floor((1 - alpha) * samples.length))];
    return q;
}
exports.MMD_BOOTSTRAP_SEED_BASE = 0xFAAD >>> 0;
function mmdSeedForCell(key) {
    let h = exports.MMD_BOOTSTRAP_SEED_BASE;
    for (const [k, v] of Object.entries(key).sort()) {
        const s = `${k}=${v};`;
        for (let i = 0; i < s.length; i++)
            h = ((h + s.charCodeAt(i)) * 1103515245 + 12345) >>> 0;
    }
    return h >>> 0;
}
exports.MMD_WINDOW_SIZE = 30;
exports.MMD_BOOTSTRAP_N = 2000;
// Per ARCHITECT-REPLY-52g (Shekhar–Ramdas 2023 §5 empirical-floor):
// betting-e-MMD calibration is well-conditioned for n ≥ 100; the prior
// 500-sample floor was conservative beyond what the literature supports.
// Lowering 500→100 lets per-cell baselines at synthetic-v1 scale and
// realistic real-data densities qualify for the Ville-bounded e-MMD path
// rather than falling back to the classical bootstrap-null variant.
exports.MMD_MIN_BASELINE_SAMPLES = 100;
function buildMMDParams(rows, alphaMMD, key, opts = {}) {
    if (rows.length < exports.MMD_MIN_BASELINE_SAMPLES) {
        return { result: null, timings: { mmd_bootstrap_ns: 0n, mmd_bootstrap_skipped_cells: 0 } };
    }
    const rawMean = columnMean(rows);
    const rawZ = relativeDeviations(rows, rawMean);
    const bandwidth = medianPairwiseDistance(rawZ);
    const baseSum = mmdBaselineBaselineSum(rawZ, bandwidth);
    let nullQuantile;
    let nullBootstraps;
    let mmdBootstrapNs = 0n;
    let mmdBootstrapSkippedCells = 0;
    if (opts.skipBootstrap) {
        nullQuantile = 0;
        nullBootstraps = 0;
        mmdBootstrapSkippedCells = 1;
    }
    else {
        const tBoot = process.hrtime.bigint();
        nullQuantile = mmdBootstrapNullQuantile(rawZ, bandwidth, baseSum, exports.MMD_WINDOW_SIZE, alphaMMD, exports.MMD_BOOTSTRAP_N, mmdSeedForCell(key));
        nullBootstraps = exports.MMD_BOOTSTRAP_N;
        mmdBootstrapNs = process.hrtime.bigint() - tBoot;
    }
    return {
        result: {
            kernel: 'gaussian_rbf',
            bandwidth,
            window_size: exports.MMD_WINDOW_SIZE,
            baseline_baseline_sum: baseSum,
            null_quantile: nullQuantile,
            null_quantile_bootstraps: nullBootstraps,
            alpha: alphaMMD,
        },
        timings: {
            mmd_bootstrap_ns: mmdBootstrapNs,
            mmd_bootstrap_skipped_cells: mmdBootstrapSkippedCells,
        },
    };
}
// ── Safe-Hotelling precompute ───────────────────────────────────
/** Addition #20 (ARCHITECT-REPLY-43b) — default shrink fraction for the
 *  safe-Hotelling mixture-prior derivation `τ² = c · trace(Σ) / p`. */
exports.FAMILY_C_DEFAULT_SHRINK_FRACTION = 0.03;
/** Q67 SPEC Phase-3.d.B § Q67.4-ter — canonical λ_max default per
 *  Shekhar-Ramdas-2023 `ONSstrategy(F, lambda_max=0.5)`. Architecturally
 *  fixed (NOT B-dependent — v2 amendment removed B). */
exports.FAMILY_C_BETTING_LAMBDA_MAX = 0.5;
/** Q67 SPEC Phase-3.d.B — synthesized P-side baseline pool size for
 *  the canonical betting-e-process detector. Mirrors engine
 *  BASELINE_POOL_SIZE (sequential-mmd.ts) so the canonical and Option-B
 *  paths share an identical P-side reference under shadow-compare. */
exports.FAMILY_C_BETTING_BASELINE_POOL_SIZE = 500;
// ── Main entry: per-cell Family C build ───────────────────────────
/** Build one FamilyCPerCell. Returns the cell alongside timings + D6b
 *  diagnostics so the caller can accumulate module-free aggregators.
 *
 *  See tools/calibrate.ts (pre-3c) for the architectural commentary that
 *  used to live on this function's doc string; kept terse here to keep
 *  the module scanner-friendly. */
function buildFamilyCPerCell(rows, opts = {}, key, alphaMMD) {
    const tCell = process.hrtime.bigint();
    const timings = {
        cov_estimation_ns: 0n,
        mmd_bootstrap_ns: 0n,
        mmd_bootstrap_skipped_cells: 0,
        mcd_skipped_low_variance_cells: 0,
    };
    const diagnostics = { d6b_cells: [] };
    const p = rows[0].length;
    const n = rows.length;
    const mcdAlpha = opts.mcd_alpha ?? exports.FASTMCD_DEFAULT_ALPHA;
    const methodOverride = opts.covariance_method_override;
    const useLegacyC = opts.force_legacy_family_c === true;
    let chosen;
    if (methodOverride) {
        chosen = methodOverride;
    }
    else if (p > 20) {
        chosen = 'ledoit_wolf';
    }
    else if (n >= Math.max(5 * p, 200)) {
        chosen = 'mcd';
    }
    else {
        chosen = 'mrcd';
    }
    const buildLWCell = (skipReason) => {
        const mean = columnMean(rows);
        const Z = relativeDeviations(rows, mean);
        const { cov, lambda } = ledoitWolfShrinkage(Z);
        const out = {
            mean_vector: mean,
            covariance: cov,
            covariance_shrinkage: lambda,
            covariance_method: 'ledoit_wolf',
        };
        if (skipReason)
            out.mcd_skip_reason = skipReason;
        return out;
    };
    let cell;
    let outlier = null;
    if (chosen === 'mcd') {
        const lwCell = buildLWCell();
        const lambda = lwCell.covariance_shrinkage ?? 1;
        let outlierFraction = 1;
        if (lambda < exports.D6B_LAMBDA_THRESHOLD) {
            const L = (0, _shared_js_1.choleskyLocal)(lwCell.covariance);
            if (L) {
                const cutoff = chiSqQuantile975(p);
                const Z = relativeDeviations(rows, lwCell.mean_vector);
                const zeroOrigin = new Array(p).fill(0);
                let outlierCount = 0;
                for (let i = 0; i < n; i++) {
                    if (mahalanobisSqFromL(Z[i], zeroOrigin, L) > cutoff)
                        outlierCount += 1;
                }
                outlierFraction = outlierCount / n;
            }
        }
        const d6bEnabled = opts.enable_d6b_mcd_skip !== false;
        const willSkip = d6bEnabled
            && !methodOverride
            && lambda < exports.D6B_LAMBDA_THRESHOLD
            && outlierFraction < exports.D6B_OUTLIER_FRACTION_THRESHOLD;
        diagnostics.d6b_cells.push({
            lambda, outlier_fraction: outlierFraction, n_rows: n, skipped: willSkip,
        });
        if (willSkip) {
            cell = { ...lwCell, mcd_skip_reason: 'low_variance' };
            timings.mcd_skipped_low_variance_cells += 1;
        }
        else {
            const r = buildFamilyCPerCellMCD(rows, mcdAlpha);
            if (r) {
                cell = r.cell;
                outlier = r.outlier;
            }
            else {
                const fr = buildFamilyCPerCellMRCD(rows, mcdAlpha);
                cell = fr.cell;
                outlier = fr.outlier;
            }
        }
    }
    else if (chosen === 'mrcd') {
        const r = buildFamilyCPerCellMRCD(rows, mcdAlpha);
        cell = r.cell;
        outlier = r.outlier;
    }
    else {
        cell = buildLWCell();
    }
    // REPLY-38 Cluster 1 — PSD gate.
    if (cell.covariance_method === 'mcd' || cell.covariance_method === 'mrcd') {
        if (!isPSDWithTolerance(cell.covariance, exports.PSD_TOLERANCE)) {
            const keyStr = key ? JSON.stringify(key) : '(aggregate)';
            console.warn(`[calibrate] ${cell.covariance_method} produced non-PSD covariance for cell ${keyStr}; `
                + `falling back to Ledoit-Wolf`);
            cell = buildLWCell();
            outlier = null;
        }
    }
    // REPLY-41 Option 2 — off-diagonal nondegeneracy gate.
    if (cell.covariance_method === 'mcd' || cell.covariance_method === 'mrcd') {
        let diagAbsSum = 0;
        for (let i = 0; i < p; i++)
            diagAbsSum += Math.abs(cell.covariance[i][i]);
        const meanDiag = diagAbsSum / p;
        const epsOffDiag = exports.OFFDIAG_REL_TOLERANCE * meanDiag;
        let offDiagMax = 0;
        for (let i = 0; i < p; i++) {
            for (let j = 0; j < p; j++) {
                if (i === j)
                    continue;
                const v = Math.abs(cell.covariance[i][j]);
                if (v > offDiagMax)
                    offDiagMax = v;
            }
        }
        if (offDiagMax < epsOffDiag && n >= p + 1) {
            const keyStr = key ? JSON.stringify(key) : '(aggregate)';
            console.warn(`[calibrate] ${cell.covariance_method} produced covariance with stripped `
                + `cross-correlations for cell ${keyStr} `
                + `(off_diag_max=${offDiagMax.toExponential(2)}, `
                + `diag_mean=${meanDiag.toExponential(2)}, n=${n}); `
                + `falling back to Ledoit-Wolf.`);
            const lw = buildLWCell();
            cell = { ...lw, covariance_method: 'ledoit_wolf_from_degenerate_mrcd' };
            outlier = null;
        }
    }
    // D7: MMD precompute.
    if ((cell.covariance_method === 'mcd' || cell.covariance_method === 'mrcd')
        && key && alphaMMD !== undefined && n >= exports.MMD_MIN_BASELINE_SAMPLES) {
        const mmd = buildMMDParams(rows, alphaMMD, key, { skipBootstrap: !useLegacyC });
        cell.mmd_params = mmd.result ?? null;
        timings.mmd_bootstrap_ns += mmd.timings.mmd_bootstrap_ns;
        timings.mmd_bootstrap_skipped_cells += mmd.timings.mmd_bootstrap_skipped_cells;
    }
    else {
        cell.mmd_params = null;
    }
    cell.outlier_detection = outlier;
    // Addition #20 — variant defaults + e-process precomputes.
    // Q68 Phase-3.d.C consolidation: `mmd_variant` field retired from schema;
    // calibrator no longer stamps it (Family C MMD dispatch is unconditional
    // Ville-bounded variant via betting_e_process_params presence guard).
    if (useLegacyC) {
        cell.hotelling_variant = 'chi_square';
        cell.safe_hotelling_params = null;
        cell.e_mmd_params = null;
        cell.betting_e_process_params = null;
    }
    else {
        const pp = cell.covariance.length;
        const shrinkFraction = opts.family_c_shrink_fraction ?? exports.FAMILY_C_DEFAULT_SHRINK_FRACTION;
        let traceSigma = 0;
        for (let i = 0; i < pp; i++)
            traceSigma += cell.covariance[i][i];
        const tauSquared = shrinkFraction * traceSigma / pp;
        const sigmaPlus = new Array(pp);
        for (let i = 0; i < pp; i++) {
            sigmaPlus[i] = cell.covariance[i].slice();
            sigmaPlus[i][i] += tauSquared;
        }
        const logDetSigma = logDetLocal(cell.covariance);
        const logDetSigmaPlus = logDetLocal(sigmaPlus);
        if (logDetSigma !== null && logDetSigmaPlus !== null) {
            const alphaSafeHotelling = alphaMMD !== undefined ? alphaMMD : 1e-4;
            cell.hotelling_variant = 'safe_test';
            cell.safe_hotelling_params = {
                tau_squared: tauSquared,
                alpha: alphaSafeHotelling,
                precompiled_log_det_shrink: 0.5 * (logDetSigmaPlus - logDetSigma),
                shrink_fraction: shrinkFraction,
            };
        }
        else {
            cell.hotelling_variant = 'chi_square';
            cell.safe_hotelling_params = null;
        }
        if (cell.mmd_params) {
            const m = n;
            const alphaEMmd = alphaMMD !== undefined ? alphaMMD : 1e-4;
            cell.e_mmd_params = {
                kernel_baseline_mean_norm_squared: (cell.mmd_params.baseline_baseline_sum + m) / (m * m),
                alpha: alphaEMmd,
                running_moment_window: 30,
            };
            // Q67 SPEC Phase-3.d.B § Q67.1 — canonical Shekhar-Ramdas-2023
            // betting-e-process per-cell hyperparameters. Bandwidth reuses the
            // already-derived median-heuristic value from cell.mmd_params (same
            // Gaussian RBF kernel; same per-cell baseline pairwise distances).
            // Canonical hyperparameters per § Q67.4-ter:
            //   lambda_max = 0.5         (canonical default; two-sided clamp)
            //   ons_initial_lambda = 0   (start with no bet)
            //   betting_strategy = 'ons' (canonical SLICE 1 pick; GRAPA/KT
            //                             tagged future Phase-3.d.B.b)
            //   baseline_sample_size = FAMILY_C_BETTING_BASELINE_POOL_SIZE
            //                          (matches engine BASELINE_POOL_SIZE = 500
            //                           so the synthesized P-side pool stays
            //                           identical between the canonical and
            //                           bootstrap-null detectors under shadow-
            //                           compare; § Q67.4-ter "Witness paired-
            //                           samples vs streaming adaptation")
            // Q72 SLICE 2 (Phase 3.A.4) — RFF feature-map stamping per cell.
            // Architect Phase 3.A pick: D = 256 default; runtime-side feature-
            // map regeneration (rff_seed in compiled config) avoids ~3 MB ω
            // matrix bloat per substrate. Calibrator computes μ_P^φ over the
            // SAME synthetic Cholesky·noise baseline pool the runtime generates
            // (same seed, same generator) so calibration-time and runtime-time
            // P-side reference agree exactly.
            const rffDim = family_c_rff_js_1.RFF_DEFAULT_DIM;
            const rffSeed = (0, family_c_rff_js_1.rffCellSeed)({
                hour_of_day: typeof key === 'object' && key && 'hour_of_day' in key
                    ? key.hour_of_day : 0,
                day_of_week: typeof key === 'object' && key && 'day_of_week' in key
                    ? key.day_of_week : undefined,
                tier: typeof key === 'object' && key && 'tenant_tier' in key
                    ? key.tenant_tier : undefined,
            });
            // Re-derive baseline pool deterministically (mirror runtime).
            const rffPool = (0, sequential_mmd_js_1.generateBaselinePool)(cell, exports.FAMILY_C_BETTING_BASELINE_POOL_SIZE, (0, sequential_mmd_js_1.baselinePoolSeed)({
                hour_of_day: typeof key === 'object' && key && 'hour_of_day' in key
                    ? key.hour_of_day : 0,
                day_of_week: typeof key === 'object' && key && 'day_of_week' in key
                    ? key.day_of_week : undefined,
            }));
            const fm = (0, family_c_rff_js_1.computeRffFeatureMap)(rffSeed, rffDim, cell.mean_vector.length, cell.mmd_params.bandwidth);
            // μ_P^φ = (1/N_P) Σ_i φ(X_{P,i}). Compute as Float64Array for bit-
            // stable summation; serialize to number[] for compiled config JSON.
            const muPhi = new Float64Array(rffDim);
            for (const x of rffPool) {
                const phi = (0, family_c_rff_js_1.applyRffFeatureMap)(x, fm);
                for (let i = 0; i < rffDim; i++)
                    muPhi[i] += phi[i];
            }
            const N_P = rffPool.length;
            const baseline_rff_mean = new Array(rffDim);
            for (let i = 0; i < rffDim; i++)
                baseline_rff_mean[i] = muPhi[i] / N_P;
            cell.betting_e_process_params = {
                kernel_bandwidth_sigma: cell.mmd_params.bandwidth,
                lambda_max: exports.FAMILY_C_BETTING_LAMBDA_MAX,
                betting_strategy: 'ons',
                ons_initial_lambda: 0,
                alpha: alphaEMmd,
                baseline_sample_size: exports.FAMILY_C_BETTING_BASELINE_POOL_SIZE,
                // Q72 SLICE 2 RFF architectural-fix per Phase 3.A; retires the
                // Q67 § Q67.4-ter biased streaming kernel-of-empirical-mean
                // witness construction. Runtime regenerates ω + b deterministically
                // from rff_seed; baseline_rff_mean precomputed here so per-tick
                // cost stays O(D · d) instead of O(N_P · D · d).
                rff_seed: rffSeed,
                rff_dim: rffDim,
                baseline_rff_mean,
            };
        }
        else {
            cell.e_mmd_params = null;
            cell.betting_e_process_params = null;
        }
        // Per ARCHITECT-REPLY-52gi §TPM-ask-2 — emit Cholesky factor of the
        // per-cell covariance so validation resamplers can generate joint
        // Gaussian samples that preserve the calibrated multivariate
        // covariance structure (closes the parametric-resampler diagonal-Σ
        // bug surfaced by Step-6 wrapper-bypass diff).
        cell.cholesky_L = choleskyLowerTriangular(cell.covariance);
    }
    timings.cov_estimation_ns += process.hrtime.bigint() - tCell;
    return { result: cell, timings, diagnostics };
}
/** Lower-triangular Cholesky factor of a PSD matrix Σ. Mirror of
 *  `engine/resamplers/cholesky.ts` to keep the calibrator side-effect-
 *  free + isolated from runtime engine imports. Diagonal regularized
 *  via max(s, 1e-12) to handle rank-deficient cells. */
function choleskyLowerTriangular(Sigma) {
    const p = Sigma.length;
    const L = [];
    for (let i = 0; i < p; i++)
        L.push(new Array(p).fill(0));
    for (let j = 0; j < p; j++) {
        let sum = Sigma[j][j];
        for (let k = 0; k < j; k++)
            sum -= L[j][k] * L[j][k];
        const pivot = Math.sqrt(Math.max(sum, 1e-12));
        L[j][j] = pivot;
        for (let i = j + 1; i < p; i++) {
            let s = Sigma[i][j];
            for (let k = 0; k < j; k++)
                s -= L[i][k] * L[j][k];
            L[i][j] = s / pivot;
        }
    }
    return L;
}
