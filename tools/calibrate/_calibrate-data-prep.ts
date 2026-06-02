// tools/calibrate/_calibrate-data-prep.ts — argument parsing, bundle
// loading, and per-cell sample/row collection. Extracted VERBATIM from the
// pre-split tools/calibrate.ts god-file (D-54-3 god-file decomposition).
// No numeric or behavioral change.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BaselineBundle, TenantTier,
} from '../../engine/types';
import type { CellDimensionDeficiencyMode } from '../profile-loader.js';
import type {
  Args, CellSamples2D, FamilyCRowsPerCell,
} from './_calibrate-types.js';
import { EMITTED_TIERS, FAMILY_C_SIGNALS } from './_calibrate-constants.js';

/** Q2.B.4 (REPLY-52gk §TPM-ask-2; Q2-B-4-CALIBRATION-COHERENCE-SPEC.md) —
 *  local Cholesky for the shrunk-Σ aggregate-fallback path. Mirror of
 *  `engine/resamplers/cholesky.ts`; avoids engine import from a compile-
 *  time tool. Diagonal regularized via `max(s, 1e-12)`. */
export function choleskyLowerTriangularLocal(Sigma: number[][]): number[][] {
  const p = Sigma.length;
  const L: number[][] = [];
  for (let i = 0; i < p; i++) L.push(new Array(p).fill(0));
  for (let j = 0; j < p; j++) {
    let sum = Sigma[j][j];
    for (let k = 0; k < j; k++) sum -= L[j][k] * L[j][k];
    const pivot = Math.sqrt(Math.max(sum, 1e-12));
    L[j][j] = pivot;
    for (let i = j + 1; i < p; i++) {
      let s = Sigma[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = s / pivot;
    }
  }
  return L;
}

export function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1] !== undefined) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (!args.baseline) throw new Error('--baseline <dir> required');
  if (!args.out)      throw new Error('--out <file> required');
  const covMethodRaw = args.covariance_method_override;
  let covMethod: 'ledoit_wolf' | 'mcd' | 'mrcd' | undefined;
  if (covMethodRaw === 'ledoit_wolf' || covMethodRaw === 'mcd' || covMethodRaw === 'mrcd') {
    covMethod = covMethodRaw;
  } else if (covMethodRaw !== undefined) {
    throw new Error(`--covariance_method_override must be one of ledoit_wolf | mcd | mrcd; got ${covMethodRaw}`);
  }
  const forceLegacyRaw = args.force_legacy_family_c;
  const forceLegacyFamilyC = forceLegacyRaw === undefined ? undefined
    : (forceLegacyRaw === 'false' ? false : true);
  const forceLegacyDRaw = args.force_legacy_family_d;
  const forceLegacyFamilyD = forceLegacyDRaw === undefined ? undefined
    : (forceLegacyDRaw === 'false' ? false : true);
  const forceLegacyERaw = args.force_legacy_family_e;
  const forceLegacyFamilyE = forceLegacyERaw === undefined ? undefined
    : (forceLegacyERaw === 'false' ? false : true);
  const familyESelectorRaw = args.family_E_variant_selector;
  let familyESelector:
    'auto' | 'force_weighted' | 'force_weighted_e_value' | 'force_unweighted' | undefined;
  if (familyESelectorRaw !== undefined) {
    if (
      familyESelectorRaw === 'auto' ||
      familyESelectorRaw === 'force_weighted' ||
      familyESelectorRaw === 'force_weighted_e_value' ||
      familyESelectorRaw === 'force_unweighted'
    ) {
      familyESelector = familyESelectorRaw;
    } else {
      throw new Error(
        `--family_E_variant_selector must be one of auto | force_weighted | `
        + `force_weighted_e_value | force_unweighted; got ${familyESelectorRaw}`,
      );
    }
  }
  return {
    baseline: args.baseline,
    alpha:    args.alpha ? parseFloat(args.alpha) : 1e-3,
    out:      args.out,
    families: (args.families ?? 'B').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    covariance_method_override: covMethod,
    mcd_alpha: args.mcd_alpha ? parseFloat(args.mcd_alpha) : undefined,
    family_e_halflife_days: args.family_e_halflife_days ? parseFloat(args.family_e_halflife_days) : undefined,
    force_legacy_family_c: forceLegacyFamilyC,
    family_c_shrink_fraction: args.family_c_shrink_fraction ? parseFloat(args.family_c_shrink_fraction) : undefined,
    force_legacy_family_d: forceLegacyFamilyD,
    force_legacy_family_e: forceLegacyFamilyE,
    family_E_variant_selector: familyESelector,
    profile_ref: args.profile_ref,
    customer_override_ref: args.customer_override_ref,
    disable_worker_pool: args.disable_worker_pool === undefined
      ? undefined
      : args.disable_worker_pool !== 'false',
    cell_dimension_deficiency_mode:
      args.cell_dimension_deficiency_mode === 'warn'
      || args.cell_dimension_deficiency_mode === 'error'
      || args.cell_dimension_deficiency_mode === 'silent'
        ? args.cell_dimension_deficiency_mode as CellDimensionDeficiencyMode
        : undefined,
    demo_baseline_patch: args.demo_baseline_patch,
  };
}

