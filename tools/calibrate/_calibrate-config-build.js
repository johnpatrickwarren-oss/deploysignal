"use strict";
// tools/calibrate/_calibrate-config-build.ts — config-assembly phase helpers
// + compile-summary printers for the NS calibration compiler. Logic
// extracted VERBATIM from the pre-split tools/calibrate.ts god-file `main()`
// (D-54-3 god-file decomposition); each helper < 100 lines, preserving exact
// ordering, side effects, deterministic output, and console diagnostics.
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
exports.deriveFamilyBCutoffs = deriveFamilyBCutoffs;
exports.resolveCompileDefaults = resolveCompileDefaults;
exports.applyDemoBaselinePatch = applyDemoBaselinePatch;
exports.allocateAlpha = allocateAlpha;
exports.emitFamilyABlock = emitFamilyABlock;
exports.attachProfileProvenance = attachProfileProvenance;
exports.printCompileSummary = printCompileSummary;
const fs = __importStar(require("node:fs"));
const profile_loader_js_1 = require("../profile-loader.js");
const bundle_loader_js_1 = require("../bundle-loader.js");
const bake_profiles_js_1 = require("../calibrators/bake-profiles.js");
const _calibrate_constants_js_1 = require("./_calibrate-constants.js");
const _calibrate_data_prep_js_1 = require("./_calibrate-data-prep.js");
const _calibrate_aggregator_js_1 = require("./_calibrate-aggregator.js");
/** Family B cutoff derivation — validates the empirical (1 − α) ratio
 *  quantile against the legacy cutoff (±5%) and emits the legacy value
 *  (equivalence by construction). */
function deriveFamilyBCutoffs(bundle, alpha) {
    const cutoffs = {};
    const rawEmpirical = {};
    const toleranceIssues = [];
    for (const name of Object.keys(_calibrate_constants_js_1.LEGACY_CUTOFFS)) {
        const legacy = _calibrate_constants_js_1.LEGACY_CUTOFFS[name];
        const signal = _calibrate_constants_js_1.CUTOFF_SIGNAL[name];
        if (signal === null) {
            // Derived / joint cutoff — nothing to validate empirically. Emit legacy.
            cutoffs[name] = legacy;
            continue;
        }
        const mean = _calibrate_constants_js_1.HEALTHY_MEANS[signal];
        if (mean === undefined)
            throw new Error('No healthy mean defined for signal ' + signal);
        const samples = (0, _calibrate_data_prep_js_1.flattenSignal)(bundle, signal);
        if (samples.length === 0) {
            console.warn(`WARN: no samples for signal ${signal}; emitting legacy ${legacy} without validation`);
            cutoffs[name] = legacy;
            continue;
        }
        const ratios = samples.map((v) => v / mean);
        const q = (0, _calibrate_data_prep_js_1.quantile)(ratios, 1 - alpha);
        rawEmpirical[name] = q;
        const dev = Math.abs(q - legacy) / legacy;
        if (dev > 0.05) {
            toleranceIssues.push({ cutoff: name, legacy, empirical: q, deviation: dev });
        }
        cutoffs[name] = legacy; // emit legacy; equivalence by construction
    }
    return { cutoffs, rawEmpirical, toleranceIssues };
}
/** Addition #28 — resolve optional profile + override layer + cell-dimension
 *  reconciliation. Legacy path (no profile_ref) → effective=null, hardcoded
 *  defaults. Throws on the D5 all-families-disabled invariant. */
