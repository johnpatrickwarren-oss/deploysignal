// tools/calibrate/_calibrate-family-d-stamp.ts — W4 Family D attachment +
// Q2.B.6.x joint-AR(1) Cholesky / sliding-buffer Hotelling / betting wealth
// stamping + consistency audits. Logic extracted VERBATIM from the
// pre-split tools/calibrate.ts god-file `main()` (D-54-3 god-file
// decomposition); decomposed into module-level helpers, each < 100 lines,
// preserving exact ordering, seeds, caching, side effects, and halt
// semantics.

import type {
  BaselineBundle, BaselineCellsConfig, CompilerOptions, EffectiveConfig,
  FamilyCPerCell, FamilyDPerSignal, FamilyAPerSignalParams,
  TenantTier, SafeHotellingParams,
} from '../../engine/types';
import { computeWhiteNoiseCovariance } from '../../engine/resamplers/ar1.js';
import { cholesky as _choleskyJointFromResampler } from '../../engine/resamplers/cholesky.js';
import { projectPSD } from '../calibrators/_shared.js';
import {
  bootstrapHotellingSlidingBufferThreshold,
  FAMILY_C_HOTELLING_BOOTSTRAP_SEED,
} from '../calibrators/family-c.js';
import {
  FAMILY_D_BOOTSTRAP_SEED,
  buildFamilyDForSignalAR1 as _buildFamilyDForSignalAR1Pure,
} from '../calibrators/family-d.js';
import {
  bootstrapBettingSlidingBufferThreshold,
  FAMILY_A_BETTING_BOOTSTRAP_SEED,
} from '../calibrators/family-a.js';
import {
  EMITTED_TIERS, FAMILY_A_ALPHA_FRACTION,
} from './_calibrate-constants.js';
import {
  auditAR1FactorizationConsistency,
  auditSlidingBufferHotellingConsistency,
  auditBettingSlidingBufferConsistency,
} from './_calibrate-audits.js';

const PSD_EPS_RELATIVE = 1e-9;
const ALPHA_C_FAMILY = 2e-4;  // Family C α budget (matches runtime default)

type PerTierFamilyD = Record<TenantTier, Record<string, FamilyDPerSignal>>;

interface BootstrapResult {
  threshold: number; bootstrap_n: number;
  null_max_mean: number; null_max_std: number;
}

const cellSeedOffset = (key: BaselineCellsConfig['cells'][0]['key']): number =>
  ((Number(key.hour_of_day) * 31 + Number(key.day_of_week)) * 7
    + (key.tenant_tier === 'aggregate' ? 0
      : key.tenant_tier === 'large' ? 1
      : key.tenant_tier === 'medium' ? 2
      : key.tenant_tier === 'small' ? 3 : 4)) >>> 0;

/** Q2.B.6.1 — tier-symmetric AR(1) sample collection. Aggregate-tier bucket
 *  always carries cross-tenant pooled rows; per-strict-tier buckets carry
 *  tenant-classified rows for that tier. */
function collectPerTierSignal(
  bundle: BaselineBundle, tenantTierMap: Record<string, TenantTier> | null,
): Record<TenantTier, Record<string, number[]>> {
  const perTierSignal: Record<TenantTier, Record<string, number[]>> = {
    dominant: {}, large: {}, medium: {}, small: {}, aggregate: {},
  };
  for (const run of bundle.runs) {
    const runTier: TenantTier | undefined = tenantTierMap && run.tenant_id
      ? tenantTierMap[run.tenant_id] : undefined;
    for (const sig of Object.keys(run.signal_series)) {
      const aggBucket = perTierSignal.aggregate[sig]
        ?? (perTierSignal.aggregate[sig] = []);
      for (const v of run.signal_series[sig]) aggBucket.push(v);
      if (runTier && runTier !== 'aggregate') {
        const tierBucket = perTierSignal[runTier][sig]
          ?? (perTierSignal[runTier][sig] = []);
        for (const v of run.signal_series[sig]) tierBucket.push(v);
      }
    }
  }
  return perTierSignal;
}

/** Per-tier ar1_phi + bootstrap_null_quantile + σ_eps via
 *  buildFamilyDForSignalAR1. Each tier gets its own seed offset so
 *  distinct-pool tiers don't share bootstrap RNG draws. */
