// tools/calibrate/_calibrate-config-build.ts — config-assembly phase helpers
// + compile-summary printers for the NS calibration compiler. Logic
// extracted VERBATIM from the pre-split tools/calibrate.ts god-file `main()`
// (D-54-3 god-file decomposition); each helper < 100 lines, preserving exact
// ordering, side effects, deterministic output, and console diagnostics.

import * as fs from 'node:fs';
import type {
  BaselineBundle, CompiledConfig, BaselineCellsConfig, FamilyAPerSignalParams,
  TenantTier, TenantTierConfig, EffectiveConfig, Warning,
} from '../../engine/types';
import {
  loadProfile, loadCustomerOverride, resolveEffectiveConfig,
  effectiveOrDefaults, reconcileCellDimensions,
} from '../profile-loader.js';
import type {
  CompileDefaults, LegacyCompileDefaults,
} from '../profile-loader.js';
import { loadBundleMetadata } from '../bundle-loader.js';
import { buildBakeProfiles } from '../calibrators/bake-profiles.js';
import type { Args, CompileAggregator } from './_calibrate-types.js';
import {
  LEGACY_CUTOFFS, CUTOFF_SIGNAL, HEALTHY_MEANS,
  FAMILY_A_SIGNALS, FAMILY_C_SIGNALS,
  FAMILY_A_ALPHA_FRACTION, FAMILY_C_ALPHA_FRACTION, FAMILY_D_ALPHA_FRACTION,
  FAMILY_E_ALPHA_FRACTION, TRAFFIC_GATE_MIN,
} from './_calibrate-constants.js';
import { flattenSignal, quantile } from './_calibrate-data-prep.js';
import { summarizeD6bDiagnostics } from './_calibrate-aggregator.js';

export type FamilyBConfig = {
  raw_empirical: Record<string, number>;
  tolerance_issues: Array<{ cutoff: string; legacy: number; empirical: number; deviation: number }>;
};
export type ConfigWithFamilyB = CompiledConfig & { family_B?: FamilyBConfig };

export interface FamilyBDerivation {
  cutoffs: Record<string, number>;
  rawEmpirical: Record<string, number>;
  toleranceIssues: Array<{ cutoff: string; legacy: number; empirical: number; deviation: number }>;
}

/** Family B cutoff derivation — validates the empirical (1 − α) ratio
 *  quantile against the legacy cutoff (±5%) and emits the legacy value
 *  (equivalence by construction). */
export function deriveFamilyBCutoffs(bundle: BaselineBundle, alpha: number): FamilyBDerivation {
  const cutoffs: Record<string, number> = {};
  const rawEmpirical: Record<string, number> = {};
  const toleranceIssues: FamilyBDerivation['toleranceIssues'] = [];

  for (const name of Object.keys(LEGACY_CUTOFFS)) {
    const legacy = LEGACY_CUTOFFS[name];
    const signal = CUTOFF_SIGNAL[name];

    if (signal === null) {
      // Derived / joint cutoff — nothing to validate empirically. Emit legacy.
      cutoffs[name] = legacy;
      continue;
    }

    const mean = HEALTHY_MEANS[signal];
    if (mean === undefined) throw new Error('No healthy mean defined for signal ' + signal);
    const samples = flattenSignal(bundle, signal);
    if (samples.length === 0) {
      console.warn(`WARN: no samples for signal ${signal}; emitting legacy ${legacy} without validation`);
      cutoffs[name] = legacy;
      continue;
    }
    const ratios = samples.map((v) => v / mean);
    const q = quantile(ratios, 1 - alpha);
    rawEmpirical[name] = q;

    const dev = Math.abs(q - legacy) / legacy;
    if (dev > 0.05) {
      toleranceIssues.push({ cutoff: name, legacy, empirical: q, deviation: dev });
    }
    cutoffs[name] = legacy;  // emit legacy; equivalence by construction
  }
  return { cutoffs, rawEmpirical, toleranceIssues };
}

