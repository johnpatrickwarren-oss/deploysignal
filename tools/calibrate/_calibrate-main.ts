// tools/calibrate/_calibrate-main.ts — CLI orchestration entrypoint for the
// NS calibration compiler. Logic extracted VERBATIM from the pre-split
// tools/calibrate.ts god-file `main()` (~917 lines, D-54-3 god-file
// decomposition); the orchestration is decomposed into phase helpers (here
// + _calibrate-config-build.ts + _calibrate-family-d-stamp.ts), each < 100
// lines, preserving exact ordering, side effects, deterministic output, and
// console diagnostics.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BaselineBundle, BaselineCellsConfig, CompilerOptions, EffectiveConfig,
  TenantTier, TenantTierConfig,
} from '../../engine/types';
import { resolveSignalClass, type SignalClass } from '../../engine/signal-classes.js';
import {
  FAMILY_E_BOOTSTRAP_SEED, computeBaselineSpanDays,
  buildFamilyEPerCell, resolveFamilyEVariantSelector,
} from '../calibrators/family-e.js';
import { runBaselineCurationPipeline } from '../curate-baseline-pipeline.js';
import type { CompileDefaults } from '../profile-loader.js';
import type { Args, CompileAggregator } from './_calibrate-types.js';
import {
  COMPILER_VERSION, LEGACY_VOTE_THRESHOLDS, FAMILY_C_ALPHA_FRACTION,
  FAMILY_D_ALPHA_FRACTION, DEFAULT_TENANT_TIER_CONFIG,
} from './_calibrate-constants.js';
import { parseArgs, loadBundle } from './_calibrate-data-prep.js';
import {
  newCompileAggregator, hrNow, finalizePhaseTimings,
} from './_calibrate-aggregator.js';
import { buildTenantTierMap } from './_calibrate-tenant-tiers.js';
import { deriveBaselineCells } from './_calibrate-derive-cells.js';
import { attachFamilyDAndStamp } from './_calibrate-family-d-stamp.js';
import { CellWorkerPool, chooseWorkerPoolSize } from './_calibrate-worker-pool.js';
import {
  deriveFamilyBCutoffs, resolveCompileDefaults, applyDemoBaselinePatch,
  allocateAlpha, emitFamilyABlock, attachProfileProvenance, printCompileSummary,
  type ConfigWithFamilyB, type FamilyBDerivation,
} from './_calibrate-config-build.js';
import { writeGuaranteeManifest } from '../_guarantee-manifest-cli.js';

/** REPLY-50 D2 — spin up worker pool for per-cell parallelism. Pool size
 *  ≤ 1 → serial fallback. Sandboxed environments that reject Worker
 *  construction fall back to serial with a stderr note. Charges the
 *  spawn cost into the aggregator's worker-pool overhead accumulator. */
function setupWorkerPool(args: Args, agg: CompileAggregator): CellWorkerPool | null {
  const tPoolStart = hrNow();
  let workerPool: CellWorkerPool | null = null;
  const poolSize = args.disable_worker_pool ? 1 : chooseWorkerPoolSize();
  if (poolSize > 1) {
    try {
      workerPool = new CellWorkerPool(poolSize);
    } catch (err) {
      console.warn(`[calibrate] worker pool unavailable (${err instanceof Error ? err.message : err}); running serial`);
      workerPool = null;
    }
  }
  agg.timings.worker_pool_overhead_ns += hrNow() - tPoolStart;
  return workerPool;
}

/** W4 — attach aggregate-only Family E conformal calibration. Per-cell
 *  refinement deferred (Mahalanobis-null is ~chi_p-invariant across cells).
 *  Charges into the conformal_calibration accumulator. Mutates baselineCells. */
function attachFamilyE(
  bundle: BaselineBundle, baselineCells: BaselineCellsConfig,
  compilerOpts: CompilerOptions, agg: CompileAggregator,
): void {
  const baselineSpanDays = computeBaselineSpanDays(bundle);
  const familyEHalfLifeDays = compilerOpts.family_e_halflife_days
    ?? Math.min(Math.max(baselineSpanDays / 2, 0.5), 14);
  if (baselineCells.aggregate_fallback.family_C) {
    const familyEVariant = resolveFamilyEVariantSelector(compilerOpts);
    const tFE = hrNow();
    const cal = buildFamilyEPerCell(
      baselineCells.aggregate_fallback.family_C,
      FAMILY_E_BOOTSTRAP_SEED,
      familyEHalfLifeDays,
      baselineSpanDays,
      familyEVariant,
    );
    agg.timings.conformal_calibration_ns += hrNow() - tFE;
    if (cal) baselineCells.aggregate_fallback.family_E = cal;
  }
}

