"use strict";
// tools/_build-report-card-sweeps.js — FPR calibration sweep + per-profile
// injection sweep for the report-card builder. Split VERBATIM out of
// build-report-card.js (no behavior change). The original `runFprSweep`
// (159 lines) is decomposed into contiguous <100-line helpers:
// `initFprAccumulators` (counter/attribution setup), the per-window loop in
// `runFprSweep` itself, and `buildFprResult` (the return-object assembly).
// Logic is byte-for-byte the original.
Object.defineProperty(exports, "__esModule", { value: true });
const { mulberry32 } = require('./_build-report-card-io');
const {
    collectCellRows, listPopulatedCells, cellMeanFromRows,
} = require('./_build-report-card-cell');
const { generateHealthyWindow } = require('./_build-report-card-windows');
const {
    buildScenario, runGateOverTrajectory, classifyFiringId,
    ALPHA_SPENDING_FAMILIES, ALPHA_VILLE, ALPHA_CLASSICAL,
} = require('./_build-report-card-gate');
const { injectRegression } = require('./inject-regression');

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

/** Initialize the mutable accumulators for the FPR sweep. Contiguous
 *  extract of the original runFprSweep setup block — verbatim. */
function initFprAccumulators() {
    return {
        villeFp: 0,
        classicalFp: 0,
        familyBTrip: 0,
        perCellVilleFires: new Map(),
        perCellClassicalFires: new Map(),
        perCellFamilyBTrips: new Map(),
        windowsByCategory: Object.fromEntries(
            ATTRIBUTION_CATEGORIES.map((c) => [c, 0])),
        // Per-detector-id raw event counts (sums duplicates; e.g. a window
        // that fires family_A_betting on 3 signals contributes 3 events).
        eventsByDetectorId: new Map(),
        // Per-cell breakdown — for any window that fired anything, what
        // category fired and at which cell. Useful for "any attributions
        // that surprise" per session ask.
        perCellByCategory: Object.fromEntries(
            ATTRIBUTION_CATEGORIES.map((c) => [c, new Map()])),
        totalWindowsFired: 0,
    };
}

/** Assemble the FPR-sweep result object. Contiguous extract of the
 *  original runFprSweep return block — verbatim. */
function buildFprResult(acc, args, alphaTotal, cells, villeRate, classicalRate, familyBTripRate) {
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
            fp_count: acc.villeFp,
            fpr: villeRate,
            empirical_vs_ville_bound_ratio: ALPHA_VILLE > 0 ? villeRate / ALPHA_VILLE : 0,
            per_cell_fires: Object.fromEntries(acc.perCellVilleFires),
        },
        fpr_classical_epoch: {
            alpha_classical_bound: ALPHA_CLASSICAL,
            acceptance_bound_empirical: 1.5 * ALPHA_CLASSICAL,
            fp_count: acc.classicalFp,
            fpr: classicalRate,
            empirical_vs_classical_bound_ratio: ALPHA_CLASSICAL > 0 ? classicalRate / ALPHA_CLASSICAL : 0,
            per_cell_fires: Object.fromEntries(acc.perCellClassicalFires),
            methodology_note: 'Classical-epoch-α detectors (Page-CUSUM ' +
                'reset-at-zero, MMD bootstrap-null fallback) have per-deploy ' +
                'Bonferroni-corrected α bounds via excursion theory; NOT ' +
                'time-uniform Ville-bounded. iid-bootstrap amplifies these ' +
                'non-anytime-valid detectors\' false-fires beyond production ' +
                'correlated-signal distribution. Report includes iid-bootstrap-' +
                'methodology-specific trip rates; production FPR expected ' +
                'substantially lower.',
        },
        family_b_trip_count: acc.familyBTrip,
        family_b_trip_rate_diagnostic: familyBTripRate,
        family_b_trip_rate_note: 'Family B is absolute-threshold ' +
            'structural (non-α-consuming per R2 architectural ' +
            'disposition). Trip rate under iid bootstrap reflects ' +
            'joint-distribution breakage of the bootstrap ' +
            'methodology; not a production false-fire rate projection.',
        per_cell_family_b_trips: Object.fromEntries(acc.perCellFamilyBTrips),
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
            windows_fired_total: acc.totalWindowsFired,
            counts: { ...acc.windowsByCategory },
            per_cell_breakdown: Object.fromEntries(
                ATTRIBUTION_CATEGORIES.map((c) => [
                    c, Object.fromEntries(acc.perCellByCategory[c]),
                ]).filter(([, m]) => Object.keys(m).length > 0)),
        },
        firing_events_by_detector_id: Object.fromEntries(acc.eventsByDetectorId),
    };
}

function runFprSweep(baseline, _unusedScenario, compiledConfig, args, alphaTotal) {
    const rng = mulberry32(args.seed);
    const cells = listPopulatedCells(baseline, 20);
    if (cells.length === 0) {
        throw new Error('no populated cells; baseline lacks hour_of_day/day_of_week metadata');
    }
    const signals = baseline.manifest.signals;
    const acc = initFprAccumulators();
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
            acc.eventsByDetectorId.set(id, (acc.eventsByDetectorId.get(id) ?? 0) + 1);
        }
        if (categoriesFiredThisWindow.size > 0) acc.totalWindowsFired++;
        for (const cat of categoriesFiredThisWindow) {
            acc.windowsByCategory[cat]++;
            const m = acc.perCellByCategory[cat];
            m.set(key, (m.get(key) ?? 0) + 1);
        }
        if (villeFired) {
            acc.villeFp++;
            acc.perCellVilleFires.set(key, (acc.perCellVilleFires.get(key) ?? 0) + 1);
        }
        if (classicalFired) {
            acc.classicalFp++;
            acc.perCellClassicalFires.set(key, (acc.perCellClassicalFires.get(key) ?? 0) + 1);
        }
        if (bFired) {
            acc.familyBTrip++;
            acc.perCellFamilyBTrips.set(key, (acc.perCellFamilyBTrips.get(key) ?? 0) + 1);
        }
    }
    const villeRate = acc.villeFp / args.healthyWindows;
    const classicalRate = acc.classicalFp / args.healthyWindows;
    const familyBTripRate = acc.familyBTrip / args.healthyWindows;
    return buildFprResult(acc, args, alphaTotal, cells, villeRate, classicalRate, familyBTripRate);
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
        (0, injectRegression)(traj, profile, args.injectionTick);
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

module.exports = {
    runFprSweep,
    runProfileSweep,
};