export interface ResolvedCompile {
  effective: EffectiveConfig | null;
  compileDefaults: CompileDefaults;
  compileWarnings: Warning[];
}

/** Addition #28 — resolve optional profile + override layer + cell-dimension
 *  reconciliation. Legacy path (no profile_ref) → effective=null, hardcoded
 *  defaults. Throws on the D5 all-families-disabled invariant. */
export function resolveCompileDefaults(args: Args, bundle: BaselineBundle): ResolvedCompile {
  let effective: EffectiveConfig | null = null;
  if (args.profile_ref) {
    const profile = loadProfile(args.profile_ref);
    const override = args.customer_override_ref
      ? loadCustomerOverride(args.customer_override_ref)
      : null;
    effective = resolveEffectiveConfig(profile, override);
    if (Math.abs(args.alpha - effective.alpha_allocation.total) > 1e-12) {
      throw new Error(
        `--alpha ${args.alpha} does not match profile's alpha_allocation.total `
        + `${effective.alpha_allocation.total} for ${effective.profile_ref}. `
        + `Align either input or pick a profile whose total matches.`,
      );
    }
  }
  const legacyDefaults: LegacyCompileDefaults = {
    family_a_signals: FAMILY_A_SIGNALS.slice(),
    family_c_signals: FAMILY_C_SIGNALS.slice(),
    family_a_alpha_fraction: FAMILY_A_ALPHA_FRACTION,
    family_c_alpha_fraction: FAMILY_C_ALPHA_FRACTION,
    family_d_alpha_fraction: FAMILY_D_ALPHA_FRACTION,
    family_e_alpha_fraction: FAMILY_E_ALPHA_FRACTION,
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
  let compileDefaults: CompileDefaults = effectiveOrDefaults(effective, legacyDefaults);
  const compileWarnings: Warning[] = [];
  if (effective) {
    const bundleMeta = loadBundleMetadata(args.baseline);
    const mode = args.cell_dimension_deficiency_mode ?? 'warn';
    const reconciled = reconcileCellDimensions(
      compileDefaults.cell_dimensions,
      bundleMeta.available_dimensions,
      mode,
    );
    compileDefaults = { ...compileDefaults, cell_dimensions: reconciled.cell_dimensions };
    for (const w of reconciled.warnings) {
      compileWarnings.push(w);
      console.warn(`[calibrate] WARN ${w.code}: ${w.message}`);
    }
  }
  if (
    effective &&
    !compileDefaults.family_enabled.A &&
    !compileDefaults.family_enabled.B &&
    !compileDefaults.family_enabled.C &&
    !compileDefaults.family_enabled.D &&
    !compileDefaults.family_enabled.E
  ) {
    throw new Error(
      `profile ${effective.profile_ref} disables all detector families `
      + `(joint_vector.include_in_family_c/e + structural_detectors.enabled + `
      + `--families CLI intersection). Compile requires ≥ 1 active family.`,
    );
  }
  return { effective, compileDefaults, compileWarnings };
}

/** Q57 — apply aggregate_fallback_patch from demo baseline file(s). Patches
 *  BOTH baselineCells.aggregate_fallback (per spec) AND the matching
 *  cells[].(target_cell, tier='aggregate') (runtime consumption path). */
export function applyDemoBaselinePatch(
  baselineCells: BaselineCellsConfig, demoBaselinePatch: string,
): void {
  const patchPaths = demoBaselinePatch.split(',').map((s) => s.trim()).filter(Boolean);
  for (const patchPath of patchPaths) {
    const patchJson = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
    const aggPatch = patchJson.aggregate_fallback_patch;
    if (!aggPatch) continue;
    const targetCell = patchJson.cell_patch?.target_cell;

    // (a) Apply to baselineCells.aggregate_fallback (per spec literal).
    if (aggPatch.family_A_per_signal && baselineCells.aggregate_fallback.family_A?.per_signal) {
      for (const [sig, params] of Object.entries(aggPatch.family_A_per_signal)) {
        const existing = baselineCells.aggregate_fallback.family_A.per_signal[sig];
        if (existing) {
          baselineCells.aggregate_fallback.family_A.per_signal[sig] = {
            ...existing,
            ...(params as Partial<FamilyAPerSignalParams>),
          };
        }
      }
    }
    if (aggPatch.family_C_mean_vector && baselineCells.aggregate_fallback.family_C) {
      baselineCells.aggregate_fallback.family_C.mean_vector =
        (aggPatch.family_C_mean_vector as number[]).slice();
    }

    // (b) Apply to cells[].(target_cell, tier='aggregate').
    if (targetCell) {
      const targetCells = baselineCells.cells.filter((c) =>
        c.key.hour_of_day === targetCell.hour_of_day &&
        c.key.day_of_week === targetCell.day_of_week &&
        c.key.tenant_tier === 'aggregate');
      for (const cell of targetCells) {
        if (aggPatch.family_A_per_signal && cell.family_A?.per_signal) {
          for (const [sig, params] of Object.entries(aggPatch.family_A_per_signal)) {
            const existing = cell.family_A.per_signal[sig];
            if (existing) {
              cell.family_A.per_signal[sig] = {
                ...existing,
                ...(params as Partial<FamilyAPerSignalParams>),
              };
            }
          }
        }
        if (aggPatch.family_C_mean_vector && cell.family_C) {
          cell.family_C.mean_vector =
            (aggPatch.family_C_mean_vector as number[]).slice();
        }
      }
    }
  }
}

export interface AlphaAllocation {
  alphaA: number; alphaB: number; alphaC: number; alphaD: number; alphaE: number;
}

/** α allocation — WEEK4-HANDOFF.md §4.1.f: 40/20/20/10/10 when A+C+D+E emit;
 *  leftover goes to B. Profile path reads per_family directly. */
export function allocateAlpha(
  args: Args, effective: EffectiveConfig | null,
  emitFamilyA: boolean, emitFamilyC: boolean, emitFamilyD: boolean, emitFamilyE: boolean,
): AlphaAllocation {
  let alphaA = 0, alphaB = args.alpha, alphaC = 0, alphaD = 0, alphaE = 0;
  if (emitFamilyA) {
    if (effective) {
      alphaA = effective.alpha_allocation.per_family.A;
      alphaC = emitFamilyC ? effective.alpha_allocation.per_family.C : 0;
      alphaD = emitFamilyD ? effective.alpha_allocation.per_family.D : 0;
      alphaE = emitFamilyE ? effective.alpha_allocation.per_family.E : 0;
      alphaB = args.alpha - alphaA - alphaC - alphaD - alphaE;
    } else {
      alphaA = args.alpha * FAMILY_A_ALPHA_FRACTION;
      if (emitFamilyC) alphaC = args.alpha * FAMILY_C_ALPHA_FRACTION;
      if (emitFamilyD) alphaD = args.alpha * FAMILY_D_ALPHA_FRACTION;
      if (emitFamilyE) alphaE = args.alpha * FAMILY_E_ALPHA_FRACTION;
      alphaB = args.alpha - alphaA - alphaC - alphaD - alphaE;
    }
  }
  return { alphaA, alphaB, alphaC, alphaD, alphaE };
}

export interface FamilyAEmitArgs {
  config: ConfigWithFamilyB;
  baselineCells: BaselineCellsConfig;
  compileDefaults: CompileDefaults;
  effective: EffectiveConfig | null;
  tenantTierMap: Record<string, TenantTier> | null;
  tenantTierConfig: TenantTierConfig;
  alphaA: number;
}

/** Family A emission block — baseline_cells, bonferroni, bake_profiles,
 *  traffic gate, tenant tier map, and per-signal betting α stamping. */
export function emitFamilyABlock(a: FamilyAEmitArgs): void {
  const { config, baselineCells, compileDefaults, effective, tenantTierMap, tenantTierConfig, alphaA } = a;
  config.baseline_cells = baselineCells;
  config.bonferroni_factor = compileDefaults.family_a_signals.length;
  const baseBake = buildBakeProfiles();
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
  config.traffic_pct_gate = { min_traffic_pct_for_fire: TRAFFIC_GATE_MIN };
  if (tenantTierMap) {
    config.tenant_tier_map = tenantTierMap;
    config.tenant_tier_config = tenantTierConfig;
  }

  // Addition #17 — per-signal betting-e-process α = (α_A / bonf) · 0.5.
  const alphaBettingPerSignal = (alphaA / compileDefaults.family_a_signals.length) * 0.5;
  const stampBettingAlpha = (perSignal: Record<string, FamilyAPerSignalParams> | undefined): void => {
    if (!perSignal) return;
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
    console.warn(
      `[calibrate] Family A α-split sanity: 2·${alphaBettingPerSignal.toExponential(3)}·${nSignalsA} = `
      + `${summed.toExponential(3)} ≠ α_A = ${alphaA.toExponential(3)}`,
    );
  }
}

/** REPLY-51 D6/D8 — attach profile provenance + policy_defaults + resolved
 *  signal inventory. Legacy (no-profile) compiles emit none of these. */
export function attachProfileProvenance(
  config: ConfigWithFamilyB, effective: EffectiveConfig, compileDefaults: CompileDefaults,
): void {
  config.profile_ref = effective.profile_ref;
  if (effective.customer_override_ref !== null) {
    config.customer_override_ref = effective.customer_override_ref;
  }
  config.policy_defaults = { ...effective.policy_defaults };
  config.family_a_signals = compileDefaults.family_a_signals.slice();
  config.family_c_signals = compileDefaults.family_c_signals.slice();
}

export interface SummaryArgs {
  config: ConfigWithFamilyB;
  outPath: string;
  t0: number;
  agg: CompileAggregator;
  rawEmpirical: Record<string, number>;
  toleranceIssues: FamilyBDerivation['toleranceIssues'];
  baselineCells: BaselineCellsConfig | null;
  compileDefaults: CompileDefaults;
  emitFamilyC: boolean;
  alphaA: number;
  alphaC: number;
}

/** Console diagnostics emitted after the config is written. */
export function printCompileSummary(s: SummaryArgs): void {
  const {
    config, outPath, t0, agg, rawEmpirical, toleranceIssues,
    baselineCells, compileDefaults, emitFamilyC, alphaA, alphaC,
  } = s;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`Compiled → ${outPath} (${elapsed}s)`);
  if (config.compile_phases) {
    const cp = config.compile_phases;
    console.log(
      `  compile_phases:  l0=${cp.l0_prep_ms}ms  cov=${cp.cov_estimation_ms}ms  `
      + `mmd_boot=${cp.mmd_bootstrap_ms}ms  conformal=${cp.conformal_calibration_ms}ms  `
      + `tau2=${cp.tau2_fit_ms}ms  total=${cp.total_ms}ms`,
    );
    if ((cp.mcd_skipped_low_variance_cells ?? 0) > 0) {
      console.log(`  D6b MCD-skips: ${cp.mcd_skipped_low_variance_cells} low-variance cells`);
    }
    if ((cp.mmd_bootstrap_skipped_cells ?? 0) > 0) {
      console.log(`  D4 MMD-bootstrap-skips: ${cp.mmd_bootstrap_skipped_cells} cells`);
    }
    summarizeD6bDiagnostics(agg.d6b_cells);
  }
  console.log('\nEmpirical q(1-α) vs legacy:');
  for (const name of Object.keys(LEGACY_CUTOFFS)) {
    const legacy = LEGACY_CUTOFFS[name];
    const raw = rawEmpirical[name];
    if (raw === undefined) {
      console.log('  ' + name.padEnd(14) + ' legacy=' + legacy.toFixed(4) + '  (no empirical — derived)');
    } else {
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
  } else {
    console.log('\nAll Family B cutoffs within ±5% of legacy. OK.');
  }
  if (baselineCells) {
    printBaselineCellsSummary(baselineCells, compileDefaults, config, emitFamilyC, alphaA, alphaC);
  }
}

/** baseline_cells portion of the compile summary. */
function printBaselineCellsSummary(
  baselineCells: BaselineCellsConfig, compileDefaults: CompileDefaults,
  config: ConfigWithFamilyB, emitFamilyC: boolean, alphaA: number, alphaC: number,
): void {
  const bonf = compileDefaults.family_a_signals.length;
  const perSignalAlpha = bonf > 0 ? alphaA / bonf : 0;
  const byConf = (c: BaselineCellsConfig['cells'][0]['confidence']) =>
    baselineCells.cells.filter((x) => x.confidence === c).length;
  console.log(`\nbaseline_cells: dims=[${baselineCells.dimensions.join(', ')}]  n_cells=${baselineCells.cells.length}  strict=${byConf('strict')}  pooled=${byConf('pooled')}  aggregate=${byConf('aggregate')}  none=${byConf('none')}`);
  console.log(`  Family A: ${bonf} signals; α_family_A=${alphaA.toExponential(3)}; per-signal α=${perSignalAlpha.toExponential(3)} (Bonferroni factor ${bonf}).`);
  if (emitFamilyC) {
    const cellsWithC = baselineCells.cells.filter((c) => c.family_C).length;
    const shrinkageVals = baselineCells.cells
      .map((c) => c.family_C?.covariance_shrinkage)
      .filter((v): v is number => v !== undefined);
    const avgShrink = shrinkageVals.length ? shrinkageVals.reduce((a, b) => a + b, 0) / shrinkageVals.length : 0;
    const maxShrink = shrinkageVals.length ? Math.max(...shrinkageVals) : 0;
    console.log(`  Family C: ${compileDefaults.family_c_signals.length} signals; α_family_C=${alphaC.toExponential(3)} (single multivariate test, no Bonferroni).`);
    console.log(`    cells with family_C populated: ${cellsWithC}/${baselineCells.cells.length}; Ledoit-Wolf λ: avg=${avgShrink.toFixed(4)}, max=${maxShrink.toFixed(4)}`);
  }
  // Sample three cells for per-signal readability — picks diverse hours/days.
  const sample = baselineCells.cells.slice(0, 3).concat(
    baselineCells.cells.length > 14 ? [baselineCells.cells[14]] : []).concat(
    baselineCells.cells.length > 20 ? [baselineCells.cells[20]] : []);
  for (const cell of sample) {
    const keyStr = Object.entries(cell.key).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`  cell {${keyStr}}  confidence=${cell.confidence}  n=${cell.n_samples}${cell.variance_inflated ? '  (var-inflated)' : ''}${cell.family_C ? `  C:λ=${cell.family_C.covariance_shrinkage?.toFixed(3)}` : ''}`);
    if (cell.family_A) {
      for (const signal of compileDefaults.family_a_signals) {
        const p = cell.family_A.per_signal[signal];
        if (!p) continue;
        console.log(`    ${signal.padEnd(18)} τ²=${p.tau_squared.toExponential(3)}  δ_min=${p.delta_min.toExponential(3)}  μ=${p.baseline_mean.toFixed(4)}`);
      }
    }
  }
  console.log(`  traffic_pct_gate.min_traffic_pct_for_fire = ${TRAFFIC_GATE_MIN}`);
  console.log(`  bake_profiles: ${Object.keys(config.bake_profiles ?? {}).length} entries (Addition #4 defaults).`);
}