function fitPerTierFamilyD(
  perTierSignal: Record<TenantTier, Record<string, number[]>>,
  alphaDBoot: number, useLegacyD: boolean,
): PerTierFamilyD {
  const TIER_SEED_SALT: Record<TenantTier, number> = {
    aggregate: 0x00000000,
    dominant:  0x000000D0,
    large:     0x0000001A, // distinct from aggregate when pools coincide
    medium:    0x000000ED,
    small:     0x0000005A,
  };
  const perTierFamilyD: PerTierFamilyD = {
    dominant: {}, large: {}, medium: {}, small: {}, aggregate: {},
  };
  for (const tier of EMITTED_TIERS) {
    const samplesByTier = perTierSignal[tier];
    for (const sig of Object.keys(samplesByTier)) {
      const seed = (FAMILY_D_BOOTSTRAP_SEED + sig.length) ^ TIER_SEED_SALT[tier];
      const { result } = _buildFamilyDForSignalAR1Pure(
        samplesByTier[sig], alphaDBoot, seed, useLegacyD,
      );
      if (result) perTierFamilyD[tier][sig] = result;
    }
  }
  return perTierFamilyD;
}

/** Q2.B.7 + Q2.B.6.1 — stamp cholesky_L_eps on every cell with a Family C
 *  covariance. ρ vector preferentially comes from the cell's tier; falls
 *  back to aggregate. Σ_eps_raw projected to nearest PSD before factorization. */
function stampJointAR1CholeskyAll(
  baselineCells: BaselineCellsConfig, perTierFamilyD: PerTierFamilyD,
  familyCSignals: readonly string[],
): void {
  const aggFamilyD = perTierFamilyD.aggregate;
  const stampJointAR1Cholesky = (
    cellFamilyC: FamilyCPerCell, tier: TenantTier,
  ): void => {
    if (!cellFamilyC.covariance) return;
    if (cellFamilyC.covariance.length !== familyCSignals.length) return;
    const tierFD = perTierFamilyD[tier];
    const rhoVec: number[] = familyCSignals.map((sig) =>
      tierFD[sig]?.ar1_phi ?? aggFamilyD[sig]?.ar1_phi ?? 0,
    );
    const sigmaEpsRaw = computeWhiteNoiseCovariance(
      cellFamilyC.covariance, rhoVec,
    );
    const sigmaEpsPSD = projectPSD(sigmaEpsRaw, PSD_EPS_RELATIVE);
    cellFamilyC.cholesky_L_eps = _choleskyJointFromResampler(sigmaEpsPSD);
  };
  for (const entry of baselineCells.cells) {
    if (entry.family_C) {
      const tier = (entry.key.tenant_tier as TenantTier | undefined) ?? 'aggregate';
      stampJointAR1Cholesky(entry.family_C, tier);
    }
  }
  if (baselineCells.aggregate_fallback.family_C) {
    stampJointAR1Cholesky(baselineCells.aggregate_fallback.family_C, 'aggregate');
  }
}

/** Canonical hex digest of Σ + ρ + α + variant + safe_params for cache
 *  identity. Float precision rounded to 12 sig digits. */
function hotellingCacheKey(
  sigma: number[][], rho: number[], alphaArg: number,
  variantArg: 'chi_square' | 'safe_test',
  safeParams: SafeHotellingParams | null,
): string {
  const round = (v: number): string => Number.isFinite(v)
    ? v.toExponential(12) : String(v);
  const parts: string[] = [variantArg, round(alphaArg)];
  for (const r of rho) parts.push(round(r));
  for (const row of sigma) for (const v of row) parts.push(round(v));
  if (variantArg === 'safe_test' && safeParams) {
    parts.push(round(safeParams.tau_squared));
    parts.push(round(safeParams.alpha));
    parts.push(round(safeParams.precompiled_log_det_shrink));
  }
  return parts.join('|');
}

/** Q2.B.6.2 — Family C sliding-buffer Hotelling recalibration. Per-cell
 *  bootstrap (1 − α_C) quantile under joint AR(1) H₀ with sliding-buffer
 *  evaluation, hash-cached by canonical signature. */
