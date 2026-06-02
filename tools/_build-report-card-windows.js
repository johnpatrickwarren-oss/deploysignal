"use strict";
// tools/_build-report-card-windows.js — healthy-window generators for the
// report-card builder. Split VERBATIM out of build-report-card.js (no
// behavior change). The original `parametricGaussianWindow` (105 lines) is
// decomposed here into <100-line contiguous helpers — `buildGaussianParams`
// (μ/σ reconstruction) and `sampleGaussianTick` (per-tick draw) — whose
// combined logic is byte-for-byte the original body.
Object.defineProperty(exports, "__esModule", { value: true });
const { collectCellRows, lookupCell } = require('./_build-report-card-cell');

// ── Bootstrap canary generator (E3 methodology, REPLY-52d) ─────────
//
// Original bootstrap: block-resample whole runs + scenario-declared
// baseline. Result: bootstrapped observations use GLOBAL-mean baseline,
// but v4 compiled cells carry DIURNAL-specific μ (typical spread ~11%
// vs global mean). Observations land ~11% off cell μ on every signal
// → 11-dim Mahalanobis amplifies → Hotelling T² fires on "healthy"
// windows → 100% FPR artifact.
//
// E3 methodology: bootstrap from the SAME compile-substrate samples
// the cell was compiled from, constrained to a specific cell key.
// Observations auto-match cell μ within finite-sample noise → honest
// H₀ measurement.
//
// Per window:
//   1. Pick a random cell (hour_of_day, day_of_week) that has
//      sufficient samples and a compiled family_C block.
//   2. Filter baseline samples to that cell.
//   3. iid-resample N=windowLength rows.
//   4. Run gate with currentHourOfDay / currentDayOfWeek matching
//      the chosen cell so the compiled-config lookup consults the
//      same μ the bootstrap drew from.

/** E3 bootstrap: iid-resample rows from a specific cell's compile
 *  substrate. Returns a `{ signal_series, cell_key }` trajectory
 *  ready for the gate + a record of which cell to consult. */
function bootstrapHealthyWindow(baseline, cellKey, windowLength, rng) {
    const cellRows = collectCellRows(baseline, cellKey.hour_of_day, cellKey.day_of_week);
    if (cellRows.length === 0) {
        throw new Error(`no baseline samples for cell (${cellKey.hour_of_day}, ${cellKey.day_of_week})`);
    }
    const signals = baseline.manifest.signals;
    const out = {};
    for (const s of signals) out[s] = new Array(windowLength);
    for (let t = 0; t < windowLength; t++) {
        const row = cellRows[Math.floor(rng() * cellRows.length)];
        for (const s of signals) out[s][t] = row[s];
    }
    return { signal_series: out, cell_key: cellKey };
}

// ── Q3 (REPLY-52gf §38-99) parametric Gaussian resampler ──────────
//
// Methodology test: under iid-bootstrap-from-cell-empirical-distribution,
// betting-e-process exhibits residual Ville-bound violation on signals
// with mild distributional asymmetry. Parametric Gaussian H₀ — drawing
// from N(μ_calibration, σ²_calibration) — removes the higher-moment
// structure (skew, heavy tails, ceiling effects) and tests whether the
// detector implementation is Ville-clean given a genuinely-symmetric
// null. Expected outcome ~85% prior: Ville-bounded FPR ≤ 7.5·10⁻⁴.

/** Box-Muller standard-normal draw using two independent uniforms.
 *  Caps u1 at 1·10⁻¹² to avoid log(0); architect-spec verbatim. */
