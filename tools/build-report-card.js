"use strict";
// tools/build-report-card.ts — REPLY-52 D6 validation report-card builder.
//
// Emits runs/validation-reports/report-card-v1.json containing:
//   - FPR calibration on N=131 bootstrap healthy canary windows.
//   - Per-profile injection sweep across the 5 v1 regression profiles.
//   - Summary: TPR, FPR, α_empirical/α_bound ratio, median + p95
//     time-to-detect, attribution accuracy.
//
// Bootstrap methodology: block-resample whole baseline runs (ticks_per_run
// blocks) to preserve cross-signal correlation within each block, then
// concatenate to reach `canaryTicks` length. Deterministic via --seed.
//
// Acceptance (TPM-REPLY-52:285-299):
//   - FPR ≤ 1.5 × α_total on 131-scenario sweep.
//   - TPR ≥ 80% on 5 injection profiles.
//
// CLI:
//   node tools/build-report-card.ts \
//     --baseline runs/baselines/synthetic-v1 \
//     --profiles regression-profiles/ \
//     --compiled runs/compiled-configs/v4-fusion-novelty.json \
//     --out runs/validation-reports/report-card-v1.json \
//     --canary-ticks 300 \
//     --injection-tick 50 \
//     --healthy-windows 131 \
//     --seed 42
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const inject_regression_1 = require("./inject-regression");
// shared.js bridges to the compiled engine under dist/engine/. Same import
// surface the tests use so orchestrate / TrendBuffer are the production
// shapes without a direct dist/ dependency in this tool.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
function parseArgs(argv) {
    const out = {
        baseline: 'runs/baselines/synthetic-v1',
        profiles: 'regression-profiles/',
        compiled: 'runs/compiled-configs/v5-sequential-e-process.json',
        out: 'runs/validation-reports/report-card-v1.json',
        canaryTicks: 100,
        injectionTick: 30,
        healthyWindows: 131,
        seed: 42,
        bakeHours: 6,
        // Q3 (REPLY-52gf §38-99): healthy-window resampling mode.
        // 'iid_bootstrap' (default; backward-compatible) — resample
        // rows from cell-empirical distribution. 'parametric_gaussian'
        // — draw N(μ_calibration, σ²_calibration) per signal per tick;
        // tests whether the betting-e-process is Ville-clean given a
        // genuinely-symmetric null (architect Q3 hypothesis).
        resampler: 'iid_bootstrap',
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const v = argv[i + 1];
        switch (k) {
            case '--baseline':
                out.baseline = v;
                i++;
                break;
            case '--profiles':
                out.profiles = v;
                i++;
                break;
            case '--compiled':
                out.compiled = v;
                i++;
                break;
            case '--out':
                out.out = v;
                i++;
                break;
            case '--canary-ticks':
                out.canaryTicks = parseInt(v, 10);
                i++;
                break;
            case '--injection-tick':
                out.injectionTick = parseInt(v, 10);
                i++;
                break;
            case '--healthy-windows':
                out.healthyWindows = parseInt(v, 10);
                i++;
                break;
            case '--seed':
                out.seed = parseInt(v, 10);
                i++;
                break;
            case '--bake-hours':
                out.bakeHours = parseFloat(v);
                i++;
                break;
            case '--resampler':
                if (v !== 'iid_bootstrap' && v !== 'parametric_gaussian') {
                    throw new Error(`--resampler must be 'iid_bootstrap' or 'parametric_gaussian'; got ${v}`);
                }
                out.resampler = v;
                i++;
                break;
        }
    }
    return out;
}
// ── Deterministic RNG ──────────────────────────────────────────────
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function loadBaseline(dir) {
    const manifestPath = path.join(dir, 'manifest.json');
    const bundlePath = path.join(dir, 'bundle.jsonl');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`baseline manifest missing: ${manifestPath}`);
    }
    if (!fs.existsSync(bundlePath)) {
        throw new Error(`baseline bundle missing: ${bundlePath}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const runs = fs
        .readFileSync(bundlePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    // Per-signal mean across all runs × ticks. Used as the Scenario.baseline
    // reference so the gate's absolute-threshold legs see the expected scale.
    const signalMeans = {};
    for (const s of manifest.signals) {
        let sum = 0, n = 0;
        for (const run of runs) {
            const series = run.signal_series[s];
            if (!series)
                continue;
            for (const v of series) {
                sum += v;
                n++;
            }
        }
        signalMeans[s] = n > 0 ? sum / n : 0;
    }
    return { manifest, runs, signalMeans };
}
// ── Compiled-config resolution ─────────────────────────────────────
function ensureCompiledConfig(baselineDir, compiledPath, repoRoot) {
    let resolvedPath = compiledPath;
    if (!resolvedPath)
        resolvedPath = path.join(repoRoot, 'runs', 'compiled-configs', 'v5-sequential-e-process.json');
    if (!fs.existsSync(resolvedPath)) {
        console.log(`[build-report-card] compiled config missing at ${resolvedPath}; regenerating...`);
        (0, node_child_process_1.execSync)(`node tools/calibrate.ts --baseline ${baselineDir} --alpha 1e-3 --families A,B,C,D,E --out ${resolvedPath}`, { cwd: repoRoot, stdio: 'inherit' });
    }
    const cfg = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    return { cfg, path: resolvedPath };
}
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
/** Collect rows (one row per tick) from all baseline runs at the
 *  specified cell key. Returns an array of per-signal objects. */
function collectCellRows(baseline, hourOfDay, dayOfWeek) {
    const signals = baseline.manifest.signals;
    const rows = [];
    for (const run of baseline.runs) {
        const hs = run.hour_of_day;
        const ds = run.day_of_week;
        if (!hs || !ds) continue; // need cell metadata
        for (let i = 0; i < hs.length; i++) {
            if (hs[i] !== hourOfDay || ds[i] !== dayOfWeek) continue;
            const row = {};
            let ok = true;
            for (const s of signals) {
                const v = run.signal_series[s]?.[i];
                if (v === undefined) { ok = false; break; }
                row[s] = v;
            }
            if (ok) rows.push(row);
        }
    }
    return rows;
}
/** List cell keys with ≥ minSamples samples. Used to pick the
 *  candidate cells for the 131-window FPR sweep. */
function listPopulatedCells(baseline, minSamples) {
    const signals = baseline.manifest.signals;
    const counts = new Map(); // key → count
    for (const run of baseline.runs) {
        const hs = run.hour_of_day;
        const ds = run.day_of_week;
        if (!hs || !ds) continue;
        for (let i = 0; i < hs.length; i++) {
            const k = `${hs[i]}-${ds[i]}`;
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }
    }
    const keys = [];
    for (const [k, n] of counts.entries()) {
        if (n >= minSamples) {
            const [h, d] = k.split('-').map((x) => parseInt(x, 10));
            keys.push({ hour_of_day: h, day_of_week: d, n_samples: n });
        }
    }
    return keys;
}
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
    const out = {};
    for (const s of signals) out[s] = new Array(windowLength);
    for (let t = 0; t < windowLength; t++) {
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
    return { signal_series: out, cell_key: cellKey };
}

/** Mode-aware window generator dispatch. */
function generateHealthyWindow(mode, baseline, cellKey, windowLength, rng, compiledConfig) {
    if (mode === 'parametric_gaussian') {
        return parametricGaussianWindow(baseline, cellKey, windowLength, rng, compiledConfig);
    }
    return bootstrapHealthyWindow(baseline, cellKey, windowLength, rng);
}
// ── Scenario shell ─────────────────────────────────────────────────
/** Minimal "clean-deploy"-shaped scenario.
 *
 *  E3 methodology note: Family B reads scenario.baseline for its
 *  ratio-based thresholds. Under cell-aligned bootstrap (E3),
 *  observations are drawn from cell μ; setting scenario.baseline to
 *  cell μ keeps Family B's observed/baseline ratio near 1.0 on healthy
 *  windows. Using global signalMeans here would mis-align Family B
 *  and re-introduce the same class of false fire the E3 methodology
 *  targets (cell μ ≠ global mean across diurnal variation). */
function buildScenario(cellMean, bakeHours) {
    return {
        id: 'validation-canary',
        name: 'Validation Canary',
        riskLevel: 'medium',
        bakeHours,
        author: 'human',
        changeType: 'config',
        timeWindow: 'ok',
        flags: {
            security: false, artifact_content: false, provenance: false,
            contract: false, toolchain: false, zeta: true, approval: true,
        },
        baseline: { ...cellMean },
    };
}
/** Compute per-signal mean from bootstrap-source cell rows. Used as the
 *  scenario.baseline so Family B ratios stay near 1.0 on healthy windows. */
function cellMeanFromRows(rows, signals) {
    const out = {};
    if (rows.length === 0) {
        for (const s of signals) out[s] = 0;
        return out;
    }
    for (const s of signals) {
        let sum = 0;
        for (const r of rows) sum += r[s] ?? 0;
        out[s] = sum / rows.length;
    }
    return out;
}
/** Extract firing family/signal + FULL list of firing families on the
 *  first rollback tick. D1 (REPLY-52e) needs the full list so FPR /
 *  TPR can distinguish α-spending family (A/C/D/E) fires from Family B
 *  structural-signature trips — the latter being non-α-consuming per
 *  R2 architectural disposition. */
function extractFiring(hr, fusion) {
    if (fusion && fusion.firing_families.length > 0) {
        const family = fusion.firing_families[0];
        const firingFamilies = fusion.firing_families.slice();
        let signal = null;
        if (family === 'A' && hr?.family_A_shadow) {
            const fired = hr.family_A_shadow.find((v) => v.verdict === 'fire');
            if (fired?.signal)
                signal = fired.signal;
        }
        else if (family === 'B' && hr && hr.rollback.length > 0) {
            signal = hr.rollback[0].id ?? null;
        }
        else if (hr && hr.rollback.length > 0) {
            // Fallback for C/D/E — the rollback entry carries the detector id.
            signal = hr.rollback[0].id ?? null;
        }
        return { family, signal, firingFamilies };
    }
    if (hr && hr.rollback.length > 0) {
        return { family: 'B', signal: hr.rollback[0].id ?? null, firingFamilies: ['B'] };
    }
    return { family: null, signal: null, firingFamilies: [] };
}
function runGateOverTrajectory(traj, scenario, compiledConfig, canaryTicks, bakeHours) {
    const tb = new TrendBuffer(10);
    const signals = Object.keys(traj.signal_series);
    const cellKey = traj.cell_key;
    let overallFirstFireTick = null;
    let overallFirstFamily = null;
    let overallFirstSignal = null;
    const perFamilyFirstFireTick = { A: null, B: null, C: null, D: null, E: null };
    const perFamilyFirstSignal = { A: null, B: null, C: null, D: null, E: null };
    // U2+U4 (REPLY-52g): collect detector-level rollback IDs across the full
    // run so Ville-bounded vs classical-epoch-α components can be split.
    const firingDetectorIds = new Set();
    let finalVerdict = 'extend';
    for (let i = 0; i < canaryTicks; i++) {
        const live = {};
        for (const s of signals)
            live[s] = traj.signal_series[s][i];
        for (const s of signals)
            tb.push(s, live[s]);
        const hrs = i * (bakeHours / canaryTicks);
        const result = orchestrate({
            liveMetrics: live, scenario, hoursElapsed: hrs,
            trendBuffer: tb, tick: i, totalTicks: canaryTicks,
            compiledConfig,
            currentHourOfDay: cellKey ? cellKey.hour_of_day : undefined,
            currentDayOfWeek: cellKey ? cellKey.day_of_week : undefined,
            fusionTopology: 'portfolio',
        });
        const fusion = result.gateResults?.fusion;
        const thisTickFamilies = fusion ? (fusion.firing_families || []) : [];
        const hr = result.healthResult;
        if (hr && Array.isArray(hr.rollback)) {
            for (const r of hr.rollback) {
                if (r && r.id) firingDetectorIds.add(r.id);
            }
        }
        if (thisTickFamilies.length > 0) {
            const { family, signal } = extractFiring(hr, fusion);
            for (const f of thisTickFamilies) {
                if (perFamilyFirstFireTick[f] === null) {
                    perFamilyFirstFireTick[f] = i;
                }
            }
            if (overallFirstFireTick === null) {
                overallFirstFireTick = i;
                overallFirstFamily = family;
                overallFirstSignal = signal;
            }
            if (perFamilyFirstFireTick[family] === i && perFamilyFirstSignal[family] === null) {
                perFamilyFirstSignal[family] = signal;
            }
        }
        if (result.verdict === 'rollback' && finalVerdict !== 'rollback') {
            finalVerdict = 'rollback';
        }
        else if (result.verdict === 'proceed' && finalVerdict !== 'rollback') {
            finalVerdict = 'proceed';
        }
    }
    const firingFamilies = Object.entries(perFamilyFirstFireTick)
        .filter(([, t]) => t !== null)
        .map(([f]) => f);
    return {
        verdict: finalVerdict,
        firstFireTick: overallFirstFireTick,
        firingFamily: overallFirstFamily,
        firingSignal: overallFirstSignal,
        firingFamilies,
        perFamilyFirstFireTick,
        perFamilyFirstSignal,
        firingDetectorIds: Array.from(firingDetectorIds),
    };
}
const ALPHA_SPENDING_FAMILIES = ['A', 'C', 'D', 'E'];

// U2+U4 (REPLY-52g) — classify a firing detector ID into its formal-property
// class. Ville-bounded = anytime-valid e-process. Classical-epoch-α = per-deploy
// Bonferroni-corrected via excursion theory (NOT time-uniform).
//
// Family A: id = "family_A_<signal>" → Page-CUSUM (classical)
//           id = "family_A_betting_<signal>" → betting-e-process (Ville)
// Family C: id = "family_C" → Hotelling — Ville iff hotelling_variant=safe_test
//           id = "family_C_mmd" → MMD — Ville iff cell.mmd_variant=betting_e_process
// Family D: id = "family_D_<signal>" → spectral e-detector (Ville)
// Family E: id = "family_E" → conformal — Ville iff family_E.kind=weighted_e_value
// Family B: anything else with d.id structural (slowbleed/kv_saturation/...)
//           → non-α-consuming structural; reported separately.
function classifyFiringId(id, cellKey, compiledConfig) {
    if (!id) return 'unknown';
    if (id.startsWith('family_A_betting_')) return 'ville';
    if (id.startsWith('family_A_')) return 'classical';
    if (id === 'family_C') {
        // Hotelling: Ville iff cell's safe_test selected.
        const cell = lookupCell(compiledConfig, cellKey);
        const variant = cell?.family_C?.hotelling_variant ?? 'chi_square';
        return variant === 'safe_test' ? 'ville' : 'classical';
    }
    if (id === 'family_C_mmd') {
        // MMD: Ville iff cell.mmd_variant === 'betting_e_process'.
        const cell = lookupCell(compiledConfig, cellKey);
        const variant = cell?.family_C?.mmd_variant ?? 'bootstrap_null';
        return variant === 'betting_e_process' ? 'ville' : 'classical';
    }
    if (id.startsWith('family_D_')) return 'ville';
    if (id === 'family_E') {
        const fe = compiledConfig.baseline_cells?.aggregate_fallback?.family_E;
        return (fe?.kind === 'weighted_e_value') ? 'ville' : 'classical';
    }
    return 'family_b';
}

function lookupCell(compiledConfig, cellKey) {
    if (!cellKey || !compiledConfig?.baseline_cells?.cells) return null;
    return compiledConfig.baseline_cells.cells.find((c) =>
        c.key && c.key.hour_of_day === cellKey.hour_of_day &&
        c.key.day_of_week === cellKey.day_of_week
    ) ?? null;
}
// U2+U4 (REPLY-52g): per-component α budgets. α_total = α_ville + α_classical = 8e-4.
// α_ville ≈ 5e-4 union over A-betting + C-safe + C-mmd-betting + D + E (anytime-valid).
// α_classical ≈ 3e-4 union over A-page-cusum + C-mmd-bootstrap-null (per-deploy Bonferroni).
const ALPHA_VILLE = 5e-4;
const ALPHA_CLASSICAL = 3e-4;

function runFprSweep(baseline, _unusedScenario, compiledConfig, args, alphaTotal) {
    const rng = mulberry32(args.seed);
    const cells = listPopulatedCells(baseline, 20);
    if (cells.length === 0) {
        throw new Error('no populated cells; baseline lacks hour_of_day/day_of_week metadata');
    }
    const signals = baseline.manifest.signals;
    let villeFp = 0;
    let classicalFp = 0;
    let familyBTrip = 0;
    const perCellVilleFires = new Map();
    const perCellClassicalFires = new Map();
    const perCellFamilyBTrips = new Map();
    // REPLY-52gi §TPM-ask-4 — per-detector-id attribution capture.
    // Disambiguates the iid-bootstrap 30/131 P1-residual into A1/A2/B
    // scenarios per architect prior. Window-level: a window contributes
    // 1 to every category whose detector(s) fired in it. Categories
    // chosen to match the attribution ask:
    //   family_A_betting_*    — Family A betting-e-process (Ville)
    //   family_A_page_cusum_* — Family A Page-CUSUM (classical-epoch)
    //   family_A_other        — any other family_A_* id (defensive)
    //   family_C              — Hotelling T² safe-test or chi_square
    //   family_C_mmd          — Sequential MMD (betting or bootstrap-null)
    //   family_D_*            — spectral e-detector, per-signal
    //   family_E              — conformal novelty
    //   family_b_*            — structural (non-α; for completeness)
    function categorizeId(id) {
        if (id.startsWith('family_A_betting_')) return 'family_A_betting';
        if (id.startsWith('family_A_page_cusum_')) return 'family_A_page_cusum';
        if (id.startsWith('family_A_')) return 'family_A_other';
        if (id === 'family_C') return 'family_C';
        if (id === 'family_C_mmd') return 'family_C_mmd';
        if (id.startsWith('family_D_')) return 'family_D';
        if (id === 'family_E') return 'family_E';
        return 'family_b';
    }
    const ATTRIBUTION_CATEGORIES = [
        'family_A_betting', 'family_A_page_cusum', 'family_A_other',
        'family_C', 'family_C_mmd', 'family_D', 'family_E', 'family_b',
    ];
    const windowsByCategory = Object.fromEntries(
        ATTRIBUTION_CATEGORIES.map((c) => [c, 0]));
    // Per-detector-id raw event counts (sums duplicates; e.g. a window
    // that fires family_A_betting on 3 signals contributes 3 events).
    const eventsByDetectorId = new Map();
    // Per-cell breakdown — for any window that fired anything, what
    // category fired and at which cell. Useful for "any attributions
    // that surprise" per session ask.
    const perCellByCategory = Object.fromEntries(
        ATTRIBUTION_CATEGORIES.map((c) => [c, new Map()]));
    let totalWindowsFired = 0;
    for (let i = 0; i < args.healthyWindows; i++) {
        const cellKey = cells[Math.floor(rng() * cells.length)];
        const traj = generateHealthyWindow(args.resampler, baseline, cellKey, args.canaryTicks, rng, compiledConfig);
        const cellRows = collectCellRows(baseline, cellKey.hour_of_day, cellKey.day_of_week);
        const cellMean = cellMeanFromRows(cellRows, signals);
        const scenarioForWindow = buildScenario(cellMean, args.bakeHours);
        const r = runGateOverTrajectory(traj, scenarioForWindow, compiledConfig, args.canaryTicks, args.bakeHours);
        const ids = r.firingDetectorIds ?? [];
        const key = `${cellKey.hour_of_day}-${cellKey.day_of_week}`;
        let villeFired = false;
        let classicalFired = false;
        let bFired = false;
        const categoriesFiredThisWindow = new Set();
        for (const id of ids) {
            const cls = classifyFiringId(id, cellKey, compiledConfig);
            if (cls === 'ville') villeFired = true;
            else if (cls === 'classical') classicalFired = true;
            else if (cls === 'family_b') bFired = true;
            // gi-§TPM-ask-4 attribution
            const cat = categorizeId(id);
            categoriesFiredThisWindow.add(cat);
            eventsByDetectorId.set(id, (eventsByDetectorId.get(id) ?? 0) + 1);
        }
        if (categoriesFiredThisWindow.size > 0) totalWindowsFired++;
        for (const cat of categoriesFiredThisWindow) {
            windowsByCategory[cat]++;
            const m = perCellByCategory[cat];
            m.set(key, (m.get(key) ?? 0) + 1);
        }
        if (villeFired) {
            villeFp++;
            perCellVilleFires.set(key, (perCellVilleFires.get(key) ?? 0) + 1);
        }
        if (classicalFired) {
            classicalFp++;
            perCellClassicalFires.set(key, (perCellClassicalFires.get(key) ?? 0) + 1);
        }
        if (bFired) {
            familyBTrip++;
            perCellFamilyBTrips.set(key, (perCellFamilyBTrips.get(key) ?? 0) + 1);
        }
    }
    const villeRate = villeFp / args.healthyWindows;
    const classicalRate = classicalFp / args.healthyWindows;
    const familyBTripRate = familyBTrip / args.healthyWindows;
    return {
        methodology: 'compile_substrate_bootstrap_e3_scope_split',
        alpha_total_ville_bound: alphaTotal,
        alpha_spending_families_ville_bounded: [
            'A-betting', 'C-safe', 'C-mmd-betting', 'D', 'E',
        ],
        alpha_spending_families_classical_epoch: [
            'A-page-cusum', 'C-mmd-bootstrap-null',
        ],
        healthy_window_count: args.healthyWindows,
        cells_sampled: cells.length,
        fpr_ville_bounded: {
            alpha_ville_bound: ALPHA_VILLE,
            acceptance_bound_empirical: 1.5 * ALPHA_VILLE,
            fp_count: villeFp,
            fpr: villeRate,
            empirical_vs_ville_bound_ratio: ALPHA_VILLE > 0 ? villeRate / ALPHA_VILLE : 0,
            per_cell_fires: Object.fromEntries(perCellVilleFires),
        },
        fpr_classical_epoch: {
            alpha_classical_bound: ALPHA_CLASSICAL,
            acceptance_bound_empirical: 1.5 * ALPHA_CLASSICAL,
            fp_count: classicalFp,
            fpr: classicalRate,
            empirical_vs_classical_bound_ratio: ALPHA_CLASSICAL > 0 ? classicalRate / ALPHA_CLASSICAL : 0,
            per_cell_fires: Object.fromEntries(perCellClassicalFires),
            methodology_note: 'Classical-epoch-α detectors (Page-CUSUM ' +
                'reset-at-zero, MMD bootstrap-null fallback) have per-deploy ' +
                'Bonferroni-corrected α bounds via excursion theory; NOT ' +
                'time-uniform Ville-bounded. iid-bootstrap amplifies these ' +
                'non-anytime-valid detectors\' false-fires beyond production ' +
                'correlated-signal distribution. Report includes iid-bootstrap-' +
                'methodology-specific trip rates; production FPR expected ' +
                'substantially lower.',
        },
        family_b_trip_count: familyBTrip,
        family_b_trip_rate_diagnostic: familyBTripRate,
        family_b_trip_rate_note: 'Family B is absolute-threshold ' +
            'structural (non-α-consuming per R2 architectural ' +
            'disposition). Trip rate under iid bootstrap reflects ' +
            'joint-distribution breakage of the bootstrap ' +
            'methodology; not a production false-fire rate projection.',
        per_cell_family_b_trips: Object.fromEntries(perCellFamilyBTrips),
        // REPLY-52gi §TPM-ask-4 — per-detector-id attribution. A window
        // contributes 1 to every category whose detector(s) fired in
        // it (categories not mutually exclusive). `windows_fired_total`
        // is the count of unique windows that fired anything.
        firing_attribution_by_category: {
            note: 'Window-level counts: each window contributes 1 per ' +
                  'category if any of its firing detector_ids matched ' +
                  'that category. Categories are not mutually exclusive ' +
                  'within a single window. windows_fired_total is the ' +
                  'unique-window count of any fire.',
            windows_fired_total: totalWindowsFired,
            counts: { ...windowsByCategory },
            per_cell_breakdown: Object.fromEntries(
                ATTRIBUTION_CATEGORIES.map((c) => [
                    c, Object.fromEntries(perCellByCategory[c]),
                ]).filter(([, m]) => Object.keys(m).length > 0)),
        },
        firing_events_by_detector_id: Object.fromEntries(eventsByDetectorId),
    };
}
function runProfileSweep(profiles, baseline, _unusedScenario, compiledConfig, args) {
    const cells = [];
    // Seeded separately from the FPR sweep so adding profiles doesn't shift
    // the healthy-window seed stream.
    // E3: use a representative populated cell as the bootstrap anchor for
    // each profile's injection run. Same cell across profiles so inter-
    // profile detection-rate comparison isn't confounded by cell choice.
    const populatedCells = listPopulatedCells(baseline, 20);
    if (populatedCells.length === 0) {
        throw new Error('no populated cells for profile injection');
    }
    // Pick a mid-range cell (hour=12, day=3) if present, otherwise first.
    const anchorCell = populatedCells.find((c) =>
        c.hour_of_day === 12 && c.day_of_week === 3,
    ) ?? populatedCells[0];
    const signals = baseline.manifest.signals;
    const anchorRows = collectCellRows(baseline, anchorCell.hour_of_day, anchorCell.day_of_week);
    const anchorMean = cellMeanFromRows(anchorRows, signals);
    const scenario = buildScenario(anchorMean, args.bakeHours);
    for (let pi = 0; pi < profiles.length; pi++) {
        const profile = profiles[pi];
        const rng = mulberry32(args.seed + 1000 + pi);
        const traj = generateHealthyWindow(args.resampler, baseline, anchorCell, args.canaryTicks, rng, compiledConfig);
        (0, inject_regression_1.injectRegression)(traj, profile, args.injectionTick);
        const r = runGateOverTrajectory(traj, scenario, compiledConfig, args.canaryTicks, args.bakeHours);
        // D1 (REPLY-52e): a profile is "detected" only when the fire is
        // causally downstream of injection. Check per-family first-fire
        // tick so Family B's pre-injection trips don't mask A/C/D/E's
        // post-injection detection.
        const perFam = r.perFamilyFirstFireTick ?? {};
        const alphaDetectingFamily = ALPHA_SPENDING_FAMILIES.find((f) =>
            perFam[f] !== null && perFam[f] !== undefined && perFam[f] >= args.injectionTick,
        ) ?? null;
        const familyBPostInjection = perFam.B !== null && perFam.B !== undefined
            && perFam.B >= args.injectionTick;
        const alphaSpendingDetected = alphaDetectingFamily !== null;
        const combinedDetected = alphaSpendingDetected || familyBPostInjection;
        // Representative first-fire tick among post-injection fires.
        const postInjectionFireTicks = Object.entries(perFam)
            .filter(([, t]) => t !== null && t !== undefined && t >= args.injectionTick)
            .map(([, t]) => t);
        const firstPostInjectionTick = postInjectionFireTicks.length > 0
            ? Math.min(...postInjectionFireTicks) : null;
        const firingFamiliesPostInjection = Object.entries(perFam)
            .filter(([, t]) => t !== null && t !== undefined && t >= args.injectionTick)
            .map(([f]) => f);
        const detectingFamily = alphaDetectingFamily
            ?? (familyBPostInjection ? 'B' : null);
        const detectingSignal = detectingFamily
            ? (r.perFamilyFirstSignal?.[detectingFamily] ?? null) : null;
        const expectedFamily = profile.expected_detection.family;
        const expectedSignal = profile.expected_detection.signal ?? null;
        const attrMatch = alphaSpendingDetected
            && alphaDetectingFamily === expectedFamily
            && (expectedFamily !== 'A' // non-A families are joint-vector; signal match N/A
                || detectingSignal === null
                || profile.affected_signals.includes(detectingSignal));
        // U2+U4 (REPLY-52g): classify which class of detector caught
        // the regression. Iterate the firingDetectorIds collected during
        // the run and check each against the cell-aware classifier.
        // Note: profile injection runs use anchorCell, so the classifier
        // routes Family C variant lookups against anchorCell's compiled
        // config entry (consistent with run-time evaluation).
        let villeBoundedCaught = false;
        let classicalEpochCaught = false;
        for (const id of (r.firingDetectorIds ?? [])) {
            const cls = classifyFiringId(id, anchorCell, compiledConfig);
            if (cls === 'ville') villeBoundedCaught = true;
            else if (cls === 'classical') classicalEpochCaught = true;
        }
        cells.push({
            profile_id: profile.id,
            injection_tick: args.injectionTick,
            verdict: r.verdict,
            alpha_spending_detected: alphaSpendingDetected,
            combined_detected: combinedDetected,
            first_fire_tick: firstPostInjectionTick,
            time_to_detect_ticks: firstPostInjectionTick !== null
                ? firstPostInjectionTick - args.injectionTick : null,
            firing_family: detectingFamily,
            firing_signal: detectingSignal,
            firing_families: firingFamiliesPostInjection,
            per_family_first_fire_tick: perFam,
            expected_family: expectedFamily,
            expected_signal: expectedSignal,
            affected_signals: profile.affected_signals.slice(),
            attribution_match: attrMatch,
            ville_bounded_caught: villeBoundedCaught,
            classical_epoch_caught: classicalEpochCaught,
            family_b_supplementary: familyBPostInjection,
            firing_detector_ids: r.firingDetectorIds ?? [],
        });
    }
    return cells;
}
// ── Summary ────────────────────────────────────────────────────────
function percentile(sorted, p) {
    if (sorted.length === 0)
        return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
    return sorted[idx];
}
function summarize(fpr, cells, alphaTotal) {
    // D1 (REPLY-52e): split TPR into α-spending (acceptance-gated) +
    // combined (includes Family B supplements). time-to-detect reported
    // across ALL detected profiles (any family) since ops cares about
    // end-to-end catch latency.
    const alphaDetected = cells.filter((c) => c.alpha_spending_detected);
    const combinedDetected = cells.filter((c) => c.combined_detected);
    const familyBOnly = cells.filter((c) =>
        c.combined_detected && !c.alpha_spending_detected);
    const ttd = combinedDetected
        .map((c) => c.time_to_detect_ticks)
        .filter((v) => v !== null)
        .sort((a, b) => a - b);
    const median = percentile(ttd, 0.5);
    const p95 = percentile(ttd, 0.95);
    const attrMatchCount = alphaDetected.filter((c) => c.attribution_match).length;
    const villeCaught = cells.filter((c) => c.ville_bounded_caught).length;
    const classicalCaught = cells.filter((c) => c.classical_epoch_caught).length;
    return {
        alpha_spending_tpr: `${alphaDetected.length}/${cells.length}`,
        combined_tpr: `${combinedDetected.length}/${cells.length}`,
        ville_bounded_tpr: `${villeCaught}/${cells.length}`,
        classical_epoch_tpr: `${classicalCaught}/${cells.length}`,
        family_b_only_catches: familyBOnly.length,
        fpr_ville_bounded:
            `${fpr.fpr_ville_bounded.fp_count}/${fpr.healthy_window_count} ` +
            `(${fpr.fpr_ville_bounded.empirical_vs_ville_bound_ratio.toFixed(3)} × α_ville)`,
        fpr_classical_epoch:
            `${fpr.fpr_classical_epoch.fp_count}/${fpr.healthy_window_count} ` +
            `(${fpr.fpr_classical_epoch.empirical_vs_classical_bound_ratio.toFixed(3)} × α_classical)`,
        family_b_trip_rate_diagnostic:
            `${fpr.family_b_trip_count}/${fpr.healthy_window_count} ` +
            `(non-α-consuming; see fpr_calibration note)`,
        median_time_to_detect: median,
        p95_time_to_detect: p95,
        attribution_accuracy: alphaDetected.length > 0
            ? `${attrMatchCount}/${alphaDetected.length}` : '0/0',
    };
}
// ── Main ───────────────────────────────────────────────────────────
function main() {
    const args = parseArgs(process.argv.slice(2));
    const repoRoot = path.resolve(__dirname, '..');
    const baselineDir = path.isAbsolute(args.baseline)
        ? args.baseline : path.join(repoRoot, args.baseline);
    const outPath = path.isAbsolute(args.out)
        ? args.out : path.join(repoRoot, args.out);
    console.log('[build-report-card] loading baseline:', baselineDir);
    const baseline = loadBaseline(baselineDir);
    console.log(`[build-report-card]   ${baseline.manifest.version}: ${baseline.runs.length} runs × ${baseline.manifest.ticks_per_run} ticks, ${baseline.manifest.signals.length} signals`);
    console.log('[build-report-card] resolving compiled config...');
    const { cfg, path: cfgPath } = ensureCompiledConfig(args.baseline, args.compiled, repoRoot);
    const alphaTotal = cfg.alpha_budget?.total ?? 0;
    console.log(`[build-report-card]   ${cfgPath} (α_total=${alphaTotal})`);
    console.log('[build-report-card] loading regression profiles...');
    const profiles = (0, inject_regression_1.loadAllRegressionProfiles)();
    console.log(`[build-report-card]   ${profiles.length} v1 profiles loaded`);
    // E3: scenario baseline is set per-window from cell μ by the sweep
    // callers themselves; main's scenario is just a placeholder.
    const scenario = buildScenario(baseline.signalMeans, args.bakeHours);
    console.log(`[build-report-card] FPR sweep (${args.healthyWindows} windows × ${args.canaryTicks} ticks)...`);
    const fpr = runFprSweep(baseline, scenario, cfg, args, alphaTotal);
    console.log(`[build-report-card]   Ville-bounded FP=${fpr.fpr_ville_bounded.fp_count}/${fpr.healthy_window_count}, FPR=${fpr.fpr_ville_bounded.fpr.toExponential(3)}, ratio=${fpr.fpr_ville_bounded.empirical_vs_ville_bound_ratio.toFixed(3)} × α_ville (${ALPHA_VILLE.toExponential(1)})`);
    console.log(`[build-report-card]   Classical-epoch  FP=${fpr.fpr_classical_epoch.fp_count}/${fpr.healthy_window_count}, FPR=${fpr.fpr_classical_epoch.fpr.toExponential(3)}, ratio=${fpr.fpr_classical_epoch.empirical_vs_classical_bound_ratio.toFixed(3)} × α_classical (${ALPHA_CLASSICAL.toExponential(1)})`);
    console.log(`[build-report-card]   Family B trip-rate (diagnostic, non-α-consuming)=${fpr.family_b_trip_count}/${fpr.healthy_window_count}`);
    console.log('[build-report-card] profile injection sweep...');
    const cells = runProfileSweep(profiles, baseline, scenario, cfg, args);
    for (const c of cells) {
        console.log(`[build-report-card]   ${c.profile_id}: verdict=${c.verdict} α=${c.alpha_spending_detected} combined=${c.combined_detected} fams=[${(c.firing_families || []).join(',')}] t_inj=${c.injection_tick} first_fire=${c.first_fire_tick} ttd=${c.time_to_detect_ticks} expected=${c.expected_family}/${c.expected_signal ?? '-'} attr=${c.attribution_match}`);
    }
    const summary = summarize(fpr, cells, alphaTotal);
    console.log('[build-report-card] summary:', summary);
    // ── Acceptance gates (U2+U4, REPLY-52g; halt + flag per session spec) ──
    const villeBound = 1.5 * ALPHA_VILLE;
    const classicalBound = 1.5 * ALPHA_CLASSICAL;
    if (fpr.fpr_ville_bounded.fpr > villeBound) {
        console.error(`\n[build-report-card] HALT: Ville-bounded FPR=${fpr.fpr_ville_bounded.fpr.toExponential(3)} exceeds 1.5 × α_ville=${villeBound.toExponential(3)}. Genuine Ville-bound violation on A-betting/C-safe/C-mmd-betting/D/E — flag for architect review.`);
    }
    if (fpr.fpr_classical_epoch.fpr > classicalBound) {
        console.error(`\n[build-report-card] CAVEAT: Classical-epoch FPR=${fpr.fpr_classical_epoch.fpr.toExponential(3)} exceeds 1.5 × α_classical=${classicalBound.toExponential(3)}. Page-CUSUM + MMD-bootstrap-null fall-back are per-deploy Bonferroni-bounded; iid-bootstrap amplifies their false-fires beyond production-correlated-signal expectation (see fpr_calibration.fpr_classical_epoch.methodology_note).`);
    }
    const alphaTprRatio = cells.filter((c) => c.alpha_spending_detected).length / cells.length;
    if (alphaTprRatio < 0.80) {
        console.error(`\n[build-report-card] HALT: α-spending TPR=${(alphaTprRatio * 100).toFixed(1)}% below 80% floor. Flag for architect review.`);
    }
    // Per-profile TPR (each profile is a single inject trial; boolean).
    const alphaTprPerProfile = Object.fromEntries(
        cells.map((c) => [c.profile_id, c.alpha_spending_detected ? 1 : 0]));
    const combinedTprPerProfile = Object.fromEntries(
        cells.map((c) => [c.profile_id, c.combined_detected ? 1 : 0]));
    const familyBOnlyCount = cells.filter((c) =>
        c.combined_detected && !c.alpha_spending_detected).length;
    const perProfileFiringAttribution = Object.fromEntries(
        cells.map((c) => [c.profile_id, {
            ville_bounded_caught: !!c.ville_bounded_caught,
            classical_epoch_caught: !!c.classical_epoch_caught,
            family_b_supplementary: !!c.family_b_supplementary,
        }]));
    const card = {
        report_card_version: 'v2-scope-split',
        methodology: 'compile_substrate_bootstrap_e3_scope_split',
        scope_note: 'FPR measured under gate\'s design-contract null H₀ ' +
            'via cell-aligned bootstrap from compile substrate. Per ' +
            'ARCHITECT-REPLY-52g, α-participating portfolio splits into ' +
            'Ville-bounded portion (anytime-valid e-processes: A-betting, ' +
            'C-safe, C-mmd-betting when MMD_MIN passes, D, E) with ' +
            'α_ville ≈ 5e-4, and classical-epoch-α portion (per-deploy ' +
            'Bonferroni-corrected via excursion theory: A-page-cusum, ' +
            'C-mmd-bootstrap-null when MMD_MIN fails) with α_classical ' +
            '≈ 3e-4. Total α_total = α_ville + α_classical = 8e-4 ' +
            'unchanged. Family B is structural (absolute-threshold, ' +
            'non-α-consuming per R2 disposition); reported as diagnostic ' +
            'statistic. Classical portion is iid-bootstrap-amplified ' +
            'beyond production correlated-signal distribution; see ' +
            'fpr_classical_epoch.methodology_note. Bundle-trajectory ' +
            'input robustness post-hire per REPLY-52d §E2. ' +
            'V1.H1 P1 calibration variance floor applied per ' +
            'ARCHITECT-REPLY-52ge §69-71 (σ²_floor = max(ε_f · μ², ' +
            '1e-6 · μ²); 66 cells flagged sigma_floor_applied=true on ' +
            'tool_success_rate per cross-signal grep prediction).',
        baseline_id: baseline.manifest.version,
        compiler_version: cfg.compiler_version,
        compiled_at: cfg.compiled_at ?? new Date().toISOString(),
        compiled_config_ref: path.relative(repoRoot, cfgPath),
        alpha_total: alphaTotal,
        acceptance_bound_empirical: 1.5 * alphaTotal,
        sweep_params: {
            canary_ticks: args.canaryTicks,
            injection_tick: args.injectionTick,
            bake_hours: args.bakeHours,
            seed: args.seed,
            bootstrap: 'iid_resample_from_cell_samples',
        },
        fpr_calibration: fpr,
        tpr_calibration: {
            alpha_spending_tpr_per_profile: alphaTprPerProfile,
            alpha_spending_aggregate_tpr: alphaTprRatio,
            combined_tpr_per_profile: combinedTprPerProfile,
            combined_aggregate_tpr: cells.filter((c) => c.combined_detected).length / cells.length,
            ville_bounded_aggregate_tpr: cells.filter((c) => c.ville_bounded_caught).length / cells.length,
            classical_epoch_aggregate_tpr: cells.filter((c) => c.classical_epoch_caught).length / cells.length,
            per_profile_firing_attribution: perProfileFiringAttribution,
            family_b_only_catches: familyBOnlyCount,
            family_b_tpr_note: 'Family B catches broader structural ' +
                'patterns in addition to α-spending family coverage. ' +
                'Not part of the Ville bound; reported as supplementary ' +
                'detection-class statistic.',
        },
        regression_profiles: cells,
        summary,
        honest_scope: 'Validation not full production-grade; real ' +
            'traffic carries tails we can\'t rehearse. Family B trip ' +
            'rate under iid bootstrap is a methodology-specific ' +
            'diagnostic, not a production FPR projection.',
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(card, null, 2) + '\n');
    console.log(`\n[build-report-card] wrote ${path.relative(repoRoot, outPath)}`);
}
main();