function stampSlidingBufferHotellingAll(
  baselineCells: BaselineCellsConfig, perTierFamilyD: PerTierFamilyD,
  familyCSignals: readonly string[],
): void {
  const aggFamilyD = perTierFamilyD.aggregate;
  const slidingBufferCache = new Map<string, BootstrapResult>();
  const stampSlidingBufferHotellingThreshold = (
    cellFamilyC: FamilyCPerCell, tier: TenantTier, seed: number,
  ): void => {
    if (!cellFamilyC.covariance || !cellFamilyC.cholesky_L_eps) return;
    if (cellFamilyC.covariance.length !== familyCSignals.length) return;
    // safe_test variant requires safe_hotelling_params; chi_square uses
    // covariance only. MMD α-budget split halves the per-detector α.
    const alphaHotelling = cellFamilyC.mmd_params
      ? ALPHA_C_FAMILY * 0.5
      : ALPHA_C_FAMILY;
    const variant = cellFamilyC.hotelling_variant ?? 'chi_square';
    const safeParams = cellFamilyC.safe_hotelling_params ?? null;
    const tierFD = perTierFamilyD[tier];
    const rhoVec: number[] = familyCSignals.map((sig) =>
      tierFD[sig]?.ar1_phi ?? aggFamilyD[sig]?.ar1_phi ?? 0,
    );
    const sigmaEpsRaw = computeWhiteNoiseCovariance(
      cellFamilyC.covariance, rhoVec,
    );
    const sigmaEpsPSD = projectPSD(sigmaEpsRaw, PSD_EPS_RELATIVE);
    const alphaForBootstrap =
      variant === 'safe_test' && safeParams ? safeParams.alpha : alphaHotelling;
    const key = hotellingCacheKey(
      cellFamilyC.covariance, rhoVec, alphaForBootstrap, variant, safeParams);
    let result = slidingBufferCache.get(key);
    if (!result) {
      result = bootstrapHotellingSlidingBufferThreshold(
        cellFamilyC.mean_vector,
        cellFamilyC.covariance,
        rhoVec,
        sigmaEpsPSD,
        alphaForBootstrap,
        variant,
        safeParams,
        FAMILY_C_HOTELLING_BOOTSTRAP_SEED + seed,
      );
      slidingBufferCache.set(key, result);
    }
    if (variant === 'safe_test' && safeParams) {
      safeParams.sliding_buffer_threshold = result.threshold;
      safeParams.calibration_scope = 'sliding_buffer_ar1';
    } else {
      cellFamilyC.hotelling_sliding_buffer_threshold = result.threshold;
    }
  };
  for (const entry of baselineCells.cells) {
    if (entry.family_C) {
      const tier = (entry.key.tenant_tier as TenantTier | undefined) ?? 'aggregate';
      stampSlidingBufferHotellingThreshold(
        entry.family_C, tier, cellSeedOffset(entry.key));
    }
  }
  if (baselineCells.aggregate_fallback.family_C) {
    stampSlidingBufferHotellingThreshold(
      baselineCells.aggregate_fallback.family_C, 'aggregate', 0);
  }
}

/** Q2.B.6.3 — Family A betting sliding-buffer recalibration. Bootstrap MAX
 *  wealth per trajectory under joint AR(1) H₀; (1−α) quantile gives the
 *  recalibrated threshold, hash-cached by (μ, σ², ρ, α_betting) signature. */
function stampBettingSlidingBufferAll(
  baselineCells: BaselineCellsConfig, perTierFamilyD: PerTierFamilyD,
  effective: EffectiveConfig | null, alphaTotal: number,
  familyASignalsLength: number,
): void {
  const aggFD = perTierFamilyD.aggregate;
  // Compute α_betting inline: alphaA / bonf / 2. Re-derive from args + effective.
  const alphaA_betting = (effective
    ? effective.alpha_allocation.per_family.A
    : alphaTotal * FAMILY_A_ALPHA_FRACTION);
  const bonferroni = familyASignalsLength;
  const alphaBettingPerSignalLocal = (alphaA_betting / bonferroni) * 0.5;
  const cache = new Map<string, BootstrapResult>();
  const round = (v: number): string => Number.isFinite(v) ? v.toExponential(12) : String(v);
  const stampBettingThreshold = (
    perSignal: Record<string, FamilyAPerSignalParams> | undefined,
    tier: TenantTier,
    seedOffset: number,
  ): void => {
    if (!perSignal) return;
    const tierFD = perTierFamilyD[tier];
    for (const sig of Object.keys(perSignal)) {
      const p = perSignal[sig];
      if (!p) continue;
      const mu = p.baseline_mean;
      const sigma2 = p.baseline_sigma_squared;
      if (!Number.isFinite(mu) || !Number.isFinite(sigma2) || sigma2 <= 0) continue;
      const rho = tierFD[sig]?.ar1_phi ?? aggFD[sig]?.ar1_phi ?? 0;
      const key = `${sig}|${round(mu)}|${round(sigma2)}|${round(rho)}|${round(alphaBettingPerSignalLocal)}`;
      let res = cache.get(key);
      if (!res) {
        res = bootstrapBettingSlidingBufferThreshold(
          mu, sigma2, rho, alphaBettingPerSignalLocal,
          FAMILY_A_BETTING_BOOTSTRAP_SEED + seedOffset,
        );
        cache.set(key, res);
      }
      p.betting_sliding_buffer_threshold = res.threshold;
      p.betting_calibration_scope = 'sliding_buffer_ar1';
    }
  };
  for (const entry of baselineCells.cells) {
    if (entry.family_A?.per_signal) {
      const tier = (entry.key.tenant_tier as TenantTier | undefined) ?? 'aggregate';
      stampBettingThreshold(entry.family_A.per_signal, tier, cellSeedOffset(entry.key));
    }
  }
  if (baselineCells.aggregate_fallback.family_A?.per_signal) {
    stampBettingThreshold(
      baselineCells.aggregate_fallback.family_A.per_signal, 'aggregate', 0);
  }
}