function boxMullerStandard(rng) {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Family C signal vector ordering (parallel to engine/detectors/hotelling.ts
// FAMILY_C_SIGNALS — must stay in lockstep so the Cholesky factor's row/
// column indices align with cell.family_C.mean_vector + covariance).
const FAMILY_C_SIGNALS_ORDER = [
    'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
    'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
    'corpus_delta', 'traffic_pct',
];

/** Reconstruct the per-signal Gaussian parameters used by the parametric
 *  window: the Family-C reconstructed mean vector (Family A μ for
 *  overlapping signals, cell-empirical μ otherwise) and the marginal
 *  {mu, sigma} for non-Family-C signals. Contiguous extract of the
 *  original parametricGaussianWindow setup block — verbatim. */
function buildGaussianParams(signals, cellRows, fa, fc) {
    // Cholesky factor for Family C joint sampling. Mean is reconstructed
    // per signal to keep Family A's calibrated centering (μ_A) for the
    // overlapping signals — Family C's mean_vector under aggregate_fallback
    // may differ from per-cell μ_A by ~15%, which breaks Family A's H₀.
    // For non-Family-A signals, use cell-empirical mean from bundle samples.
    // Σ_C provides the covariance scale around this reconstructed μ.
    const L = fc?.cholesky_L;
    const muReconstructed = new Array(FAMILY_C_SIGNALS_ORDER.length).fill(0);
    for (let i = 0; i < FAMILY_C_SIGNALS_ORDER.length; i++) {
        const s = FAMILY_C_SIGNALS_ORDER[i];
        const ps = fa[s];
        if (ps?.baseline_mean !== undefined) {
            muReconstructed[i] = ps.baseline_mean;
        } else {
            // Cell-empirical mean for Family-C-only signals.
            let sum = 0, n = 0;
            for (const r of cellRows) {
                if (r[s] === undefined) continue;
                sum += r[s]; n++;
            }
            muReconstructed[i] = n > 0 ? sum / n : (fc?.mean_vector?.[i] ?? 0);
        }
    }
    const haveJointFC = Array.isArray(L) &&
        L.length === FAMILY_C_SIGNALS_ORDER.length;
    // Marginal params for non-Family-C signals.
    const marginalParams = {};
    for (const s of signals) {
        if (FAMILY_C_SIGNALS_ORDER.includes(s)) continue;
        const ps = fa[s];
        if (ps?.baseline_mean !== undefined && ps?.baseline_sigma_squared !== undefined) {
            marginalParams[s] = { mu: ps.baseline_mean, sigma: Math.sqrt(Math.max(ps.baseline_sigma_squared, 0)) };
        } else {
            let sum = 0, sumSq = 0, n = 0;
            for (const r of cellRows) {
                if (r[s] === undefined) continue;
                sum += r[s];
                sumSq += r[s] * r[s];
                n++;
            }
            const mu = n > 0 ? sum / n : 0;
            const variance = n > 0 ? Math.max(0, sumSq / n - mu * mu) : 0;
            marginalParams[s] = { mu, sigma: Math.sqrt(variance) };
        }
    }
    return { L, muReconstructed, haveJointFC, marginalParams };
}

/** Draw one tick `t` of the parametric Gaussian window into `out`.
 *  Contiguous extract of the original per-tick loop body — verbatim. */
function sampleGaussianTick(out, t, signals, params, fa, rng) {
    const { L, muReconstructed, haveJointFC, marginalParams } = params;
    if (haveJointFC) {
        // Joint Gaussian respecting Family C's relative-deviation
        // covariance: Σ_C is computed over r = (x − μ)/μ per
        // tools/calibrators/family-c.ts:relativeDeviations. Hotelling
        // runtime (engine/detectors/hotelling.ts:270-275) does the
        // same transform per tick. So the correct sampling map is:
        //   r ~ N(0, Σ_C) via r = L · u, u ~ N(0, I_p)
        //   live_i = μ_i · (1 + r_i)
        // Centering μ uses per-cell Family A μ for overlapping
        // signals + cell-empirical μ for Family-C-only signals (keeps
        // Family A H₀ valid; matches Hotelling's μ if cell has its
        // own per-cell calibration; falls back to architect-acceptable
        // ~15% offset on aggregate_fallback cells).
        const p = FAMILY_C_SIGNALS_ORDER.length;
        const u = new Array(p);
        for (let i = 0; i < p; i++) u[i] = boxMullerStandard(rng);
        for (let i = 0; i < p; i++) {
            let r = 0;
            for (let j = 0; j <= i; j++) r += L[i][j] * u[j];
            const m = muReconstructed[i];
            // Match relativeDeviations fallback semantic: additive when |μ| ≈ 0.
            out[FAMILY_C_SIGNALS_ORDER[i]][t] = Math.abs(m) > 1e-12
                ? m * (1 + r)
                : m + r;
        }
    } else {
        // Fallback: marginal for Family C signals if cholesky_L absent
        // (e.g., v4-and-earlier configs without the §TPM-ask-2 emit).
        for (const s of FAMILY_C_SIGNALS_ORDER) {
            if (!signals.includes(s)) continue;
            const ps = fa[s];
            let mu = 0, sigma = 0;
            if (ps?.baseline_mean !== undefined && ps?.baseline_sigma_squared !== undefined) {
                mu = ps.baseline_mean;
                sigma = Math.sqrt(Math.max(ps.baseline_sigma_squared, 0));
            }
            out[s][t] = mu + sigma * boxMullerStandard(rng);
        }
    }
    // Non-Family-C signals — independent marginals.
    for (const s of signals) {
        if (FAMILY_C_SIGNALS_ORDER.includes(s)) continue;
        const { mu, sigma } = marginalParams[s];
        out[s][t] = mu + sigma * boxMullerStandard(rng);
    }
}

/** Parametric Gaussian window generator (Q3 mode, Cholesky-correct).
 *  Per ARCHITECT-REPLY-52gi §TPM-ask-2 (2026-04-26): draws joint Gaussian
 *  samples for the 11-signal Family C subset using `cell.family_C.{
 *  mean_vector, cholesky_L}` so the joint distribution preserves the
 *  calibrated multivariate covariance structure. Family C Hotelling T²
 *  is calibrated against a NON-diagonal Σ_C; pre-Cholesky resampler used
 *  diagonal Σ which inflated T² firing to 72/131 (55%) on healthy windows
 *  per Step-6 wrapper-bypass diff (commit 6c5c8ff).
 *
 *  Non-Family-C signals (eval_score, tool_success_rate, refusal_rate,
 *  output_len_p50) are drawn independently from Family A per-signal
 *  calibration μ + σ² (post-P1-floor) when available, else from
 *  empirical cell-sample mean+std. These signals don't enter Family C's
 *  Hotelling T² so the diagonal-vs-non-diagonal mismatch doesn't apply.
 */
function parametricGaussianWindow(baseline, cellKey, windowLength, rng, compiledConfig) {
    const signals = baseline.manifest.signals;
    const cellRows = collectCellRows(baseline, cellKey.hour_of_day, cellKey.day_of_week);
    if (cellRows.length === 0) {
        throw new Error(`no baseline samples for cell (${cellKey.hour_of_day}, ${cellKey.day_of_week})`);
    }
    const cell = lookupCell(compiledConfig, cellKey);
    const fa = cell?.family_A?.per_signal ?? {};
    const fc = cell?.family_C;
    const params = buildGaussianParams(signals, cellRows, fa, fc);
    const out = {};
    for (const s of signals) out[s] = new Array(windowLength);
    for (let t = 0; t < windowLength; t++) {
        sampleGaussianTick(out, t, signals, params, fa, rng);
    }
    return { signal_series: out, cell_key: cellKey };
}

/** Mode-aware window generator dispatch. */
function generateHealthyWindow(mode, baseline, cellKey, windowLength, rng, compiledConfig) {
    if (mode === 'parametric_gaussian') {
        return parametricGaussianWindow(baseline, cellKey, windowLength, rng, compiledConfig);
    }
    return bootstrapHealthyWindow(baseline, cellKey, windowLength, rng);
}

module.exports = {
    bootstrapHealthyWindow,
    boxMullerStandard,
    FAMILY_C_SIGNALS_ORDER,
    parametricGaussianWindow,
    generateHealthyWindow,
};