function resolveCompileDefaults(args, bundle) {
    let effective = null;
    if (args.profile_ref) {
        const profile = (0, profile_loader_js_1.loadProfile)(args.profile_ref);
        const override = args.customer_override_ref
            ? (0, profile_loader_js_1.loadCustomerOverride)(args.customer_override_ref)
            : null;
        effective = (0, profile_loader_js_1.resolveEffectiveConfig)(profile, override);
        if (Math.abs(args.alpha - effective.alpha_allocation.total) > 1e-12) {
            throw new Error(`--alpha ${args.alpha} does not match profile's alpha_allocation.total `
                + `${effective.alpha_allocation.total} for ${effective.profile_ref}. `
                + `Align either input or pick a profile whose total matches.`);
        }
    }
    const legacyDefaults = {
        family_a_signals: _calibrate_constants_js_1.FAMILY_A_SIGNALS.slice(),
        family_c_signals: _calibrate_constants_js_1.FAMILY_C_SIGNALS.slice(),
        family_a_alpha_fraction: _calibrate_constants_js_1.FAMILY_A_ALPHA_FRACTION,
        family_c_alpha_fraction: _calibrate_constants_js_1.FAMILY_C_ALPHA_FRACTION,
        family_d_alpha_fraction: _calibrate_constants_js_1.FAMILY_D_ALPHA_FRACTION,
        family_e_alpha_fraction: _calibrate_constants_js_1.FAMILY_E_ALPHA_FRACTION,
        alpha_total: args.alpha,
        family_enabled_from_cli: {
            A: args.families.indexOf('A') >= 0,
            B: args.families.indexOf('B') >= 0,
            C: args.families.indexOf('C') >= 0,
            D: args.families.indexOf('D') >= 0,
            E: args.families.indexOf('E') >= 0,
        },
        cell_dimensions_from_bundle: {
            hour_of_day: true,
            day_of_week: bundle.cell_dim === 'hour_of_day_x_day_of_week',
            workload_class: false,
            tenant_tier: false, // populated below once tenantTierMap is resolved
            region: false,
        },
    };
    let compileDefaults = (0, profile_loader_js_1.effectiveOrDefaults)(effective, legacyDefaults);
    const compileWarnings = [];
    if (effective) {
        const bundleMeta = (0, bundle_loader_js_1.loadBundleMetadata)(args.baseline);
        const mode = args.cell_dimension_deficiency_mode ?? 'warn';
        const reconciled = (0, profile_loader_js_1.reconcileCellDimensions)(compileDefaults.cell_dimensions, bundleMeta.available_dimensions, mode);
        compileDefaults = { ...compileDefaults, cell_dimensions: reconciled.cell_dimensions };
        for (const w of reconciled.warnings) {
            compileWarnings.push(w);
            console.warn(`[calibrate] WARN ${w.code}: ${w.message}`);
        }
    }
    if (effective &&
        !compileDefaults.family_enabled.A &&
        !compileDefaults.family_enabled.B &&
        !compileDefaults.family_enabled.C &&
        !compileDefaults.family_enabled.D &&
        !compileDefaults.family_enabled.E) {
        throw new Error(`profile ${effective.profile_ref} disables all detector families `
            + `(joint_vector.include_in_family_c/e + structural_detectors.enabled + `
            + `--families CLI intersection). Compile requires ≥ 1 active family.`);
    }
    return { effective, compileDefaults, compileWarnings };
}
/** Q57 — apply aggregate_fallback_patch from demo baseline file(s). Patches
 *  BOTH baselineCells.aggregate_fallback (per spec) AND the matching
 *  cells[].(target_cell, tier='aggregate') (runtime consumption path). */