export function loadBundle(dir: string): BaselineBundle {
  const abs = path.resolve(process.cwd(), dir);
  const manifestPath = path.join(abs, 'manifest.json');
  const bundlePath   = path.join(abs, 'bundle.jsonl');
  if (!fs.existsSync(manifestPath)) throw new Error('manifest.json missing in ' + abs);
  if (!fs.existsSync(bundlePath))   throw new Error('bundle.jsonl missing in '   + abs);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const lines = fs.readFileSync(bundlePath, 'utf8').trim().split('\n');
  const runs: BaselineBundle['runs'] = lines.map((l) => JSON.parse(l));
  return {
    version:      manifest.version,
    generated_at: manifest.generated_at,
    seed:         manifest.seed,
    cell_dim:     manifest.cell_dim,
    runs,
  };
}

/** Flatten one signal across all runs × all ticks into a single array. */
export function flattenSignal(bundle: BaselineBundle, signal: string): number[] {
  const out: number[] = [];
  for (const run of bundle.runs) {
    const s = run.signal_series[signal];
    if (!s) continue;
    for (const v of s) out.push(v);
  }
  return out;
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)));
  return s[idx];
}

/** Collect samples into 2-D cells (hour × day) indexed further by
 *  tenant tier. Pre-#23 bundles (no tenant_id) land everything on the
 *  'aggregate' tier → cell count stays at 168 (strict-additive). Post-#23
 *  bundles with tenant_id fill the per-tier cells plus the 'aggregate'
 *  tier with cross-tenant pooled samples. */
export function collectCellSamples2D(
  bundle: BaselineBundle,
  tenantTierMap: Record<string, TenantTier> | null,
): CellSamples2D[] {
  const twoD = bundle.cell_dim === 'hour_of_day_x_day_of_week';
  const dayCount = twoD ? 7 : 1;
  const tiers: TenantTier[] = tenantTierMap ? EMITTED_TIERS : ['aggregate'];
  const cells: CellSamples2D[] = [];
  for (const tier of tiers) {
    for (let d = 0; d < dayCount; d++) {
      for (let h = 0; h < 24; h++) {
        cells.push({ hour: h, day: twoD ? d : -1, tier, perSignal: {} });
      }
    }
  }
  const tierIndex = (tier: TenantTier): number => {
    const i = tiers.indexOf(tier);
    return i < 0 ? tiers.indexOf('aggregate') : i;
  };
  const cellIndex = (h: number, d: number, tierPos: number): number =>
    tierPos * dayCount * 24 + (twoD ? d * 24 + h : h);

  for (const run of bundle.runs) {
    const hod = run.hour_of_day;
    if (!hod) throw new Error('Run missing hour_of_day[] — regenerate the baseline with a cell-aware generator.');
    const dow = run.day_of_week;
    const runTier: TenantTier | undefined = tenantTierMap && run.tenant_id
      ? tenantTierMap[run.tenant_id] : undefined;
    for (const signal of Object.keys(run.signal_series)) {
      const values = run.signal_series[signal];
      for (let t = 0; t < values.length; t++) {
        const h = hod[t];
        const d = twoD ? (dow ? dow[t] : 0) : 0;
        // Always write to 'aggregate' tier so the fallback cell has
        // cross-tenant pooled data. When tenant_tier_map is set and we
        // know this sample's tier, also write to the per-tier cell.
        const aggregatePos = tierIndex('aggregate');
        const aggCell = cells[cellIndex(h, d, aggregatePos)];
        const aggBucket = aggCell.perSignal[signal] ?? (aggCell.perSignal[signal] = []);
        aggBucket.push(values[t]);
        if (runTier && runTier !== 'aggregate') {
          const tierPos = tierIndex(runTier);
          const tierCell = cells[cellIndex(h, d, tierPos)];
          const tierBucket = tierCell.perSignal[signal] ?? (tierCell.perSignal[signal] = []);
          tierBucket.push(values[t]);
        }
      }
    }
  }
  return cells;
}