interface BuildConfigArgs {
  args: Args;
  bundle: BaselineBundle;
  agg: CompileAggregator;
  effective: EffectiveConfig | null;
  compileDefaults: CompileDefaults;
  compileWarnings: import('../../engine/types').Warning[];
  baselineCells: BaselineCellsConfig | null;
  familyB: FamilyBDerivation;
  tenantTierMap: Record<string, TenantTier> | null;
  tenantTierConfig: TenantTierConfig;
  compilerOpts: CompilerOptions;
  tHrStart: bigint;
  emit: { A: boolean; C: boolean; D: boolean; E: boolean };
}

/** Assemble the CompiledConfig, write it to disk, and return the structured
 *  data the summary printer needs. Mirrors the pre-split main() body from
 *  α-allocation through file write. */
function buildAndWriteConfig(b: BuildConfigArgs): {
  config: ConfigWithFamilyB; outPath: string; alphaA: number; alphaC: number;
} {
  const {
    args, bundle, agg, effective, compileDefaults, compileWarnings, baselineCells,
    familyB, tenantTierMap, tenantTierConfig, compilerOpts, tHrStart, emit,
  } = b;
  const { alphaA, alphaB, alphaC, alphaD, alphaE } = allocateAlpha(
    args, effective, emit.A, emit.C, emit.D, emit.E);

  const derivedVersion = (emit.D || emit.E)
    ? 'v4-fusion-novelty'
    : emit.C
      ? 'v3-with-family-c'
      : emit.A
        ? 'v2-with-family-a'
        : 'v1-legacy-equivalent';
  // R2 Task 3 — optional refresh-candidate version disambiguator.
  // Absent -> byte-identical to the pre-Task-3 fixed enum string.
  const version = args.version_suffix ? `${derivedVersion}+${args.version_suffix}` : derivedVersion;

  const config: ConfigWithFamilyB = {
    version,
    compiler_version: COMPILER_VERSION,
    compiled_at: new Date(0).toISOString(), // deterministic; regenerate for wall-clock provenance
    baseline_ref: bundle.version + '@seed=' + bundle.seed,
    alpha_budget: {
      total: args.alpha,
      per_family: { A: alphaA, B: alphaB, C: alphaC, D: alphaD, E: alphaE },
    },
  };
  // REPLY-51b R4-4 — family_B emission conditional on profile gate.
  if (compileDefaults.family_enabled.B) {
    config.family_B = {
      cutoffs: familyB.cutoffs,
      vote_thresholds: LEGACY_VOTE_THRESHOLDS,
      raw_empirical: familyB.rawEmpirical,
      tolerance_issues: familyB.toleranceIssues,
    };
  }
  if (emit.A && baselineCells) {
    emitFamilyABlock({
      config, baselineCells, compileDefaults, effective,
      tenantTierMap, tenantTierConfig, alphaA,
    });
  }

  // REPLY-51 D6/D8 — attach profile provenance.
  if (effective) attachProfileProvenance(config, effective, compileDefaults);

  // REPLY-51b R4-2 — attach accumulated warnings.
  if (compileWarnings.length > 0) config.compile_warnings = compileWarnings;

  // Q2.A — emit the resolved signal_classes map.
  const resolvedSignalClasses: Record<string, SignalClass> = {};
  for (const sig of compileDefaults.family_a_signals) {
    resolvedSignalClasses[sig] = resolveSignalClass(sig, compilerOpts.signal_classes);
  }
  config.signal_classes = resolvedSignalClasses;

  // REPLY-50 D7 — stamp compile_phases just before write.
  config.compile_phases = finalizePhaseTimings(agg.timings, hrNow() - tHrStart);

  // Q61 SPEC-1 SLICE 1/2/3 (R2 Task 5) — stamp baseline curation
  // pipeline diagnostics. D10 (within SLICE_3) is the pipeline's sole
  // config-mutating decision (baseline_provenance honest stamping);
  // it runs here, before the config file + guarantee manifest are
  // written, so both reflect the stamped value.
  const pipelineState = runBaselineCurationPipeline(bundle, config, {
    slices: ['SLICE_1', 'SLICE_2', 'SLICE_3'],
    verifyDecisions: true,
  });
  config.baseline_curation_pipeline_diagnostics = pipelineState.decisions;

  const outPath = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n');

  // WS2 — every compile also emits a machine-readable guarantee manifest
  // next to the CompiledConfig, generated from this exact config (not
  // hand-maintained prose). Non-breaking: existing CLI output/behavior is
  // otherwise unchanged. `compiled_at` is reused as `generated_at` so the
  // manifest stays a deterministic function of the config (calibrate's
  // `compiled_at` is itself deterministic — see the `config.compiled_at`
  // assignment above).
  const manifestOutPath = outPath.replace(/\.json$/, '') + '.guarantee-manifest.json';
  writeGuaranteeManifest(config, manifestOutPath, config.compiled_at);

  return { config, outPath, alphaA, alphaC };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const t0 = Date.now();
  const tHrStart = hrNow();
  const agg = newCompileAggregator();
  const tL0Start = hrNow();

  const workerPool = setupWorkerPool(args, agg);

  const bundle = loadBundle(args.baseline);
  console.log(`Loaded ${bundle.runs.length} runs from ${args.baseline} (version=${bundle.version}, seed=${bundle.seed})`);

  const familyB = deriveFamilyBCutoffs(bundle, args.alpha);

  const { effective, compileDefaults, compileWarnings } = resolveCompileDefaults(args, bundle);
  const emit = {
    A: compileDefaults.family_enabled.A,
    C: compileDefaults.family_enabled.C,
    D: compileDefaults.family_enabled.D,
    E: compileDefaults.family_enabled.E,
  };

  // Addition #18 D8: Sequential MMD gets half of the Family-C α-budget.
  const alphaMMD = emit.C
    ? (effective
      ? effective.alpha_allocation.per_family.C * 0.5
      : (args.alpha * FAMILY_C_ALPHA_FRACTION) * 0.5)
    : undefined;
  const compilerOpts: CompilerOptions = {
    covariance_method_override: args.covariance_method_override,
    mcd_alpha: args.mcd_alpha,
    family_e_halflife_days: args.family_e_halflife_days,
    force_legacy_family_c: args.force_legacy_family_c,
    family_c_shrink_fraction: args.family_c_shrink_fraction,
    force_legacy_family_d: args.force_legacy_family_d,
    force_legacy_family_e: args.force_legacy_family_e,
    family_E_variant_selector: args.family_E_variant_selector,
  };
  // Addition #23 — tenant-tier derivation. No-op when no tenant_id present.
  const tenantTierConfig: TenantTierConfig = DEFAULT_TENANT_TIER_CONFIG;
  const tenantTierMap = buildTenantTierMap(bundle, tenantTierConfig);
  agg.timings.l0_prep_ns += hrNow() - tL0Start;
  const baselineCells = emit.A
    ? await deriveBaselineCells(
        bundle, emit.C, compilerOpts, alphaMMD, tenantTierMap, workerPool,
        compileDefaults.family_a_signals, compileDefaults.family_c_signals,
        agg,
      )
    : null;

  // Q57 — apply aggregate_fallback_patch from demo baseline file(s).
  if (baselineCells && args.demo_baseline_patch) {
    applyDemoBaselinePatch(baselineCells, args.demo_baseline_patch);
  }

  // W4: attach Family E (aggregate-only conformal calibration).
  if (baselineCells && emit.E) {
    attachFamilyE(bundle, baselineCells, compilerOpts, agg);
  }

  // W4 + Q2.B.6.x — attach Family D + joint-AR(1) Cholesky / sliding-buffer
  // Hotelling / betting stamping + consistency audits.
  if (baselineCells && emit.D) {
    attachFamilyDAndStamp(
      bundle, baselineCells, tenantTierMap, compilerOpts, effective,
      args.alpha, FAMILY_D_ALPHA_FRACTION,
      compileDefaults.family_c_signals, compileDefaults.family_a_signals.length,
    );
  }

  // REPLY-50 D2 — tear down worker pool. Wait for termination before
  // finalize so worker-pool-overhead_ns captures shutdown cost.
  if (workerPool) {
    const tShutdown = hrNow();
    await workerPool.terminate();
    agg.timings.worker_pool_overhead_ns += hrNow() - tShutdown;
  }

  const { config, outPath, alphaA, alphaC } = buildAndWriteConfig({
    args, bundle, agg, effective, compileDefaults, compileWarnings, baselineCells,
    familyB, tenantTierMap, tenantTierConfig, compilerOpts, tHrStart, emit,
  });

  printCompileSummary({
    config, outPath, t0, agg,
    rawEmpirical: familyB.rawEmpirical,
    toleranceIssues: familyB.toleranceIssues,
    baselineCells, compileDefaults, emitFamilyC: emit.C, alphaA, alphaC,
  });
}