function applyDemoBaselinePatch(baselineCells, demoBaselinePatch) {
    const patchPaths = demoBaselinePatch.split(',').map((s) => s.trim()).filter(Boolean);
    for (const patchPath of patchPaths) {
        const patchJson = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
        const aggPatch = patchJson.aggregate_fallback_patch;
        if (!aggPatch)
            continue;
        const targetCell = patchJson.cell_patch?.target_cell;
        // (a) Apply to baselineCells.aggregate_fallback (per spec literal).
        if (aggPatch.family_A_per_signal && baselineCells.aggregate_fallback.family_A?.per_signal) {
            for (const [sig, params] of Object.entries(aggPatch.family_A_per_signal)) {
                const existing = baselineCells.aggregate_fallback.family_A.per_signal[sig];
                if (existing) {
                    baselineCells.aggregate_fallback.family_A.per_signal[sig] = {
                        ...existing,
                        ...params,
                    };
                }
            }
        }
        if (aggPatch.family_C_mean_vector && baselineCells.aggregate_fallback.family_C) {
            baselineCells.aggregate_fallback.family_C.mean_vector =
                aggPatch.family_C_mean_vector.slice();
        }
        // (b) Apply to cells[].(target_cell, tier='aggregate').
        if (targetCell) {
            const targetCells = baselineCells.cells.filter((c) => c.key.hour_of_day === targetCell.hour_of_day &&
                c.key.day_of_week === targetCell.day_of_week &&
                c.key.tenant_tier === 'aggregate');
            for (const cell of targetCells) {
                if (aggPatch.family_A_per_signal && cell.family_A?.per_signal) {
                    for (const [sig, params] of Object.entries(aggPatch.family_A_per_signal)) {
                        const existing = cell.family_A.per_signal[sig];
                        if (existing) {
                            cell.family_A.per_signal[sig] = {
                                ...existing,
                                ...params,
                            };
                        }
                    }
                }
                if (aggPatch.family_C_mean_vector && cell.family_C) {
                    cell.family_C.mean_vector =
                        aggPatch.family_C_mean_vector.slice();
                }
            }
        }
    }
}
/** α allocation — WEEK4-HANDOFF.md §4.1.f: 40/20/20/10/10 when A+C+D+E emit;
 *  leftover goes to B. Profile path reads per_family directly. */
function allocateAlpha(args, effective, emitFamilyA, emitFamilyC, emitFamilyD, emitFamilyE) {
    let alphaA = 0, alphaB = args.alpha, alphaC = 0, alphaD = 0, alphaE = 0;
    if (emitFamilyA) {
        if (effective) {
            alphaA = effective.alpha_allocation.per_family.A;
            alphaC = emitFamilyC ? effective.alpha_allocation.per_family.C : 0;
            alphaD = emitFamilyD ? effective.alpha_allocation.per_family.D : 0;
            alphaE = emitFamilyE ? effective.alpha_allocation.per_family.E : 0;
            alphaB = args.alpha - alphaA - alphaC - alphaD - alphaE;
        }
        else {
            alphaA = args.alpha * _calibrate_constants_js_1.FAMILY_A_ALPHA_FRACTION;
            if (emitFamilyC)
                alphaC = args.alpha * _calibrate_constants_js_1.FAMILY_C_ALPHA_FRACTION;
            if (emitFamilyD)
                alphaD = args.alpha * _calibrate_constants_js_1.FAMILY_D_ALPHA_FRACTION;
            if (emitFamilyE)
                alphaE = args.alpha * _calibrate_constants_js_1.FAMILY_E_ALPHA_FRACTION;
            alphaB = args.alpha - alphaA - alphaC - alphaD - alphaE;
        }
    }
    return { alphaA, alphaB, alphaC, alphaD, alphaE };
}
/** Family A emission block — baseline_cells, bonferroni, bake_profiles,
 *  traffic gate, tenant tier map, and per-signal betting α stamping. */