/** Addition #23 — tiered collection for Family C rows. 'aggregate' tier
 *  always carries cross-tenant pooled data. Pre-#23 bundles (no
 *  tenant_tier_map) route all rows to 'aggregate' → 168 cells. */
export function collectFamilyCRows(
  bundle: BaselineBundle,
  tenantTierMap: Record<string, TenantTier> | null,
  jointVectorSignals: readonly string[] = FAMILY_C_SIGNALS,
): FamilyCRowsPerCell[] {
  const twoD = bundle.cell_dim === 'hour_of_day_x_day_of_week';
  const dayCount = twoD ? 7 : 1;
  const tiers: TenantTier[] = tenantTierMap ? EMITTED_TIERS : ['aggregate'];
  const cells: FamilyCRowsPerCell[] = [];
  for (const tier of tiers) {
    for (let d = 0; d < dayCount; d++) {
      for (let h = 0; h < 24; h++) {
        cells.push({ hour: h, day: twoD ? d : -1, tier, rows: [] });
      }
    }
  }
  const tierIndex = (tier: TenantTier): number => {
    const i = tiers.indexOf(tier);
    return i < 0 ? tiers.indexOf('aggregate') : i;
  };
  const idx = (h: number, d: number, tierPos: number): number =>
    tierPos * dayCount * 24 + (twoD ? d * 24 + h : h);
  const jvLen = jointVectorSignals.length;
  for (const run of bundle.runs) {
    const hod = run.hour_of_day!;
    const dow = run.day_of_week;
    // REPLY-51b v2 R4-1 — project run signal_series onto the
    // profile-driven joint_vector.signals inventory (streaming:
    // FAMILY_C_SIGNALS; batch: subset with TTFT removed; generic:
    // empty → caller skips Family C entirely).
    const sigArrays = jointVectorSignals.map((s) => run.signal_series[s]);
    if (sigArrays.some((a) => !a)) continue;
    const ticks = sigArrays[0].length;
    const runTier: TenantTier | undefined = tenantTierMap && run.tenant_id
      ? tenantTierMap[run.tenant_id] : undefined;
    const aggregatePos = tierIndex('aggregate');
    for (let t = 0; t < ticks; t++) {
      const h = hod[t];
      const d = twoD ? (dow ? dow[t] : 0) : 0;
      const row = new Array(jvLen);
      for (let s = 0; s < jvLen; s++) row[s] = sigArrays[s][t];
      cells[idx(h, d, aggregatePos)].rows.push(row);
      if (runTier && runTier !== 'aggregate') {
        cells[idx(h, d, tierIndex(runTier))].rows.push(row.slice());
      }
    }
  }
  return cells;
}

export function pushIfMissing<T>(arr: T[] | undefined, v: T): T[] {
  const a = arr ?? [];
  a.push(v);
  return a;
}