/** Stamp per-cell family_D using the cell's tier ρ (forward-compat). */
function stampPerCellFamilyD(
  baselineCells: BaselineCellsConfig, perTierFamilyD: PerTierFamilyD,
): void {
  for (const entry of baselineCells.cells) {
    const tier = entry.key.tenant_tier as TenantTier | undefined;
    const tierFD = tier ? perTierFamilyD[tier] : perTierFamilyD.aggregate;
    if (Object.keys(tierFD).length > 0) {
      entry.family_D = tierFD;
    }
  }
}

/** W4 + Q2.B.6.x — attach Family D and run the joint-AR(1) Cholesky /
 *  sliding-buffer Hotelling / betting stamping + consistency audits.
 *  Drives the full block previously inlined in `main()`. Mutates
 *  baselineCells in place. */
export function attachFamilyDAndStamp(
  bundle: BaselineBundle,
  baselineCells: BaselineCellsConfig,
  tenantTierMap: Record<string, TenantTier> | null,
  compilerOpts: CompilerOptions,
  effective: EffectiveConfig | null,
  alphaTotal: number,
  familyDAlphaFraction: number,
  familyCSignals: readonly string[],
  familyASignalsLength: number,
): void {
  // Post-#28: when profile is active, read D's α directly; legacy path
  // keeps the FAMILY_D_ALPHA_FRACTION scalar.
  const alphaDBoot = effective
    ? effective.alpha_allocation.per_family.D
    : alphaTotal * familyDAlphaFraction;
  const useLegacyD = compilerOpts.force_legacy_family_d === true;

  const perTierSignal = collectPerTierSignal(bundle, tenantTierMap);
  const perTierFamilyD = fitPerTierFamilyD(perTierSignal, alphaDBoot, useLegacyD);

  // Aggregate-tier ρ + threshold lands on aggregate_fallback.
  baselineCells.aggregate_fallback.family_D = perTierFamilyD.aggregate;

  // Forward-compat: stamp per-cell family_D using the cell's tier ρ.
  stampPerCellFamilyD(baselineCells, perTierFamilyD);

  // Q2.B.7 + Q2.B.6.1 — stamp cholesky_L_eps on every Family C cell.
  stampJointAR1CholeskyAll(baselineCells, perTierFamilyD, familyCSignals);

  // Q2.B.6.2 — Family C sliding-buffer Hotelling recalibration.
  stampSlidingBufferHotellingAll(baselineCells, perTierFamilyD, familyCSignals);

  // Q2.B.6.1 Step 2 — integration-state-audit.
  auditAR1FactorizationConsistency(baselineCells, perTierFamilyD, familyCSignals);

  // Q2.B.6.2 — sliding-buffer Hotelling threshold consistency audit.
  auditSlidingBufferHotellingConsistency(baselineCells, familyCSignals);

  // Q2.B.6.3 — Family A betting sliding-buffer recalibration.
  stampBettingSlidingBufferAll(
    baselineCells, perTierFamilyD, effective, alphaTotal, familyASignalsLength);

  // Q2.B.6.3 — sliding-buffer betting threshold consistency audit.
  auditBettingSlidingBufferConsistency(baselineCells);
}