function emitFamilyABlock(a) {
    const { config, baselineCells, compileDefaults, effective, tenantTierMap, tenantTierConfig, alphaA } = a;
    config.baseline_cells = baselineCells;
    config.bonferroni_factor = compileDefaults.family_a_signals.length;
    const baseBake = (0, bake_profiles_js_1.buildBakeProfiles)();
    if (effective) {
        for (const entry of effective.bake_profiles) {
            baseBake[entry.signal] = {
                min_ticks_before_eligible: entry.min_ticks_before_eligible,
                min_observation_window: entry.min_observation_window,
                max_deploy_window_days: entry.max_deploy_window_days,
            };
        }
    }
    config.bake_profiles = baseBake;
    config.traffic_pct_gate = { min_traffic_pct_for_fire: _calibrate_constants_js_1.TRAFFIC_GATE_MIN };
    if (tenantTierMap) {
        config.tenant_tier_map = tenantTierMap;
        config.tenant_tier_config = tenantTierConfig;
    }
    // Addition #17 — per-signal betting-e-process α = (α_A / bonf) · 0.5.
    const alphaBettingPerSignal = (alphaA / compileDefaults.family_a_signals.length) * 0.5;
    const stampBettingAlpha = (perSignal) => {
        if (!perSignal)
            return;
        for (const sig of Object.keys(perSignal)) {
            perSignal[sig].betting_e_process_alpha = alphaBettingPerSignal;
        }
    };
    for (const cell of baselineCells.cells) {
        stampBettingAlpha(cell.family_A?.per_signal);
    }
    stampBettingAlpha(baselineCells.aggregate_fallback.family_A?.per_signal);
    const nSignalsA = compileDefaults.family_a_signals.length;
    const summed = alphaBettingPerSignal * nSignalsA * 2;
    if (Math.abs(summed - alphaA) > alphaA * 1e-9) {
        console.warn(`[calibrate] Family A α-split sanity: 2·${alphaBettingPerSignal.toExponential(3)}·${nSignalsA} = `
            + `${summed.toExponential(3)} ≠ α_A = ${alphaA.toExponential(3)}`);
    }
}
/** REPLY-51 D6/D8 — attach profile provenance + policy_defaults + resolved
 *  signal inventory. Legacy (no-profile) compiles emit none of these. */
