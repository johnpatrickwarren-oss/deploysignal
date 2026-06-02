"use strict";
// tools/_build-report-card-gate.js — scenario shell, gate-over-trajectory
// runner, and firing-id classification for the report-card builder. Split
// VERBATIM out of build-report-card.js (no behavior change). The engine
// bindings (orchestrate / TrendBuffer) are imported here the same way the
// entry script imported them (via ../shared), keeping the production gate
// shapes.
Object.defineProperty(exports, "__esModule", { value: true });
const { lookupCell } = require('./_build-report-card-cell');
// shared.js bridges to the compiled engine under dist/engine/. Same import
// surface the tests use so orchestrate / TrendBuffer are the production
// shapes without a direct dist/ dependency in this tool.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

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

// U2+U4 (REPLY-52g): per-component α budgets. α_total = α_ville + α_classical = 8e-4.
// α_ville ≈ 5e-4 union over A-betting + C-safe + C-mmd-betting + D + E (anytime-valid).
// α_classical ≈ 3e-4 union over A-page-cusum + C-mmd-bootstrap-null (per-deploy Bonferroni).
const ALPHA_VILLE = 5e-4;
const ALPHA_CLASSICAL = 3e-4;

module.exports = {
    buildScenario,
    extractFiring,
    runGateOverTrajectory,
    ALPHA_SPENDING_FAMILIES,
    classifyFiringId,
    ALPHA_VILLE,
    ALPHA_CLASSICAL,
};