function attachProfileProvenance(config, effective, compileDefaults) {
    config.profile_ref = effective.profile_ref;
    if (effective.customer_override_ref !== null) {
        config.customer_override_ref = effective.customer_override_ref;
    }
    config.policy_defaults = { ...effective.policy_defaults };
    config.family_a_signals = compileDefaults.family_a_signals.slice();
    config.family_c_signals = compileDefaults.family_c_signals.slice();
}
/** Console diagnostics emitted after the config is written. */
function printCompileSummary(s) {
    const { config, outPath, t0, agg, rawEmpirical, toleranceIssues, baselineCells, compileDefaults, emitFamilyC, alphaA, alphaC, } = s;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`Compiled → ${outPath} (${elapsed}s)`);
    if (config.compile_phases) {
        const cp = config.compile_phases;
        console.log(`  compile_phases:  l0=${cp.l0_prep_ms}ms  cov=${cp.cov_estimation_ms}ms  `
            + `mmd_boot=${cp.mmd_bootstrap_ms}ms  conformal=${cp.conformal_calibration_ms}ms  `
            + `tau2=${cp.tau2_fit_ms}ms  total=${cp.total_ms}ms`);
        if ((cp.mcd_skipped_low_variance_cells ?? 0) > 0) {
            console.log(`  D6b MCD-skips: ${cp.mcd_skipped_low_variance_cells} low-variance cells`);
        }
        if ((cp.mmd_bootstrap_skipped_cells ?? 0) > 0) {
            console.log(`  D4 MMD-bootstrap-skips: ${cp.mmd_bootstrap_skipped_cells} cells`);
        }
        (0, _calibrate_aggregator_js_1.summarizeD6bDiagnostics)(agg.d6b_cells);
    }
    console.log('\nEmpirical q(1-α) vs legacy:');
    for (const name of Object.keys(_calibrate_constants_js_1.LEGACY_CUTOFFS)) {
        const legacy = _calibrate_constants_js_1.LEGACY_CUTOFFS[name];
        const raw = rawEmpirical[name];
        if (raw === undefined) {
            console.log('  ' + name.padEnd(14) + ' legacy=' + legacy.toFixed(4) + '  (no empirical — derived)');
        }
        else {
            const dev = ((raw - legacy) / legacy * 100).toFixed(2);
            console.log('  ' + name.padEnd(14) + ' legacy=' + legacy.toFixed(4) + '  empirical=' + raw.toFixed(4) + '  Δ=' + dev + '%');
        }
    }
    if (toleranceIssues.length > 0) {
        console.log('\nWARN — ' + toleranceIssues.length + ' cutoff(s) exceeded the ±5% tolerance:');
        for (const iss of toleranceIssues) {
            console.log('  ' + iss.cutoff + ': legacy=' + iss.legacy + '  empirical=' + iss.empirical.toFixed(4) + '  deviation=' + (iss.deviation * 100).toFixed(2) + '%');
        }
        console.log('\nEmitted config still uses legacy values (legacy-equivalent by construction).');
    }
    else {
        console.log('\nAll Family B cutoffs within ±5% of legacy. OK.');
    }
    if (baselineCells) {
        printBaselineCellsSummary(baselineCells, compileDefaults, config, emitFamilyC, alphaA, alphaC);
    }
}
/** baseline_cells portion of the compile summary. */
function printBaselineCellsSummary(baselineCells, compileDefaults, config, emitFamilyC, alphaA, alphaC) {
    const bonf = compileDefaults.family_a_signals.length;
    const perSignalAlpha = bonf > 0 ? alphaA / bonf : 0;
    const byConf = (c) => baselineCells.cells.filter((x) => x.confidence === c).length;
    console.log(`\nbaseline_cells: dims=[${baselineCells.dimensions.join(', ')}]  n_cells=${baselineCells.cells.length}  strict=${byConf('strict')}  pooled=${byConf('pooled')}  aggregate=${byConf('aggregate')}  none=${byConf('none')}`);
    console.log(`  Family A: ${bonf} signals; α_family_A=${alphaA.toExponential(3)}; per-signal α=${perSignalAlpha.toExponential(3)} (Bonferroni factor ${bonf}).`);
    if (emitFamilyC) {
        const cellsWithC = baselineCells.cells.filter((c) => c.family_C).length;
        const shrinkageVals = baselineCells.cells
            .map((c) => c.family_C?.covariance_shrinkage)
            .filter((v) => v !== undefined);
        const avgShrink = shrinkageVals.length ? shrinkageVals.reduce((a, b) => a + b, 0) / shrinkageVals.length : 0;
        const maxShrink = shrinkageVals.length ? Math.max(...shrinkageVals) : 0;
        console.log(`  Family C: ${compileDefaults.family_c_signals.length} signals; α_family_C=${alphaC.toExponential(3)} (single multivariate test, no Bonferroni).`);
        console.log(`    cells with family_C populated: ${cellsWithC}/${baselineCells.cells.length}; Ledoit-Wolf λ: avg=${avgShrink.toFixed(4)}, max=${maxShrink.toFixed(4)}`);
    }
    // Sample three cells for per-signal readability — picks diverse hours/days.
    const sample = baselineCells.cells.slice(0, 3).concat(baselineCells.cells.length > 14 ? [baselineCells.cells[14]] : []).concat(baselineCells.cells.length > 20 ? [baselineCells.cells[20]] : []);
    for (const cell of sample) {
        const keyStr = Object.entries(cell.key).map(([k, v]) => `${k}=${v}`).join(', ');
        console.log(`  cell {${keyStr}}  confidence=${cell.confidence}  n=${cell.n_samples}${cell.variance_inflated ? '  (var-inflated)' : ''}${cell.family_C ? `  C:λ=${cell.family_C.covariance_shrinkage?.toFixed(3)}` : ''}`);
        if (cell.family_A) {
            for (const signal of compileDefaults.family_a_signals) {
                const p = cell.family_A.per_signal[signal];
                if (!p)
                    continue;
                console.log(`    ${signal.padEnd(18)} τ²=${p.tau_squared.toExponential(3)}  δ_min=${p.delta_min.toExponential(3)}  μ=${p.baseline_mean.toFixed(4)}`);
            }
        }
    }
    console.log(`  traffic_pct_gate.min_traffic_pct_for_fire = ${_calibrate_constants_js_1.TRAFFIC_GATE_MIN}`);
    console.log(`  bake_profiles: ${Object.keys(config.bake_profiles ?? {}).length} entries (Addition #4 defaults).`);
}
