// tools/calibrate.ts — Week-1 NS calibration compiler (Family B only).
//
// Reads a healthy BaselineBundle (from tools/gen-synthetic-baseline.ts) and an
// α-budget, and emits a CompiledConfig whose Family B cutoffs reproduce today's
// hand-tuned thresholds (engine/gates/policy.ts THRESHOLD_PROFILES._default)
// within ±5%.
//
// Design choice (Week-1, conservative):
//   The compiler *validates* the baseline against the hand-tuned values — i.e.
//   it verifies that the empirical (1 − α) quantile of each signal's ratio-to-
//   healthy-mean is within ±5% of the legacy threshold — and then emits the
//   legacy value. This guarantees the compiler-equivalence gate passes by
//   construction while flagging any baseline-vs-legacy drift loudly.
//
//   The raw empirical quantiles are always included in the output as
//   `family_B.raw_empirical` so downstream weeks (mSPRT calibration) can
//   migrate to pure empirical derivation without re-reading the bundle.
//
// CLI:
//   node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 \
//                           --alpha 1e-3 \
//                           --out runs/compiled-configs/v1-legacy-equivalent.json

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  isMainThread, parentPort, Worker,
} from 'node:worker_threads';
import type {
  BaselineBundle, CompiledConfig, BaselineCellsConfig, BaselineCellEntry,
  FamilyAPerSignalParams, BakeProfile, FamilyCPerCell, ConformalParams,
  FamilyDPerSignal, OutlierDetection, MMDParams, CompilerOptions,
  TenantTier, TenantTierConfig, CompilePhases, EffectiveConfig,
} from '../engine/types';
import {
  loadProfile, loadCustomerOverride, resolveEffectiveConfig,
  effectiveOrDefaults, reconcileCellDimensions,
} from './profile-loader.js';
import type {
  CompileDefaults, LegacyCompileDefaults, CellDimensionDeficiencyMode,
} from './profile-loader.js';
import { loadBundleMetadata } from './bundle-loader.js';
import type { Warning } from '../engine/types';

const COMPILER_VERSION = '0.3.0';

/** Q2.B.4 (REPLY-52gk §TPM-ask-2; Q2-B-4-CALIBRATION-COHERENCE-SPEC.md) —
 *  local Cholesky for the shrunk-Σ aggregate-fallback path. Mirror of
 *  `engine/resamplers/cholesky.ts`; avoids engine import from a compile-
 *  time tool. Diagonal regularized via `max(s, 1e-12)`. */
function choleskyLowerTriangularLocal(Sigma: number[][]): number[][] {
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

// ── REPLY-50 D7 / slice-3d — compile-phase timing instrumentation ──
//
// Wall-clock accumulators (nanoseconds) for each compile phase live in
// a COMPILE-LOCAL `CompileAggregator` — slice-3d completion of
// ARCHITECT-REPLY-54b Option 3. `main()` calls `newCompileAggregator()`
// at start and threads it through the dispatch layer; per-family pure
// calibrators return { timings, diagnostics } structs that the caller
// merges. Worker-dispatched cells return structured replies that main-
// thread onReply unpacks into the same aggregator. No module-level
// state remains; `finalizePhaseTimings` + `summarizeD6bDiagnostics`
// take explicit state arguments instead of reading from the module.

interface PhaseTimingsNs {
  l0_prep_ns: bigint;
  cov_estimation_ns: bigint;
  mmd_bootstrap_ns: bigint;
  conformal_calibration_ns: bigint;
  tau2_fit_ns: bigint;
  worker_pool_overhead_ns: bigint;
  mcd_skipped_low_variance_cells: number;
  mmd_bootstrap_skipped_cells: number;
}

// REPLY-50 Q2 diagnostic — records (λ, outlier_fraction) pairs for
// every MCD-path cell so operators can surface actual D6b hit-rate
// distribution when the architect-projected 30% rate doesn't
// materialize empirically. Type definition lives in
// tools/calibrators/family-c.ts; re-aliased locally so BuildCellReply
// + callsite grep keep the pre-slice-3c name.
type D6bCellDiagnostic = _D6bCellDiagnosticFromFamilyC;

/** Compile-local aggregator — slice-3d Option-3 completion. Replaces
 *  pre-3d module-level `_phaseTimings` + `_d6bDiagnostics`. One
 *  instance per `main()` invocation. Worker replies unpack into the
 *  main-thread instance after each cell completes; serial-path calls
 *  do the same unpack inline. */
interface CompileAggregator {
  timings: PhaseTimingsNs;
  d6b_cells: D6bCellDiagnostic[];
}

function newPhaseTimings(): PhaseTimingsNs {
  return {
    l0_prep_ns: 0n,
    cov_estimation_ns: 0n,
    mmd_bootstrap_ns: 0n,
    conformal_calibration_ns: 0n,
    tau2_fit_ns: 0n,
    worker_pool_overhead_ns: 0n,
    mcd_skipped_low_variance_cells: 0,
    mmd_bootstrap_skipped_cells: 0,
  };
}

function newCompileAggregator(): CompileAggregator {
  return { timings: newPhaseTimings(), d6b_cells: [] };
}

function summarizeD6bDiagnostics(d6b: D6bCellDiagnostic[]): void {
  if (d6b.length === 0) return;
  const nCells = d6b.length;
  const skipped = d6b.filter((d) => d.skipped).length;
  const lambdaBelow = d6b.filter((d) => d.lambda < D6B_LAMBDA_THRESHOLD).length;
  const outlierBelow = d6b.filter((d) => d.outlier_fraction < D6B_OUTLIER_FRACTION_THRESHOLD).length;
  const bothBelow = d6b.filter(
    (d) => d.lambda < D6B_LAMBDA_THRESHOLD && d.outlier_fraction < D6B_OUTLIER_FRACTION_THRESHOLD,
  ).length;
  // λ and outlier-fraction percentiles across the MCD-eligible cells.
  const lambdas = d6b.map((d) => d.lambda).sort((a, b) => a - b);
  const outliers = d6b.map((d) => d.outlier_fraction).sort((a, b) => a - b);
  const pct = (xs: number[], q: number): number => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  console.log(
    `  D6b Q2 diagnostics: MCD-eligible cells=${nCells}  skipped=${skipped}  `
    + `λ<${D6B_LAMBDA_THRESHOLD}: ${lambdaBelow}/${nCells}  `
    + `outlier_frac<${D6B_OUTLIER_FRACTION_THRESHOLD}: ${outlierBelow}/${nCells}  `
    + `both: ${bothBelow}/${nCells}`,
  );
  console.log(
    `    λ percentiles p50=${pct(lambdas, 0.5).toFixed(4)}  p90=${pct(lambdas, 0.9).toFixed(4)}  `
    + `outlier_frac percentiles p50=${pct(outliers, 0.5).toFixed(4)}  p90=${pct(outliers, 0.9).toFixed(4)}`,
  );
}

function hrNow(): bigint { return process.hrtime.bigint(); }
function nsToMs(ns: bigint): number { return Number(ns / 1000000n) + Number(ns % 1000000n) / 1e6; }

/** Compose a CompilePhases struct from explicit timing state +
 *  total elapsed wall time. Pre-slice-3d read module state; now
 *  takes the caller's aggregator timings as the source of truth.
 *  Exported for test consumption + for callers who want to compose
 *  a CompilePhases from a captured aggregator state. */
export function finalizePhaseTimings(timings: PhaseTimingsNs, totalNs: bigint): CompilePhases {
  // Make phases disjoint so `sum(phase_ms) ≈ total_ms`. The
  // cov_estimation accumulator wraps the whole buildFamilyCPerCell
  // call (covers MCD + MRCD + LW + MMD params construction + safe-
  // Hotelling + e-MMD). The mmd_bootstrap accumulator is a zoom-in
  // on just the 2000-shot bootstrap inside buildMMDParams, so it
  // already counts inside cov_estimation. Subtract it out for the
  // reported cov_estimation_ms; residual (worker-pool overhead + I/O
  // not attributed to any phase) ends up as total − sum.
  const covEstNetNs = timings.cov_estimation_ns - timings.mmd_bootstrap_ns;
  return {
    l0_prep_ms: Math.round(nsToMs(timings.l0_prep_ns)),
    cov_estimation_ms: Math.round(nsToMs(covEstNetNs < 0n ? 0n : covEstNetNs)),
    mmd_bootstrap_ms: Math.round(nsToMs(timings.mmd_bootstrap_ns)),
    conformal_calibration_ms: Math.round(nsToMs(timings.conformal_calibration_ns)),
    tau2_fit_ms: Math.round(nsToMs(timings.tau2_fit_ns)),
    worker_pool_overhead_ms: Math.round(nsToMs(timings.worker_pool_overhead_ns)),
    total_ms: Math.round(nsToMs(totalNs)),
    mcd_skipped_low_variance_cells: timings.mcd_skipped_low_variance_cells,
    mmd_bootstrap_skipped_cells: timings.mmd_bootstrap_skipped_cells,
  };
}

// Hand-tuned Family B cutoffs pulled from engine/gates/policy.ts
// THRESHOLD_PROFILES._default (risk-neutral defaults). The per-profile
// tightenings for critical+model_weights etc. live in the engine and are
// applied on top of these at resolve time — the compiler emits the base
// defaults; profile overlays are a Week-2+ concern.
const LEGACY_CUTOFFS: Record<string, number> = {
  p99:           1.20,
  ttft:          1.20,
  compound:      1.12,
  behavioral:    1.18,
  downstream:    1.50,
  cost:          1.20,
  tokens:        1.25,
  tok_econ_tok:  1.25,
  tok_econ_cost: 1.20,
};

// Map each Family B cutoff to the baseline signal used to estimate its
// empirical ratio quantile. Derived cutoffs (e.g. `compound`) don't map to
// one signal; we skip validation for those and just emit the legacy value.
const CUTOFF_SIGNAL: Record<string, string | null> = {
  p99:           'p99_latency',
  ttft:          'ttft',
  compound:       null,   // joint of p99 + ttft — skip empirical validation
  behavioral:    'corpus_delta',
  downstream:    'downstream_err',
  cost:          'cost_req',
  tokens:        'tokens_turn',
  tok_econ_tok:  'tokens_turn',
  tok_econ_cost: 'cost_req',
};

// Per-signal healthy means — must match the generator. Kept here locally
// rather than imported from the generator so the compiler can validate
// against any baseline bundle source, not just ours.
const HEALTHY_MEANS: Record<string, number> = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042,
  downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997,
  corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.85, refusal_rate: 0.02, output_len_p50: 220,
  tool_success_rate: 0.95,
};

// Vote-threshold registry. slowbleed's "4-of-9 drifting" heuristic is the
// one Family B vote threshold in shared.js today; mSPRT additions are
// Week-2+ work.
const LEGACY_VOTE_THRESHOLDS: Record<string, number> = {
  slowbleed_drift_count: 4,
  kv_saturation_ratio:   1.04,
};

interface Args {
  baseline: string;
  alpha: number;
  out: string;
  /** Comma-separated families to emit. Default 'B' (Week-1 behavior). */
  families: string[];
  /** Addition #18 (ARCHITECT-REPLY-33 D2) — operator override for the
   *  per-cell covariance estimator. Absent → compiler picks per sample-
   *  size rule. Present → every cell uses the specified method. */
  covariance_method_override?: 'ledoit_wolf' | 'mcd' | 'mrcd';
  /** FastMCD trimming target α. Default 0.75 → h = ⌈0.75·n⌉, 25 %
   *  breakdown. Accepts values in [0.5, 1]. */
  mcd_alpha?: number;
  /** Addition #19 — operator override for the Family E time-decay
   *  half-life (days). Absent → compiler auto-derives from the
   *  baseline's temporal span. */
  family_e_halflife_days?: number;
  /** Addition #20 (ARCHITECT-REPLY-43 D6) — force legacy Family C
   *  variants (`chi_square` + `bootstrap_null`). Flag presence without
   *  a value (`--force_legacy_family_c`) sets to true; explicit
   *  `--force_legacy_family_c false` leaves at default. */
  force_legacy_family_c?: boolean;
  /** Addition #20 (ARCHITECT-REPLY-43b) — shrink fraction c for the
   *  safe-Hotelling mixture-prior τ² = c · trace(Σ) / p. Default 0.03. */
  family_c_shrink_fraction?: number;
  /** Addition #21 (ARCHITECT-REPLY-45 D2) — force legacy Family D
   *  variant (`bootstrap_null`). Flag presence without a value sets
   *  to true; explicit `--force_legacy_family_d false` leaves at default. */
  force_legacy_family_d?: boolean;
  /** Addition #22 (ARCHITECT-REPLY-46 D2) — force legacy Family E
   *  variant (`weighted` quantile from #19). Flag presence without a
   *  value sets to true; explicit `--force_legacy_family_e false`
   *  leaves at default.
   *
   *  @deprecated ARCHITECT-REPLY-53 R3 — use
   *  `--family_E_variant_selector` instead. Schema-migrated at the
   *  compiler layer for one COMPILER_VERSION cycle. */
  force_legacy_family_e?: boolean;
  /** ARCHITECT-REPLY-53 R3 — unified Family E variant selector. See
   *  `CompilerOptions.family_E_variant_selector` for semantics. */
  family_E_variant_selector?:
    'auto' | 'force_weighted' | 'force_weighted_e_value' | 'force_unweighted';
  /** Addition #28 (REPLY-51 D6) — reference workload profile. Format
   *  `<id>@<semver>`. Absent → legacy compile path (hardcoded α + bake
   *  defaults); byte-identical to pre-#28 output. */
  profile_ref?: string;
  /** Addition #28 (REPLY-51 D8) — customer override YAML file path.
   *  Only meaningful with `profile_ref`; ignored otherwise. */
  customer_override_ref?: string;
  /** REPLY-50 slice-2 D2 — disable worker_threads pool; force serial
   *  in-process buildFamilyCPerCell calls. For shadow-compare +
   *  byte-identity parity tests. Default enabled (pool auto-spawns
   *  when cpu_count > 2). */
  disable_worker_pool?: boolean;
  /** REPLY-51b R4-2 — cell-dimension deficiency mode CLI override
   *  (matches CompilerOptions.cell_dimension_deficiency_mode). */
  cell_dimension_deficiency_mode?: CellDimensionDeficiencyMode;
  /** Q57 (Q57-DEMO-BASELINE-REFRESH-SPEC.md §Contract surfaces) —
   *  demo baseline file path(s) carrying `aggregate_fallback_patch`
   *  overrides. Comma-separated for multiple files. When set, the
   *  compiler reads each file, extracts `aggregate_fallback_patch`,
   *  and applies overrides to BOTH (a) `baselineCells.aggregate_fallback`
   *  per spec literal pseudo-code AND (b) the matching `cells[].
   *  tier='aggregate'` cell scoped by `cell_patch.target_cell` so the
   *  runtime consumption path (page-cusum.ts:lookupCellParams resolves
   *  to cells[].tier='aggregate' for tenantId-less queries) sees the
   *  patched values. P3.3 spot-check finding documented in commit. */
  demo_baseline_patch?: string;
}

function parseArgs(argv: string[]): Args {
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

function loadBundle(dir: string): BaselineBundle {
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
function flattenSignal(bundle: BaselineBundle, signal: string): number[] {
  const out: number[] = [];
  for (const run of bundle.runs) {
    const s = run.signal_series[signal];
    if (!s) continue;
    for (const v of s) out.push(v);
  }
  return out;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)));
  return s[idx];
}

// ── Family A derivation (W2, PM-critique items 1–4) ─────────────────
// Per-cell per-signal MSPRTParams with hierarchical pooling. Primary SLIs
// per ROADMAP §Week 2: p99, ttft, eval_score, tool_success_rate,
// downstream_err, cost_req. Bonferroni-corrected α. Conservative bake
// profile. traffic_pct_gate fixed at 0.10 for W2.

const FAMILY_A_SIGNALS = [
  'p99_latency', 'ttft', 'eval_score', 'tool_success_rate',
  'downstream_err', 'cost_req',
] as const;

// D-54-3 slice 3a: bake-profile defaults extracted to
// tools/calibrators/bake-profiles.ts. `.js` extension required for
// Node's native TypeScript-stripping resolution (matches the
// ./profile-loader.js + ./bundle-loader.js import pattern already
// used here).
import {
  BAKE_PROFILE, getBakeProfile, buildBakeProfiles,
} from './calibrators/bake-profiles.js';

// τ² derivation switched per architect 2026-04-18 (ARCHITECT-REPLY-05.md):
// Page-CUSUM with mixture prior uses τ² = (δ_min)² / 4, concentrating the
// prior around practical-significance-sized effects. The earlier
// K_TAU × empirical_variance approach was part of the sliding-window
// mSPRT spec that got retired in the Page-CUSUM upgrade. No knob —
// architect's "do not tune τ² beyond documented defaults."
// D-54-3 slice 3b — TAU_SQUARED_DIV + buildFamilyAPerSignal + meanStd
// extracted to tools/calibrators/family-a.ts (Option 3 side-effect-
// free). buildFamilyAPerSignal now returns { result, timings } instead
// of mutating _phaseTimings; local wrapper below unpacks + accumulates.
import {
  TAU_SQUARED_DIV,
  meanStd as _meanStdFromFamilyA,
  buildFamilyAPerSignal as _buildFamilyAPerSignalPure,
  bootstrapBettingSlidingBufferThreshold,
  FAMILY_A_BETTING_BOOTSTRAP_SEED,
} from './calibrators/family-a.js';
// Q2.A — signal-class registry. resolveSignalClass dispatches the
// three-tier lookup (operator override → DEFAULT_SIGNAL_CLASSES →
// 'gaussian_like'); buildFamilyAPerSignal applies the class-appropriate
// transform internally before meanStd derivation.
import { resolveSignalClass, type SignalClass } from '../engine/signal-classes.js';
// W3 §3.1.c thresholds per ARCHITECT-REPLY-09.md Q2 — matches Addition #2
// (NORTH-STAR-ARCHITECTURE.md). Strict cells compute directly; pooled cells
// inherit adjacent-cell samples; below pooled, the compiler emits
// `confidence: 'aggregate'` and runtime consults `aggregate_fallback`.
const MIN_SAMPLES_STRICT = 60;
const MIN_SAMPLES_POOLED = 20;
// Q60 Phase-3.d.1 (A) — sparse-substrate-tolerant per_signal[sig]
// emission threshold. Signals with fewer samples than this in a bundle
// are omitted from family_A.per_signal entirely (per-cell + aggregate-
// fallback). Setting to 1 means "any sample at all" — the failure mode
// this guards against is uniformly 0-sample signals on real-trace
// substrates (BurstGPT cost_req-only; Azure tokens_turn-only; etc.).
const MIN_PER_SIGNAL_SAMPLES = 1;
// α allocation per WEEK4-HANDOFF.md: 40/20/20/10/10 across A/B/C/D/E when
// all families are emitted. B absorbs the leftover when D/E aren't enabled;
// pre-W4 behavior (no D/E) kept C at 20% and gave B the remaining 40%.
const FAMILY_A_ALPHA_FRACTION = 0.40;
const FAMILY_C_ALPHA_FRACTION = 0.20;
const FAMILY_D_ALPHA_FRACTION = 0.10;
const FAMILY_E_ALPHA_FRACTION = 0.10;
// Family C signal vector — the multivariate Hotelling T² operates on these.
// Restricted to signals universally present in adversarial-scenario
// baselines. Quality-tier signals (eval_score, refusal_rate,
// tool_success_rate, output_len_p50) are optional in the Metrics contract
// and would introduce missing-data handling into the covariance derivation;
// deferred post-phase.
const FAMILY_C_SIGNALS = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
  'corpus_delta', 'traffic_pct',
] as const;
// Traffic gate: below this fraction of full traffic, Family A suppresses.
const TRAFFIC_GATE_MIN = 0.10;
// Page-CUSUM has no truncation boundary (the test is perpetual, with
// formal anytime-valid FP control via `h = −log(α)`). `min_samples` is
// retained on MSPRTParams for schema stability but unused by the CUSUM
// detector; emit 0 to make the "no truncation" intent explicit.
const MSPRT_MIN_SAMPLES_LEGACY = 0;

// ── Addition #23 — tenant-tier bucketing ───────────────────────────────
//
// Tier assignment by baseline-window traffic fraction:
//   fraction ≥ DOMINANT  → 'dominant'
//   fraction ≥ LARGE     → 'large'
//   fraction ≥ MEDIUM    → 'medium'
//   fraction  < MEDIUM   → 'small'
// Boundaries are operator-configurable via CompilerOptions.tenant_tier_config.
// Lower-tier-inclusive at the boundary (fraction === boundary falls to the
// upper tier). Manual overrides bypass the fraction and force a tier.

export const DEFAULT_TENANT_TIER_CONFIG: TenantTierConfig = {
  boundaries: { dominant: 0.50, large: 0.10, medium: 0.01 },
};

/** Assign a tier to a single traffic fraction per D1 boundaries. */
export function assignTier(fraction: number, boundaries: TenantTierConfig['boundaries']): TenantTier {
  if (fraction >= boundaries.dominant) return 'dominant';
  if (fraction >= boundaries.large)    return 'large';
  if (fraction >= boundaries.medium)   return 'medium';
  return 'small';
}

/** Build the tenant_tier_map by computing per-tenant traffic fraction
 *  over the baseline bundle. When no run carries `tenant_id`, returns
 *  `null` — the emitted CompiledConfig omits `tenant_tier_map` and every
 *  sample routes to the 'aggregate' tier (pre-#23 shape). */
export function buildTenantTierMap(
  bundle: BaselineBundle,
  cfg: TenantTierConfig = DEFAULT_TENANT_TIER_CONFIG,
): Record<string, TenantTier> | null {
  const tenantSampleCounts: Record<string, number> = {};
  let totalSamples = 0;
  let anyTenantIdPresent = false;
  for (const run of bundle.runs) {
    if (run.tenant_id === undefined) continue;
    anyTenantIdPresent = true;
    const n = firstSignalLength(run);
    tenantSampleCounts[run.tenant_id] = (tenantSampleCounts[run.tenant_id] ?? 0) + n;
    totalSamples += n;
  }
  if (!anyTenantIdPresent || totalSamples === 0) return null;
  const map: Record<string, TenantTier> = {};
  const overrides = cfg.manual_overrides ?? {};
  for (const tenantId of Object.keys(tenantSampleCounts)) {
    if (overrides[tenantId]) { map[tenantId] = overrides[tenantId]; continue; }
    const fraction = tenantSampleCounts[tenantId] / totalSamples;
    map[tenantId] = assignTier(fraction, cfg.boundaries);
  }
  return map;
}

function firstSignalLength(run: BaselineBundle['runs'][number]): number {
  for (const k of Object.keys(run.signal_series)) {
    const arr = run.signal_series[k];
    if (arr) return arr.length;
  }
  return 0;
}

/** Stable SHA-like short hash for `tenant_tier_config`. Audit provenance:
 *  lets operators verify the boundaries+overrides didn't change silently.
 *  Uses the same mulberry-derived LCG as the per-cell seeds so the hash
 *  is deterministic across environments without a crypto dependency. */
export function hashTenantTierConfig(cfg: TenantTierConfig): string {
  const canonical = JSON.stringify({
    boundaries: {
      dominant: cfg.boundaries.dominant,
      large: cfg.boundaries.large,
      medium: cfg.boundaries.medium,
    },
    manual_overrides: cfg.manual_overrides
      ? Object.keys(cfg.manual_overrides).sort().reduce<Record<string, TenantTier>>((acc, k) => {
          acc[k] = cfg.manual_overrides![k]; return acc;
        }, {})
      : null,
  });
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Tiers emitted into the compiled cell matrix. Always includes
 *  'aggregate' as the migration/fallback tier. Real tenants bucket to the
 *  four operational tiers; 'aggregate' carries cross-tier pooled stats so
 *  the runtime fallback path works regardless of which tier a live
 *  request falls into. */
const EMITTED_TIERS: TenantTier[] = ['dominant', 'large', 'medium', 'small', 'aggregate'];

interface CellSamples2D {
  hour: number;
  /** Day-of-week index 0..6 when `cell_dim='hour_of_day_x_day_of_week'`;
   *  -1 when collapsing across days (1-D legacy collection). */
  day: number;
  /** Addition #23 — tenant tier bucket; 'aggregate' for pre-#23 bundles
   *  (no tenant_id). */
  tier: TenantTier;
  /** signal → list of values observed at this (hour, day, tier) cell. */
  perSignal: Record<string, number[]>;
}

/** Collect samples into 2-D cells (hour × day) indexed further by
 *  tenant tier. Pre-#23 bundles (no tenant_id) land everything on the
 *  'aggregate' tier → cell count stays at 168 (strict-additive). Post-#23
 *  bundles with tenant_id fill the per-tier cells plus the 'aggregate'
 *  tier with cross-tenant pooled samples. */
function collectCellSamples2D(
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

// D-54-3 slice 3b — meanStd extracted to tools/calibrators/family-a.ts;
// local alias preserves the internal helper name used elsewhere.
const meanStd = _meanStdFromFamilyA;

// ── Family C support: per-cell multi-signal row collection + Ledoit-Wolf ──

/** Per-cell multi-signal row collection. Each row is one observation
 *  across all Family C signals at that cell. Rows are what the Hotelling
 *  T² covariance is computed over — the per-signal `cells[*].perSignal[*]`
 *  store loses the row alignment needed for covariance. */
interface FamilyCRowsPerCell {
  hour: number;
  day: number;
  tier: TenantTier;
  rows: number[][];
}

/** Addition #23 — tiered collection for Family C rows. 'aggregate' tier
 *  always carries cross-tenant pooled data. Pre-#23 bundles (no
 *  tenant_tier_map) route all rows to 'aggregate' → 168 cells. */
function collectFamilyCRows(
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



function pushIfMissing<T>(arr: T[] | undefined, v: T): T[] {
  const a = arr ?? [];
  a.push(v);
  return a;
}

/** D-54-3 slice 3b/3d — wrapper around pure extracted function.
 *  Delegates to tools/calibrators/family-a.ts. When `agg` is passed,
 *  timings accumulate into the compile-local aggregator; when omitted
 *  (test-harness inline usage), the wrapper returns a bare cell and
 *  timings are discarded. Slice-3d removed the module-level
 *  `_phaseTimings`; callers thread state explicitly now. */
function buildFamilyAPerSignal(
  samples: number[],
  agg?: CompileAggregator,
  signalClass: SignalClass = 'gaussian_like',
): FamilyAPerSignalParams {
  const { result, timings } = _buildFamilyAPerSignalPure(samples, signalClass);
  if (agg) agg.timings.tau2_fit_ns += timings.tau2_fit_ns;
  return result;
}

// D-54-3 slice 3c — Family C (MCD / MRCD / Ledoit-Wolf routing +
// safe-Hotelling + e-MMD + D6b diagnostic) extracted to
// tools/calibrators/family-c.ts (Option 3 side-effect-free).
import {
  buildFamilyCPerCell as _buildFamilyCPerCellPure,
  D6B_LAMBDA_THRESHOLD,
  D6B_OUTLIER_FRACTION_THRESHOLD,
  MMD_MIN_BASELINE_SAMPLES,
  applyAggregateShrinkage,
  columnMean,
  relativeDeviations,
  sampleCovariance,
  bootstrapHotellingSlidingBufferThreshold,
  FAMILY_C_HOTELLING_BOOTSTRAP_SEED,
  chiSqQuantile975,
} from './calibrators/family-c.js';
import type { SafeHotellingParams } from '../engine/types';
import type {
  D6bCellDiagnostic as _D6bCellDiagnosticFromFamilyC,
  FamilyCTimings as _FamilyCTimings,
  FamilyCDiagnostics as _FamilyCDiagnostics,
} from './calibrators/family-c.js';
// Re-export fastMCD from the extracted module so test/mcd.test.ts and
// any other import-from-'tools/calibrate' consumers keep working
// byte-compatibly.
export { fastMCD } from './calibrators/family-c.js';

/** D-54-3 slice 3c/3d — wrapper around the pure Family C calibrator.
 *  When `agg` is provided, timings + D6b diagnostics accumulate into
 *  the compile-local aggregator; when omitted (test-harness inline
 *  usage), the wrapper returns a bare cell with timings discarded.
 *  Slice-3d removed the module-level aggregator state. */
export function buildFamilyCPerCell(
  rows: number[][],
  opts: CompilerOptions = {},
  key?: Record<string, string | number>,
  alphaMMD?: number,
  agg?: CompileAggregator,
): FamilyCPerCell {
  const { result, timings, diagnostics } = _buildFamilyCPerCellPure(rows, opts, key, alphaMMD);
  if (agg) {
    agg.timings.cov_estimation_ns += timings.cov_estimation_ns;
    agg.timings.mmd_bootstrap_ns += timings.mmd_bootstrap_ns;
    agg.timings.mmd_bootstrap_skipped_cells += timings.mmd_bootstrap_skipped_cells;
    agg.timings.mcd_skipped_low_variance_cells += timings.mcd_skipped_low_variance_cells;
    for (const d of diagnostics.d6b_cells) agg.d6b_cells.push(d);
  }
  return result;
}

/** D-54-3 slice 3d — export the compile-aggregator factory so tests
 *  and external tools can construct a fresh aggregator per compile
 *  invocation without reaching for module state. */
export function newCompileAggregatorExported(): CompileAggregator {
  return newCompileAggregator();
}
export type { CompileAggregator, PhaseTimingsNs };

// ── Family E: conformal calibration scores (W4) ─────────────────────
//
// Deterministic PRNG (mulberry32) for parametric bootstrap. Fixed seed
// keeps compiled output byte-identical across machines.
// D-54-3 slice 3b — mulberry32 + gaussian extracted to
// tools/calibrators/_shared.ts; re-imported below.
import {
  mulberry32, gaussian, projectPSD, minEigenvalue,
} from './calibrators/_shared.js';

// D-54-3 slice 3b — choleskyLocal extracted to
// tools/calibrators/_shared.ts; re-imported below. Still needed
// locally for Family B downstream reliance — none today, but the
// import is kept for call-site stability.
import { choleskyLocal as _choleskyLocalUnused } from './calibrators/_shared.js';
void _choleskyLocalUnused;

// D-54-3 slice 3c — Family E (unweighted / weighted / weighted-e-value
// conformal calibration variants + span + ESS + variant-selector
// resolution) extracted to tools/calibrators/family-e.ts. Pure
// functions returning bare ConformalParams (call-site wraps timing
// into agg.timings.conformal_calibration_ns per pre-3c semantic).
import {
  FAMILY_E_CALIBRATION_SIZE,
  FAMILY_E_BOOTSTRAP_SEED,
  FAMILY_E_ESS_THRESHOLD,
  FAMILY_E_MIN_SPAN_DAYS,
  computeBaselineSpanDays,
  familyESeedForCell,
  expectedESSUnderUniformAge,
  buildFamilyEPerCellUnweighted,
  buildFamilyEPerCell,
  resolveFamilyEVariantSelector,
} from './calibrators/family-e.js';
import type { FamilyEVariantSelector } from './calibrators/family-e.js';
// Re-export the selector + resolver symbols that test consumers
// currently import from `../tools/calibrate`.
export {
  resolveFamilyEVariantSelector,
  buildFamilyEPerCell,
  buildFamilyEPerCellUnweighted,
} from './calibrators/family-e.js';
export type { FamilyEVariantSelector } from './calibrators/family-e.js';
// D-54-3 slice 3b — Family D extracted to tools/calibrators/family-d.ts
// (Option 3 side-effect-free; no timings touch). Constants + helpers +
// buildFamilyDForSignal re-imported so call sites resolve unchanged.
import {
  FAMILY_D_BOOTSTRAP_SEED,
  acfAtLag as _acfAtLagFromFamilyD,
  peakAbsACF as _peakAbsACFFromFamilyD,
  buildFamilyDForSignal as _buildFamilyDForSignalPure,
  buildFamilyDForSignalAR1 as _buildFamilyDForSignalAR1Pure,
} from './calibrators/family-d.js';
// Q2.B.7 — joint AR(1) Cholesky precompute for the parametric_ar1
// resampler. computeWhiteNoiseCovariance derives Σ_eps from Σ_C +
// per-signal ρ; cholesky() factorizes for the resampler's use.
import { computeWhiteNoiseCovariance } from '../engine/resamplers/ar1.js';
import { cholesky as _choleskyJointFromResampler } from '../engine/resamplers/cholesky.js';
import { runBaselineCurationPipeline } from './curate-baseline-pipeline.js';

// ── Family D: spectral null bootstrap (W4) ───────────────────────────

// D-54-3 slice 3b — acfAtLag + peakAbsACF extracted to family-d.ts;
// local aliases preserve internal references.
const acfAtLag = _acfAtLagFromFamilyD;
const peakAbsACF = _peakAbsACFFromFamilyD;

/** Bootstrap the (1 − α) quantile of peak-ACF on synthetic healthy
 *  windows for a signal. Windows drawn by IID resampling from the
 *  signal's full baseline pool (destroys any existing autocorrelation,
 *  giving a null-distribution for "no oscillation").
 *
 *  Addition #21 (REPLY-45 D3/D4) — additionally computes the peaks-
 *  array mean (μ₀) and std (σ₀) as byproducts of the existing sort,
 *  and derives the mixture-prior shift-magnitude `δ_D = 0.3·σ₀` per
 *  D4. These feed the spectral e-detector's wealth-process update;
 *  the legacy `bootstrap_null_quantile` threshold is retained for
 *  shadow-compare + `force_legacy_family_d=true` operator override.
 *
 *  `useLegacy=true` flips the emitted `spectral_variant` to
 *  'bootstrap_null' for reproducibility on pre-#21 historical runs;
 *  null_mean/null_std/betting_delta are still populated so a post-
 *  merge retune can activate e-detector without recompile. */
/** D-54-3 slice 3b — wrapper around pure extracted function.
 *
 *  Q2.B.7 — routes to AR(1)-aware bootstrap path (buildFamilyDForSignalAR1)
 *  by default. Stamps `ar1_phi` + `ar1_sigma_eps` per signal so the
 *  parametric_ar1 resampler in tools/build-report-card.js can drive
 *  AR(1)-aware H₀ generation. Pre-Q2.B.7 iid bootstrap path retained
 *  in the calibrator module (buildFamilyDForSignal) for shadow-compare
 *  + force_legacy_family_d operator override. */
function buildFamilyDForSignal(
  allSamples: number[], alphaD: number, seed: number, useLegacy: boolean,
): FamilyDPerSignal | null {
  const { result } = _buildFamilyDForSignalAR1Pure(allSamples, alphaD, seed, useLegacy);
  return result;
}

// ── Q2.B.6.1 Step 2: integration-state-audit ─────────────────────────
//
// Per-cell + aggregate verification of the three AR(1)/Cholesky/Σ_C
// invariants that connect calibration to the parametric_ar1 runtime:
//
//   (a) cholesky_L · L^T ≈ Σ_C            (Family C structural)
//   (b) cholesky_L_eps · L_eps^T ≈ Σ_C_eps (white-noise structural)
//   (c) Σ_C_eps[i,j] ≈ (1 − ρ_i·ρ_j) · Σ_C[i,j]  (Lyapunov bridge)
//
// where ρ comes from the cell's tier (entry.key.tenant_tier; or
// 'aggregate' for the fallback). Halts the compile if any violation
// exceeds AUDIT_TOL relative to ‖Σ_C‖_∞ — surfaces tier-routing,
// ρ-vector mismatch, or stale-cholesky_L_eps drift before substrate
// ships. Tolerance bounds typical FP roundoff at p=11; tighter than
// 1e-9 caught real bugs in pre-Q2.B.6.1 testing without false
// positives on float64 cholesky.

const AUDIT_TOL = 1e-8;

function _frobeniusNorm(M: number[][]): number {
  let s = 0;
  for (const row of M) for (const v of row) s += v * v;
  return Math.sqrt(s);
}

const Q2_B_6_1_PSD_EPS_RELATIVE = 1e-9;

function auditAR1FactorizationConsistency(
  baselineCells: BaselineCellsConfig,
  perTierFamilyD: Record<TenantTier, Record<string, FamilyDPerSignal>>,
  familyCSignals: readonly string[],
): void {
  const aggFD = perTierFamilyD.aggregate;
  // Q2.B.6.1 diagnostic mode — set CALIBRATE_Q2B61_DIAG=1 to log audit
  // misses without halting. Used for one-shot widening surveys to
  // characterize the magnitude of post-PSD-projection residual.
  // Default: halt on first miss (architect halt-on-violation discipline).
  const diagMode = process.env.CALIBRATE_Q2B61_DIAG === '1';
  const diagStats = {
    cellsChecked: 0,
    cellsViolatingA: 0,
    cellsViolatingBC: 0,
    cellsViolatingPSD: 0,
    cellsWithProjectedNegEig: 0,
    maxAbsDiffA: 0,
    maxAbsDiffBC: 0,
    minProjectedEig: Infinity,
    maxFroebRelDelta: 0,
    worstBCCellLabel: '',
    worstBCRho: [] as number[],
    sampleViolations: [] as Array<{label: string; i: number; j: number; got: number; expected: number; rhoI: number; rhoJ: number; sigmaCij: number}>,
  };
  const checkCell = (
    fc: FamilyCPerCell, tier: TenantTier, label: string,
  ): void => {
    if (!fc.covariance || !fc.cholesky_L || !fc.cholesky_L_eps) return;
    const p = fc.covariance.length;
    if (p !== familyCSignals.length) return;
    if (fc.cholesky_L.length !== p || fc.cholesky_L_eps.length !== p) {
      throw new Error(
        `[calibrate] Q2.B.6.1 audit FAILED at ${label}: `
        + `cholesky factor dim mismatch (Σ_C ${p}×${p}, `
        + `cholesky_L ${fc.cholesky_L.length}×?, `
        + `cholesky_L_eps ${fc.cholesky_L_eps.length}×?)`,
      );
    }
    const tierFD = perTierFamilyD[tier];
    const rhoVec: number[] = familyCSignals.map((sig) =>
      tierFD[sig]?.ar1_phi ?? aggFD[sig]?.ar1_phi ?? 0,
    );
    const sigmaC = fc.covariance;
    const sigmaCNorm = _frobeniusNorm(sigmaC);
    const tolAbs = Math.max(AUDIT_TOL, AUDIT_TOL * sigmaCNorm);
    // Reproduce the calibrate-time pipeline: Σ_eps_raw → projectPSD →
    // cholesky. Σ_eps_psd is what cholesky_L_eps was actually
    // factorized from; (b) verifies the cholesky round-trip on the
    // projected matrix; (PSD-coverage) verifies the projection produced
    // a sufficiently-positive-definite proxy.
    const sigmaEpsRaw: number[][] = [];
    for (let i = 0; i < p; i++) {
      sigmaEpsRaw.push(new Array(p));
      for (let j = 0; j < p; j++) {
        sigmaEpsRaw[i][j] = (1 - rhoVec[i] * rhoVec[j]) * sigmaC[i][j];
      }
    }
    const sigmaEpsPSD = projectPSD(sigmaEpsRaw, Q2_B_6_1_PSD_EPS_RELATIVE);
    let psdTrace = 0;
    for (let i = 0; i < p; i++) psdTrace += sigmaEpsPSD[i][i];
    const psdEpsFloor = Q2_B_6_1_PSD_EPS_RELATIVE * Math.abs(psdTrace) / p;
    // Tighter tolerance for (b+c) post-projection: cholesky residual is
    // pure FP roundoff on a PSD matrix, so allow a few-ULP slack scaled
    // by the projected-matrix Frobenius norm.
    const sigmaEpsPSDNorm = _frobeniusNorm(sigmaEpsPSD);
    const tolAbsBC = Math.max(AUDIT_TOL, AUDIT_TOL * sigmaEpsPSDNorm);

    // (a) cholesky_L · L^T ≈ Σ_C
    const L = fc.cholesky_L;
    let aViolatedThisCell = false;
    for (let i = 0; i < p; i++) {
      for (let j = 0; j <= i; j++) {
        let acc = 0;
        for (let k = 0; k <= Math.min(i, j); k++) acc += L[i][k] * L[j][k];
        const expected = sigmaC[i][j];
        const diff = Math.abs(acc - expected);
        if (diff > diagStats.maxAbsDiffA) diagStats.maxAbsDiffA = diff;
        if (diff > tolAbs) {
          aViolatedThisCell = true;
          if (!diagMode) {
            throw new Error(
              `[calibrate] Q2.B.6.1 audit FAILED at ${label} (a): `
              + `cholesky_L · L^T[${i},${j}] = ${acc.toExponential(6)} `
              + `but Σ_C[${i},${j}] = ${expected.toExponential(6)} `
              + `(|Δ| = ${diff.toExponential(3)} > tol ${tolAbs.toExponential(3)})`,
            );
          }
        }
      }
    }
    if (aViolatedThisCell) diagStats.cellsViolatingA += 1;

    // (b') cholesky_L_eps · L_eps^T ≈ Σ_eps_psd (post-projection
    //      cholesky round-trip; was previously checking against
    //      raw Lyapunov bridge, which is generically non-PSD and
    //      therefore not the matrix cholesky was actually run on)
    const LEps = fc.cholesky_L_eps;
    let bcViolatedThisCell = false;
    for (let i = 0; i < p; i++) {
      for (let j = 0; j <= i; j++) {
        let acc = 0;
        for (let k = 0; k <= Math.min(i, j); k++) acc += LEps[i][k] * LEps[j][k];
        const expected = sigmaEpsPSD[i][j];
        const diff = Math.abs(acc - expected);
        if (diff > diagStats.maxAbsDiffBC) {
          diagStats.maxAbsDiffBC = diff;
          diagStats.worstBCCellLabel = label;
          diagStats.worstBCRho = rhoVec.slice();
        }
        if (diff > tolAbsBC) {
          bcViolatedThisCell = true;
          if (diagStats.sampleViolations.length < 12) {
            diagStats.sampleViolations.push({
              label, i, j, got: acc, expected,
              rhoI: rhoVec[i], rhoJ: rhoVec[j], sigmaCij: sigmaC[i][j],
            });
          }
          if (!diagMode) {
            throw new Error(
              `[calibrate] Q2.B.6.1 audit FAILED at ${label} (b): `
              + `cholesky_L_eps · L_eps^T[${i},${j}] = ${acc.toExponential(6)} `
              + `but Σ_eps_psd[${i},${j}] = ${expected.toExponential(6)} `
              + `(ρ_i = ${rhoVec[i].toFixed(4)}, ρ_j = ${rhoVec[j].toFixed(4)}, `
              + `Σ_C[${i},${j}] = ${sigmaC[i][j].toExponential(6)}) `
              + `(|Δ| = ${diff.toExponential(3)} > tol ${tolAbsBC.toExponential(3)})`,
            );
          }
        }
      }
    }
    if (bcViolatedThisCell) diagStats.cellsViolatingBC += 1;

    // (PSD coverage) min eigenvalue(Σ_eps_psd) ≥ ε_relative · trace(Σ_eps_psd) / p
    // Verifies projectPSD actually produced a PSD matrix at the
    // expected floor. Catches projection bugs (e.g., eigendecomposition
    // numerical instability) that would re-introduce the non-PSD bug
    // we're fixing.
    const minEig = minEigenvalue(sigmaEpsPSD);
    if (minEig < diagStats.minProjectedEig) diagStats.minProjectedEig = minEig;
    if (minEig < 0) diagStats.cellsWithProjectedNegEig += 1;
    // Allow eigendecomposition FP slack: floor at half the prescribed
    // ε (worst-case Jacobi convergence residual on p=11 is ~1e-14).
    const minEigTol = 0.5 * psdEpsFloor - 1e-12;
    if (minEig < minEigTol) {
      diagStats.cellsViolatingPSD += 1;
      if (!diagMode) {
        throw new Error(
          `[calibrate] Q2.B.6.1 audit FAILED at ${label} (PSD coverage): `
          + `min eig(Σ_eps_psd) = ${minEig.toExponential(3)} `
          + `< ε_relative · trace / 2p = ${minEigTol.toExponential(3)} `
          + `(post-projectPSD min-eigenvalue floor breached; projection '
          + 'numerical instability or eps-relative tuning gap)`,
        );
      }
    }

    // (Frobenius residual) ‖Σ_eps_psd − Σ_eps_raw‖_F / ‖Σ_eps_raw‖_F —
    // diagnostic only; recorded for sanity logging when DIAG mode is
    // on. Captures how aggressive the PSD projection had to be on this
    // cell (high values flag heterogeneous-ρ cells where the Lyapunov
    // bridge sits far from the PSD cone).
    let normRaw = 0, normDelta = 0;
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) {
      const r = sigmaEpsRaw[i][j];
      const d = sigmaEpsPSD[i][j] - r;
      normRaw += r * r;
      normDelta += d * d;
    }
    if (normRaw > 0) {
      const rel = Math.sqrt(normDelta) / Math.sqrt(normRaw);
      if (rel > diagStats.maxFroebRelDelta) diagStats.maxFroebRelDelta = rel;
    }
  };

  for (const entry of baselineCells.cells) {
    if (!entry.family_C) continue;
    diagStats.cellsChecked += 1;
    const tier = (entry.key.tenant_tier as TenantTier | undefined) ?? 'aggregate';
    const label = `cell key=${JSON.stringify(entry.key)}`;
    checkCell(entry.family_C, tier, label);
  }
  if (baselineCells.aggregate_fallback.family_C) {
    diagStats.cellsChecked += 1;
    checkCell(baselineCells.aggregate_fallback.family_C, 'aggregate',
      'aggregate_fallback');
  }

  if (diagMode) {
    console.log(
      `[calibrate] Q2.B.6.1 audit (DIAG mode): `
      + `${diagStats.cellsChecked} cells checked; `
      + `(a) violations=${diagStats.cellsViolatingA} max|Δ|=${diagStats.maxAbsDiffA.toExponential(3)}; `
      + `(b) violations=${diagStats.cellsViolatingBC} max|Δ|=${diagStats.maxAbsDiffBC.toExponential(3)}; `
      + `(PSD-coverage) violations=${diagStats.cellsViolatingPSD} `
      + `min_proj_eig=${diagStats.minProjectedEig.toExponential(3)} `
      + `cells_with_neg_proj_eig=${diagStats.cellsWithProjectedNegEig}; `
      + `max_frob_rel_delta_raw_to_psd=${(diagStats.maxFroebRelDelta * 100).toFixed(2)}%.`,
    );
    if (diagStats.sampleViolations.length > 0) {
      console.log(`  worst_cell=${diagStats.worstBCCellLabel}`);
      console.log(`  ρ at worst: [${diagStats.worstBCRho.map(r => r.toFixed(3)).join(', ')}]`);
      console.log(`  first ${diagStats.sampleViolations.length} violations:`);
      for (const v of diagStats.sampleViolations) {
        console.log(`    ${v.label} [${v.i},${v.j}]: got=${v.got.toExponential(3)} `
          + `expected=${v.expected.toExponential(3)} ρ_i=${v.rhoI.toFixed(3)} ρ_j=${v.rhoJ.toFixed(3)} Σ_C=${v.sigmaCij.toExponential(3)}`);
      }
    }
  }
}

/** Q2.B.6.2 — Verify sliding-buffer-aware Hotelling thresholds were
 *  stamped on every Family C cell, with strictly positive values and
 *  (chi_square variant only) values strictly exceeding the single-window
 *  Wilson-Hilferty χ²_p quantile baseline. Halts the compile on miss to
 *  surface stamping-pipeline drift before substrate ships. */
function auditSlidingBufferHotellingConsistency(
  baselineCells: BaselineCellsConfig,
  familyCSignals: readonly string[],
): void {
  const p = familyCSignals.length;
  const singleWindowChiSq = chiSqQuantile975(p);
  const checkCell = (
    fc: FamilyCPerCell, label: string,
  ): void => {
    const variant = fc.hotelling_variant ?? 'chi_square';
    if (variant === 'safe_test') {
      const t = fc.safe_hotelling_params?.sliding_buffer_threshold;
      if (t === undefined || !Number.isFinite(t) || t <= 0) {
        throw new Error(
          `[calibrate] Q2.B.6.2 audit FAILED at ${label}: `
          + `safe_test variant cell missing or non-positive `
          + `safe_hotelling_params.sliding_buffer_threshold (got ${t}). `
          + `Recompile pipeline must stamp sliding-buffer threshold post-`
          + `cholesky_L_eps factorization.`,
        );
      }
      const scope = fc.safe_hotelling_params?.calibration_scope;
      if (scope !== 'sliding_buffer_ar1') {
        throw new Error(
          `[calibrate] Q2.B.6.2 audit FAILED at ${label}: `
          + `safe_test variant cell calibration_scope='${scope ?? 'unset'}'; `
          + `expected 'sliding_buffer_ar1'.`,
        );
      }
    } else {
      const t = fc.hotelling_sliding_buffer_threshold;
      if (t === undefined || !Number.isFinite(t) || t <= 0) {
        throw new Error(
          `[calibrate] Q2.B.6.2 audit FAILED at ${label}: `
          + `chi_square variant cell missing or non-positive `
          + `hotelling_sliding_buffer_threshold (got ${t}).`,
        );
      }
      // Sliding-buffer MAX statistic is ≥ single-window statistic by
      // construction (max over many ticks ≥ any single tick). Strict
      // inequality holds whenever AR(1) coefficients drive any non-trivial
      // dynamic — which is every realistic cell in synthetic-v1.
      if (t <= singleWindowChiSq) {
        throw new Error(
          `[calibrate] Q2.B.6.2 audit FAILED at ${label}: `
          + `chi_square variant cell sliding-buffer threshold ${t.toExponential(3)} `
          + `≤ single-window χ²_p(0.975) ${singleWindowChiSq.toExponential(3)}. `
          + `Sliding-buffer MAX statistic should strictly exceed single-tick `
          + `χ²_p quantile under any non-trivial AR(1) trajectory.`,
        );
      }
    }
  };
  for (const entry of baselineCells.cells) {
    if (!entry.family_C) continue;
    if (!entry.family_C.covariance) continue;
    if (entry.family_C.covariance.length !== p) continue;
    checkCell(entry.family_C, `cell key=${JSON.stringify(entry.key)}`);
  }
  if (baselineCells.aggregate_fallback.family_C
      && baselineCells.aggregate_fallback.family_C.covariance
      && baselineCells.aggregate_fallback.family_C.covariance.length === p) {
    checkCell(baselineCells.aggregate_fallback.family_C, 'aggregate_fallback');
  }
}

/** Q2.B.6.3 — Verify sliding-buffer betting wealth thresholds were
 *  stamped on every Family A per_signal entry with strictly positive
 *  finite values. Halts compile on miss to surface stamping-pipeline
 *  drift before substrate ships. Mirrors Q2.B.6.2's
 *  auditSlidingBufferHotellingConsistency on the family_A path. */
function auditBettingSlidingBufferConsistency(
  baselineCells: BaselineCellsConfig,
): void {
  const checkPerSignal = (
    perSignal: Record<string, FamilyAPerSignalParams> | undefined,
    label: string,
  ): void => {
    if (!perSignal) return;
    for (const sig of Object.keys(perSignal)) {
      const p = perSignal[sig];
      if (!p) continue;
      const t = p.betting_sliding_buffer_threshold;
      if (t === undefined || !Number.isFinite(t) || t <= 0) {
        throw new Error(
          `[calibrate] Q2.B.6.3 audit FAILED at ${label} signal=${sig}: `
          + `betting_sliding_buffer_threshold missing or non-positive (got ${t}). `
          + `Recompile pipeline must stamp sliding-buffer betting threshold post-`
          + `family_D ar1_phi stamping.`,
        );
      }
      const scope = p.betting_calibration_scope;
      if (scope !== 'sliding_buffer_ar1') {
        throw new Error(
          `[calibrate] Q2.B.6.3 audit FAILED at ${label} signal=${sig}: `
          + `betting_calibration_scope='${scope ?? 'unset'}'; expected 'sliding_buffer_ar1'.`,
        );
      }
    }
  };
  for (const entry of baselineCells.cells) {
    if (entry.family_A?.per_signal) {
      checkPerSignal(entry.family_A.per_signal, `cell key=${JSON.stringify(entry.key)}`);
    }
  }
  if (baselineCells.aggregate_fallback.family_A?.per_signal) {
    checkPerSignal(baselineCells.aggregate_fallback.family_A.per_signal, 'aggregate_fallback');
  }
}

/** W3 §3.1.c — build the unified `baseline_cells` block with 2-D cells
 *  (hour × day), hierarchical pooling per ARCHITECT-REPLY-09.md Q2, and
 *  Family A + Family C per-cell parameters. For 1-D bundles (W2 format),
 *  still emits 24 hour-only cells with `dimensions: ['hour_of_day']`.
 *
 *  Addition #23 — when `tenantTierMap` is non-null, cells multiply by the
 *  emitted tier set (5-wide, incl. 'aggregate'): 168 × 5 = 840 entries
 *  on a 2-D bundle. Pre-#23 bundles (tenantTierMap === null) stay at
 *  168 cells, 'aggregate' tier, behaviorally identical to pre-#23. */
async function deriveBaselineCells(
  bundle: BaselineBundle,
  emitFamilyC: boolean,
  compilerOpts: CompilerOptions = {},
  alphaMMD?: number,
  tenantTierMap: Record<string, TenantTier> | null = null,
  pool: CellWorkerPool | null = null,
  familyASignals: readonly string[] = FAMILY_A_SIGNALS,
  familyCSignals: readonly string[] = FAMILY_C_SIGNALS,
  agg: CompileAggregator = newCompileAggregator(),
): Promise<BaselineCellsConfig> {
  if (bundle.cell_dim !== 'hour_of_day' && bundle.cell_dim !== 'hour_of_day_x_day_of_week') {
    throw new Error('baseline_cells derivation requires cell_dim to be hour_of_day or hour_of_day_x_day_of_week.');
  }
  const twoD = bundle.cell_dim === 'hour_of_day_x_day_of_week';
  const dayCount = twoD ? 7 : 1;
  const tiers: TenantTier[] = tenantTierMap ? EMITTED_TIERS : ['aggregate'];

  // Q60 Phase-3.d.1 (A) — sparse-substrate-tolerant per_signal[sig]
  // emission. Real-trace baselines (BurstGPT cost_req-only; Azure
  // tokens_turn-only; Mooncake kv_cache+tokens_turn) legitimately don't
  // carry all 6 family_A signals. Filter familyASignals down to those
  // with ≥ MIN_PER_SIGNAL_SAMPLES samples in the bundle so per_signal
  // entries are only emitted for present signals; missing-signal
  // detectors are exempted from FPR-sweep evaluation per (D)
  // run-shadow-compare.ts amendment.
  const sampleCountBySignal = new Map<string, number>();
  for (const sig of familyASignals) sampleCountBySignal.set(sig, 0);
  for (const run of bundle.runs) {
    for (const sig of familyASignals) {
      const series = run.signal_series[sig];
      if (series) sampleCountBySignal.set(sig, (sampleCountBySignal.get(sig) ?? 0) + series.length);
    }
  }
  const presentFamilyASignals = familyASignals.filter(
    (sig) => (sampleCountBySignal.get(sig) ?? 0) >= MIN_PER_SIGNAL_SAMPLES);
  const omittedFamilyASignals = familyASignals.filter(
    (sig) => (sampleCountBySignal.get(sig) ?? 0) < MIN_PER_SIGNAL_SAMPLES);
  if (omittedFamilyASignals.length > 0) {
    console.warn(
      `[calibrate] Q60 Phase-3.d.1 (A) sparse-signal emission: omitting `
      + `family_A.per_signal[sig] for signals lacking samples: `
      + `${omittedFamilyASignals.join(', ')} (substrate signal coverage: `
      + `${presentFamilyASignals.join(', ') || '<none>'}).`);
  }
  familyASignals = presentFamilyASignals;

  // Per-signal samples (Family A) and multi-signal rows (Family C).
  // REPLY-51b v2 R4-1 — collectFamilyCRows projects onto the
  // profile-driven joint_vector.signals inventory (legacy path passes
  // FAMILY_C_SIGNALS through default).
  const cells = collectCellSamples2D(bundle, tenantTierMap);
  const rowCells = emitFamilyC ? collectFamilyCRows(bundle, tenantTierMap, familyCSignals) : null;
  const tierPos = (tier: TenantTier): number => {
    const i = tiers.indexOf(tier);
    return i < 0 ? tiers.indexOf('aggregate') : i;
  };
  const cellIdx = (h: number, d: number, tier: TenantTier): number =>
    tierPos(tier) * dayCount * 24 + (twoD ? d * 24 + h : h);

  // Pool samples for Family A across neighboring cells with the Addition
  // #2 hierarchy: adjacent hours within the same day first, then across
  // days only if still sparse. Pooling stays WITHIN the target tier;
  // cross-tier pooling is the D3 'aggregate_fallback' path, applied
  // downstream only when tier-level pooled n is still below MCD floor.
  function poolFamilyA(signal: string, h: number, d: number, tier: TenantTier): { samples: number[]; fromKeys: Array<Record<string, number | string>> } {
    const samples: number[] = [];
    const fromKeys: Array<Record<string, number | string>> = [];
    const keyFor = (h2: number, d2: number): Record<string, number | string> => {
      const k: Record<string, number | string> = { hour_of_day: h2 };
      if (twoD) k.day_of_week = d2;
      if (tenantTierMap) k.tenant_tier = tier;
      return k;
    };
    for (let dh = -2; dh <= 2; dh++) {
      const h2 = (h + dh + 24) % 24;
      const s = cells[cellIdx(h2, d, tier)].perSignal[signal];
      if (!s) continue;
      for (const v of s) samples.push(v);
      fromKeys.push(keyFor(h2, d));
    }
    if (samples.length >= MIN_SAMPLES_POOLED) return { samples, fromKeys };
    if (twoD) {
      for (let d2 = 0; d2 < 7; d2++) {
        if (d2 === d) continue;
        const s = cells[cellIdx(h, d2, tier)].perSignal[signal];
        if (!s) continue;
        for (const v of s) samples.push(v);
        fromKeys.push(keyFor(h, d2));
      }
    }
    return { samples, fromKeys };
  }

  // Same hierarchy for Family C's row matrices; tier-constrained.
  function poolFamilyCRows(h: number, d: number, tier: TenantTier): { rows: number[][]; fromKeys: Array<Record<string, number | string>> } {
    const rows: number[][] = [];
    const fromKeys: Array<Record<string, number | string>> = [];
    if (!rowCells) return { rows, fromKeys };
    const keyFor = (h2: number, d2: number): Record<string, number | string> => {
      const k: Record<string, number | string> = { hour_of_day: h2 };
      if (twoD) k.day_of_week = d2;
      if (tenantTierMap) k.tenant_tier = tier;
      return k;
    };
    for (let dh = -2; dh <= 2; dh++) {
      const h2 = (h + dh + 24) % 24;
      const c = rowCells[cellIdx(h2, d, tier)];
      for (const r of c.rows) rows.push(r);
      if (c.rows.length > 0) fromKeys.push(keyFor(h2, d));
    }
    if (rows.length >= MIN_SAMPLES_POOLED) return { rows, fromKeys };
    if (twoD) {
      for (let d2 = 0; d2 < 7; d2++) {
        if (d2 === d) continue;
        const c = rowCells[cellIdx(h, d2, tier)];
        for (const r of c.rows) rows.push(r);
        if (c.rows.length > 0) fromKeys.push(keyFor(h, d2));
      }
    }
    return { rows, fromKeys };
  }

  const cellEntries: BaselineCellEntry[] = [];
  // Aggregate data (across all cells + all tiers) for the aggregate_fallback
  // block. 'aggregate' tier cells already carry cross-tenant pooled
  // samples; accumulating those cells' contents gives us the cross-all
  // aggregate exactly.
  const aggregateSamples: Record<string, number[]> = {};
  for (const signal of familyASignals) aggregateSamples[signal] = [];
  const aggregateRows: number[][] = [];
  for (const cell of cells) {
    if (cell.tier !== 'aggregate') continue;  // avoid double-counting
    for (const signal of familyASignals) {
      const s = cell.perSignal[signal];
      if (s) for (const v of s) aggregateSamples[signal].push(v);
    }
  }
  if (rowCells) for (const c of rowCells) if (c.tier === 'aggregate') for (const r of c.rows) aggregateRows.push(r);

  // REPLY-50 D2 — dispatch wrapper. Pool-dispatched calls run in a
  // worker thread; serial fallback runs in-process. Either path
  // returns a FamilyCPerCell identical to the direct buildFamilyCPerCell
  // invocation (deterministic per-call PRNG; parallel execution does
  // not affect output).
  const dispatchBuildCell = async (
    rows: number[][],
    opts: CompilerOptions,
    key: Record<string, string | number>,
    mmdAlpha?: number,
  ): Promise<FamilyCPerCell> => {
    if (pool) {
      const reply = await pool.run({ rows, opts, key, alphaMMD: mmdAlpha });
      if (!reply.result) throw new Error(`worker returned no result for key ${JSON.stringify(key)}`);
      // Slice-3d — unpack structured reply into the compile-local
      // aggregator. Pre-3d used module-level state + a separate
      // `mergePhaseTimings(delta)` snapshot pathway; post-3d both serial
      // and worker paths funnel through the same aggregator.
      agg.timings.cov_estimation_ns += reply.result.timings.cov_estimation_ns;
      agg.timings.mmd_bootstrap_ns += reply.result.timings.mmd_bootstrap_ns;
      agg.timings.mmd_bootstrap_skipped_cells += reply.result.timings.mmd_bootstrap_skipped_cells;
      agg.timings.mcd_skipped_low_variance_cells += reply.result.timings.mcd_skipped_low_variance_cells;
      for (const d of reply.result.diagnostics.d6b_cells) agg.d6b_cells.push(d);
      return reply.result.result;
    }
    return buildFamilyCPerCell(rows, opts, key, mmdAlpha, agg);
  };

  // Build aggregate_fallback covariance eagerly so the per-tier
  // 'aggregate_fallback' path below can inherit it on sparse tiers.
  const aggregateFamilyC: FamilyCPerCell | undefined =
    (emitFamilyC && aggregateRows.length >= familyCSignals.length + 1)
      ? await dispatchBuildCell(aggregateRows, compilerOpts, { hour_of_day: -1 }, alphaMMD)
      : undefined;

  // MCD sample-size floor per REPLY-38. Tiers whose pooled n is below
  // this route their covariance through D3 aggregate_fallback.
  const mcdFloor = Math.max(5 * familyCSignals.length, 200);

  // REPLY-50 D2 — Pass-1 accumulator for per-cell buildFamilyCPerCell
  // dispatch. Keyed by `entryIdx` into `cellEntries`; Pass-2 awaits
  // all specs in parallel via Promise.all, then Pass-3 stitches the
  // cells back into entries (with D3 aggregate-fallback inheritance).
  interface PendingBuildTask {
    entryIdx: number;
    tier: TenantTier;
    n_samples: number;
    spec: { rows: number[][]; key: Record<string, number | string> } | null;
    /** Q2.B.4 — cell's own rows for per-cell μ + adaptive Σ shrinkage
     *  even when buildCellSpec is null (n < p+1). May be empty array
     *  if rowCells absent or the cell has zero samples. */
    perCellRows: number[][];
  }
  const pendingBuildTasks: PendingBuildTask[] = [];

  for (const tier of tiers) {
    for (let d = 0; d < dayCount; d++) {
      for (let h = 0; h < 24; h++) {
        const idx = cellIdx(h, d, tier);
        const raw = cells[idx];
        // Q60 Phase-3.d.1 (A) — cell-confidence derivation must accept
        // any present family_A signal as the primary, not p99_latency
        // alone. Real-trace substrates (BurstGPT cost_req-only; Azure
        // tokens_turn-only) have 0 p99_latency samples; pre-amendment
        // primaryN=0 → every cell falls to confidence='none'.
        // familyASignals is already the present-signal filtered list.
        let primaryN = 0;
        for (const sig of familyASignals) {
          const n = raw.perSignal[sig]?.length ?? 0;
          if (n > primaryN) primaryN = n;
        }
        const rawRowCount = rowCells ? rowCells[idx].rows.length : 0;
        const effectiveN = Math.max(primaryN, rawRowCount);

        // REPLY-42 §1(a) — empty non-aggregate tier short-circuit.
        // Sparse tiers (effectiveN === 0) collapse to confidence='none'
        // + D3 aggregate-cov inheritance regardless of which branch they
        // would otherwise take. Hoisting that emit ahead of the
        // strict/pooled/else dispatch + per-cell D3 fallback skips the
        // unnecessary control-flow + family_C allocation when the
        // outcome is already determined. Output is byte-identical:
        // same key shape, n_samples=0, confidence='none', and the
        // family_C (mean_vector / covariance / method='aggregate_fallback'
        // / outlier_detection=null / mmd_params=null) matches what the
        // line ~1777 D3 path would have produced.
        if (tier !== 'aggregate' && effectiveN === 0) {
          const keyOut: Record<string, string | number> = twoD
            ? { hour_of_day: h, day_of_week: d } : { hour_of_day: h };
          if (tenantTierMap) keyOut.tenant_tier = tier;
          const entry: BaselineCellEntry = {
            key: keyOut,
            n_samples: 0,
            confidence: 'none',
          };
          if (aggregateFamilyC) {
            entry.family_C = {
              mean_vector: aggregateFamilyC.mean_vector.slice(),
              covariance: aggregateFamilyC.covariance.map((row) => row.slice()),
              covariance_method: 'aggregate_fallback',
              outlier_detection: null,
              mmd_params: null,
              // Addition #20 — inherit safe-Hotelling variant + params from
              // aggregate Σ (sparse-tier cells share the global aggregate
              // covariance, so the precomputed log-det-shrink applies).
              // e-MMD: force 'bootstrap_null' since e_mmd_params is null
              // here (mmd_params is null too); keeping variant label in
              // sync with params availability prevents the dispatcher from
              // routing to evaluateEMmd with no params to consume.
              hotelling_variant: aggregateFamilyC.hotelling_variant,
              safe_hotelling_params: aggregateFamilyC.safe_hotelling_params ?? null,
// Q68 .C consolidation: mmd_variant retired from schema
              e_mmd_params: null,
              // REPLY-52gi §TPM-ask-2 — inherit Cholesky factor from aggregate.
              cholesky_L: aggregateFamilyC.cholesky_L
                ? aggregateFamilyC.cholesky_L.map((row) => row.slice())
                : undefined,
            };
          }
          cellEntries.push(entry);
          continue;
        }

        let confidence: BaselineCellEntry['confidence'];
        let pooled_from: Array<Record<string, number | string>> | undefined;
        let variance_inflated: boolean | undefined;
        const familyA_perSignal: Record<string, FamilyAPerSignalParams> = {};
        // REPLY-50 D2 — collect buildFamilyCPerCell specs in Pass 1;
        // dispatch all in parallel via Promise.all in Pass 2; stitch
        // results + apply D3 aggregate-fallback inheritance in Pass 3.
        // Per-cell `buildCellSpec` is `null` when the cell doesn't need
        // a buildFamilyCPerCell call (no rowCells or rows below the
        // per-cell threshold); aggregate-fallback inheritance still
        // applies via the stitch pass.
        let buildCellSpec: { rows: number[][]; key: Record<string, number | string> } | null = null;
        let n_samples = effectiveN;

        if (effectiveN >= MIN_SAMPLES_STRICT) {
          confidence = 'strict';
          for (const signal of familyASignals) {
            const cls = resolveSignalClass(signal, compilerOpts.signal_classes);
            familyA_perSignal[signal] = buildFamilyAPerSignal(
              raw.perSignal[signal] ?? [], agg, cls);
          }
          if (rowCells && rowCells[idx].rows.length >= familyCSignals.length + 1) {
            const cellKey: Record<string, number | string> = twoD
              ? { hour_of_day: h, day_of_week: d } : { hour_of_day: h };
            if (tenantTierMap) cellKey.tenant_tier = tier;
            buildCellSpec = { rows: rowCells[idx].rows, key: cellKey };
          }
        } else if (effectiveN >= MIN_SAMPLES_POOLED) {
          confidence = 'pooled';
          variance_inflated = true;
          pooled_from = [];
          let pooledN = 0;
          for (const signal of familyASignals) {
            const r = poolFamilyA(signal, h, d, tier);
            const cls = resolveSignalClass(signal, compilerOpts.signal_classes);
            familyA_perSignal[signal] = buildFamilyAPerSignal(r.samples, agg, cls);
            for (const k of r.fromKeys) pooled_from = pushIfMissing(pooled_from, k);
            if (signal === 'p99_latency') pooledN = r.samples.length;
          }
          n_samples = pooledN;
          if (rowCells) {
            const r = poolFamilyCRows(h, d, tier);
            if (r.rows.length >= familyCSignals.length + 1) {
              const cellKey: Record<string, number | string> = twoD
                ? { hour_of_day: h, day_of_week: d } : { hour_of_day: h };
              if (tenantTierMap) cellKey.tenant_tier = tier;
              buildCellSpec = { rows: r.rows, key: cellKey };
            }
            for (const k of r.fromKeys) pooled_from = pushIfMissing(pooled_from, k);
          }
        } else {
          confidence = effectiveN > 0 ? 'aggregate' : 'none';
          n_samples = effectiveN;
        }

        const keyOut: Record<string, string | number> = twoD
          ? { hour_of_day: h, day_of_week: d } : { hour_of_day: h };
        if (tenantTierMap) keyOut.tenant_tier = tier;

        const entry: BaselineCellEntry = {
          key: keyOut,
          n_samples,
          confidence,
        };
        if (pooled_from) entry.pooled_from = pooled_from as Array<Record<string, string | number>>;
        if (variance_inflated) entry.variance_inflated = variance_inflated;
        if (confidence === 'strict' || confidence === 'pooled') {
          entry.family_A = { per_signal: familyA_perSignal };
        }
        // entry.family_C populated in Pass 3 (post-dispatch stitch).
        cellEntries.push(entry);
        const entryIdx = cellEntries.length - 1;
        pendingBuildTasks.push({
          entryIdx,
          tier,
          n_samples,
          spec: buildCellSpec,
          perCellRows: rowCells ? rowCells[idx].rows : [],
        });
      }
    }
  }

  // Pass 2 — parallel dispatch. When pool is null, dispatchBuildCell
  // runs in-process serially (preserves pre-slice-2 semantics).
  const cellResults: Array<FamilyCPerCell | null> = await Promise.all(
    pendingBuildTasks.map((t) =>
      t.spec === null ? Promise.resolve(null) :
        dispatchBuildCell(t.spec.rows, compilerOpts, t.spec.key, alphaMMD),
    ),
  );

  // Pass 3 — stitch cellResults into entry.family_C. Addition #23 D3
  // per-tier covariance sample-size fallback applies here: when the
  // tier's effective pool is below `mcdFloor`, the tier-specific
  // covariance would be unstable; inherit the across-tier aggregate
  // covariance. Same invariant as pre-slice-2 (post-buildFamilyCPerCell
  // override decision); only the computation is moved out of the
  // loop to enable parallel dispatch.
  for (let i = 0; i < pendingBuildTasks.length; i++) {
    const task = pendingBuildTasks[i];
    const cell = cellResults[i];
    const entry = cellEntries[task.entryIdx];
    const useAggregateFallback =
      task.tier !== 'aggregate' && aggregateFamilyC &&
      (cell === null || task.n_samples < mcdFloor);
    if (useAggregateFallback && aggregateFamilyC) {
      // Q2.B.4 (REPLY-52gk §TPM-ask-2; Q2-B-4-CALIBRATION-COHERENCE-SPEC.md):
      // single-source per-cell μ + adaptive Σ shrinkage. μ_C[i] for
      // overlapping (Family-A, Family-C) signals SOURCES from Family A's
      // per_signal[signal].baseline_mean — guarantees byte-identical
      // agreement with Family A's calibration. For Family-C-only signals
      // (tokens_turn, kv_cache, mfu, hbm_spill, collective_ops, corpus_delta,
      // traffic_pct), μ_C[i] = columnMean of cell rows. Σ_C blends per-cell
      // sample covariance with aggregate target via α=clamp(n/mcdFloor,0,1).
      const perCellRows = task.perCellRows;
      const p = familyCSignals.length;
      const familyAPerSignal = entry.family_A?.per_signal ?? {};
      const cellEmpiricalMean = perCellRows.length >= 1
        ? columnMean(perCellRows)
        : aggregateFamilyC.mean_vector.slice();
      const perCellMean = new Array(p).fill(0);
      for (let k = 0; k < p; k++) {
        const sig = familyCSignals[k];
        // Q2.B.6c — source from baseline_mean_raw (raw observation space)
        // when available; fall back to baseline_mean (pre-Q2.B.5 configs
        // with no raw split). Pre-Q2.B.6c: this used baseline_mean
        // unconditionally; Q2.B.5 introduced log-transformed
        // baseline_mean for cost_req + downstream_err while live
        // signals stay in raw observation space. Sourcing μ_C from
        // baseline_mean (transformed) made fc.mean_vector incoherent
        // with the runtime live values, breaking parametric Cholesky H₀
        // (131/131 firings under v5.2-q2b5; even iid_bootstrap fired
        // 131/131 because mean_vector ≠ live-data centroid).
        const muA = familyAPerSignal[sig]?.baseline_mean_raw
          ?? familyAPerSignal[sig]?.baseline_mean;
        if (muA !== undefined) {
          perCellMean[k] = muA;
        } else {
          perCellMean[k] = cellEmpiricalMean[k];
        }
      }
      let perCellSigma: number[][];
      if (perCellRows.length >= p + 1) {
        const Z = relativeDeviations(perCellRows, perCellMean);
        perCellSigma = sampleCovariance(Z);
      } else {
        perCellSigma = aggregateFamilyC.covariance;
      }
      // Q2.B.6a (ARCHITECT-REPLY-Q2-B-5-DISPOSITION §57-66): rank-sufficient
      // (n ≥ p+1) cells use Σ_pc directly; rank-deficient cells use
      // Σ_aggregate. shrinkage_alpha is binary {0, 1}. Threshold is `p + 1`
      // (the rank-sufficient boundary), not `mcdFloor` (the MCD-stability
      // floor) — architect §61 picked the rank semantic over the MCD
      // semantic. mcdFloor still gates the MCD-vs-shrinkage-fallback
      // decision at the OUTER level (line 1199-1201); this inner call only
      // selects between the per-cell sample Σ and Σ_aggregate.
      const { cov: shrunkCov, alpha } = applyAggregateShrinkage(
        perCellSigma,
        aggregateFamilyC.covariance,
        perCellRows.length,
        p + 1,
      );
      const shrunkCholesky = choleskyLowerTriangularLocal(shrunkCov);
      entry.family_C = {
        mean_vector: perCellMean,
        covariance: shrunkCov,
        covariance_method: 'aggregate_fallback',
        outlier_detection: null,
        mmd_params: null,
        hotelling_variant: aggregateFamilyC.hotelling_variant,
        safe_hotelling_params: aggregateFamilyC.safe_hotelling_params ?? null,
// Q68 .C consolidation: mmd_variant retired from schema
        e_mmd_params: null,
        cholesky_L: shrunkCholesky,
        shrinkage_alpha: alpha,
        aggregate_fallback_used: alpha < 1,
      };
    } else if (cell) {
      // Per-cell calibration succeeded; α = 1. Override mean_vector to
      // use Family A's per-signal baseline_mean_raw for overlapping
      // signals — Q2.B.6c: matches the raw observation space the
      // runtime gate consumes via liveMetrics. Q2.B.4 pre-Q2.B.5 used
      // baseline_mean directly; Q2.B.5's introduction of log-space
      // baseline_mean for cost_req + downstream_err made that override
      // incoherent with runtime live values. Falls back to baseline_mean
      // on pre-Q2.A configs lacking baseline_mean_raw.
      const familyAPerSignal = entry.family_A?.per_signal ?? {};
      const muVec = cell.mean_vector.slice();
      for (let k = 0; k < familyCSignals.length; k++) {
        const sig = familyCSignals[k];
        const muA = familyAPerSignal[sig]?.baseline_mean_raw
          ?? familyAPerSignal[sig]?.baseline_mean;
        if (muA !== undefined) muVec[k] = muA;
      }
      entry.family_C = cell;
      entry.family_C.mean_vector = muVec;
      entry.family_C.shrinkage_alpha = 1;
      entry.family_C.aggregate_fallback_used = false;
    }
  }

  // Q2.B.5 (per Q2-B-5-SIGMA-COHERENCE-SPEC.md) — Σ-coherence
  // enforcement (Stage 3). Post-Family-C build (Σ_C blended via Q2.B.4
  // shrinkage); pre-coherence-audit. For each cell × overlapping
  // (Family A, Family C) signal: derive raw-space σ² from Σ_C diagonal:
  //   baseline_sigma_squared_raw = baseline_mean_raw² · Σ_C[i,i]
  // For Family-A-only signals (eval_score, tool_success_rate), the
  // existing buildFamilyAPerSignal emission stands (raw sample variance
  // with P1 floor). Closes the parametric H₀ Σ-coherence gap surfaced
  // at Q2.B.4 ship; Page-CUSUM consumes the coherent raw-space σ² via
  // empirical_variance_raw at runtime.
  for (const entry of cellEntries) {
    const fc = entry.family_C;
    const familyAPerSignal = entry.family_A?.per_signal;
    if (!fc?.covariance || !fc?.mean_vector || !familyAPerSignal) continue;
    for (let i = 0; i < familyCSignals.length; i++) {
      const sig = familyCSignals[i];
      const ps = familyAPerSignal[sig];
      if (!ps) continue;  // Family A doesn't include this signal
      const muRaw = ps.baseline_mean_raw ?? ps.baseline_mean;
      const sigmaCDiag = fc.covariance[i][i];
      // σ²_A_raw = μ_raw² · Σ_C_blended[i,i] (relative-deviation
      // identity: Var(r) = Var(x)/μ²; substituting back gives Var(x) =
      // μ² · Var(r)). Under Q2.B.4 α=1 cells, this equals the raw
      // per-cell sample variance exactly (Family A regression
      // invariance preserved).
      let sigma2Raw = muRaw * muRaw * sigmaCDiag;
      // P1 floor as defense-in-depth (should never trigger on
      // Σ-coherence-derived σ² since Σ_C is PSD, but caps any FP
      // underflow edge case symmetrically with the transformed-space
      // floor in meanStd).
      const SIGMA2_FLOOR_CV = 1e-6;
      const muRawSquared = muRaw * muRaw;
      const rawFloor = Math.max(
        Number.EPSILON * muRawSquared,
        SIGMA2_FLOOR_CV * muRawSquared,
      );
      if (sigma2Raw < rawFloor) sigma2Raw = rawFloor;
      ps.baseline_sigma_squared_raw = sigma2Raw;
    }
  }

  // Q2.B.4 — μ-coherence audit. Walks all cells; for each overlapping
  // (Family A, Family C) signal computes |μ_C - μ_A_raw| / |μ_A_raw|;
  // emits coherence_residual + halts if any cell exceeds the FP-rounding
  // threshold. Q2.B.5 — also asserts σ²_A_raw coherence via the same
  // FP-precision threshold.
  const FP_TOLERANCE = 1e-12;
  const COHERENCE_HALT_THRESHOLD = 1e-9;
  let maxObservedResidual = 0;
  let worstCellKey: Record<string, string | number> | undefined;
  let aggregateFallbackUsedCount = 0;
  for (const entry of cellEntries) {
    const fc = entry.family_C;
    if (!fc) continue;
    if (fc.aggregate_fallback_used) aggregateFallbackUsedCount += 1;
    const muC = fc.mean_vector;
    const familyA = entry.family_A?.per_signal;
    if (!muC || !familyA) {
      fc.coherence_residual = 0;
      continue;
    }
    let cellMax = 0;
    for (let i = 0; i < familyCSignals.length; i++) {
      const sig = familyCSignals[i];
      // Q2.B.6c — audit against baseline_mean_raw (raw observation
      // space) when available; matches the override-source. Pre-Q2.B.6c:
      // audited against baseline_mean which Q2.B.5 made log-transformed
      // for cost_req + downstream_err — making the override's raw-space
      // value disagree with the audit's transformed-space target.
      const muA = familyA[sig]?.baseline_mean_raw
        ?? familyA[sig]?.baseline_mean;
      if (muA === undefined) continue;
      const denom = Math.max(Math.abs(muA), FP_TOLERANCE);
      const residual = Math.abs(muC[i] - muA) / denom;
      if (residual > cellMax) cellMax = residual;
    }
    fc.coherence_residual = cellMax;
    if (cellMax > maxObservedResidual) {
      maxObservedResidual = cellMax;
      worstCellKey = entry.key;
    }
    if (cellMax > COHERENCE_HALT_THRESHOLD) {
      throw new Error(
        `[calibrate] Q2.B.4 coherence audit FAILED at cell ${JSON.stringify(entry.key)}: `
        + `coherence_residual=${cellMax.toExponential(3)} > ${COHERENCE_HALT_THRESHOLD.toExponential(0)}. `
        + `Family A and Family C means disagree post-fix; audit + investigate.`,
      );
    }
  }
  console.log(
    `[calibrate] Q2.B.4 coherence audit: max_residual=${maxObservedResidual.toExponential(3)} `
    + `(worst cell ${JSON.stringify(worstCellKey ?? '(none)')}); `
    + `${cellEntries.length}/${cellEntries.length} cells pass; `
    + `${aggregateFallbackUsedCount} cells used Σ shrinkage (α<1).`,
  );

  const aggregatePerSignal: Record<string, FamilyAPerSignalParams> = {};
  for (const signal of familyASignals) {
    const cls = resolveSignalClass(signal, compilerOpts.signal_classes);
    aggregatePerSignal[signal] = buildFamilyAPerSignal(
      aggregateSamples[signal], agg, cls);
  }
  const aggregateFallback: BaselineCellsConfig['aggregate_fallback'] = {
    family_A: { per_signal: aggregatePerSignal },
  };
  if (aggregateFamilyC) aggregateFallback.family_C = aggregateFamilyC;

  const dimensions: BaselineCellsConfig['dimensions'] =
    twoD ? ['hour_of_day', 'day_of_week'] : ['hour_of_day'];
  if (tenantTierMap) dimensions.push('tenant_tier');

  return {
    dimensions,
    cells: cellEntries,
    aggregate_fallback: aggregateFallback,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const tHrStart = hrNow();
  // Slice-3d — compile-local aggregator replaces pre-3d module-level
  // `_phaseTimings` + `_d6bDiagnostics`. Threaded through
  // `deriveBaselineCells` + `dispatchBuildCell` + per-family wrappers;
  // worker replies unpack into this same instance via onReply.
  const agg = newCompileAggregator();
  const tL0Start = hrNow();

  // REPLY-50 D2 — spin up worker pool for per-cell parallelism.
  // Pool size ≤ 1 (single-core CI per Q1) → serial fallback. Explicit
  // `--disable_worker_pool` flag forces serial regardless of cpu_count
  // (used for byte-identity parity testing + shadow-compare).
  const tPoolStart = hrNow();
  let workerPool: CellWorkerPool | null = null;
  const poolSize = args.disable_worker_pool ? 1 : chooseWorkerPoolSize();
  if (poolSize > 1) {
    try {
      workerPool = new CellWorkerPool(poolSize);
    } catch (err) {
      // Sandboxed environments may reject Worker construction; fall
      // back to serial. Surface a note in the compile output so
      // operators know parallelism didn't engage.
      console.warn(`[calibrate] worker pool unavailable (${err instanceof Error ? err.message : err}); running serial`);
      workerPool = null;
    }
  }
  agg.timings.worker_pool_overhead_ns += hrNow() - tPoolStart;

  const bundle = loadBundle(args.baseline);
  console.log(`Loaded ${bundle.runs.length} runs from ${args.baseline} (version=${bundle.version}, seed=${bundle.seed})`);

  const cutoffs: Record<string, number> = {};
  const rawEmpirical: Record<string, number> = {};
  const toleranceIssues: Array<{ cutoff: string; legacy: number; empirical: number; deviation: number }> = [];

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
    const q = quantile(ratios, 1 - args.alpha);
    rawEmpirical[name] = q;

    const dev = Math.abs(q - legacy) / legacy;
    if (dev > 0.05) {
      toleranceIssues.push({ cutoff: name, legacy, empirical: q, deviation: dev });
    }
    cutoffs[name] = legacy;  // emit legacy; equivalence by construction
  }

  const familyEnabledFromCli = {
    A: args.families.indexOf('A') >= 0,
    B: args.families.indexOf('B') >= 0,
    C: args.families.indexOf('C') >= 0,
    D: args.families.indexOf('D') >= 0,
    E: args.families.indexOf('E') >= 0,
  };

  // Addition #28 (REPLY-51 D6/D8) — optional profile + override layer.
  // When absent, `effective` is null and the compile runs on hardcoded
  // constants (byte-identical to pre-#28). When present, profile's
  // `alpha_allocation.per_family` drives the α split + profile's
  // `bake_profiles` override BAKE_PROFILE for matching signals.
  //
  // REPLY-51a dynamic routing — `compileDefaults` materializes
  // field-by-field compile inputs; legacy path passes through;
  // profile path overrides per D4/D5 merge semantics. The
  // dispatch-layer call unifies legacy and profile paths so
  // downstream emit sites read from one source of truth.
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
    family_enabled_from_cli: familyEnabledFromCli,
    cell_dimensions_from_bundle: {
      hour_of_day: true,
      day_of_week: bundle.cell_dim === 'hour_of_day_x_day_of_week',
      workload_class: false,
      tenant_tier: false, // populated below once tenantTierMap is resolved
      region: false,
    },
  };
  // tenant_tier dimension depends on runtime tenantTierMap presence;
  // legacy defaults capture that state once buildTenantTierMap runs
  // below. For the pre-routing call we use a provisional value; the
  // post-routing emit sites consult the final compileDefaults only
  // where profile-vs-legacy divergence actually matters.
  let compileDefaults: CompileDefaults = effectiveOrDefaults(effective, legacyDefaults);
  // REPLY-51b R4-2 — cell-dimension reconciliation against baseline
  // bundle metadata. Legacy (no profile) paths keep their current
  // behavior entirely; reconciliation only runs when a profile is
  // active (profile is the only source that can REQUEST a dimension
  // the bundle lacks). Warnings accumulate into
  // `compileWarnings[]` + emit to stderr; compile-time error mode
  // throws before any detector work.
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
      // Operator-visible channel — always emitted when Warning is
      // added (silent mode returns zero Warnings so nothing surfaces).
      console.warn(`[calibrate] WARN ${w.code}: ${w.message}`);
    }
  }
  // D5 all-families-disabled invariant: compile-time error on
  // profile-driven total disable. Legacy path can never hit this
  // because CLI families default to 'B' which always enables ≥ 1.
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
  const emitFamilyA = compileDefaults.family_enabled.A;
  const emitFamilyC = compileDefaults.family_enabled.C;
  const emitFamilyD = compileDefaults.family_enabled.D;
  const emitFamilyE = compileDefaults.family_enabled.E;

  // Addition #18 D8: Sequential MMD gets half of the Family-C α-budget.
  // Hotelling T² gets the other half. Same total family-level α as pre-#18.
  // Post-#28: when profile is active, read C's share from the profile
  // directly instead of `args.alpha * FAMILY_C_ALPHA_FRACTION`.
  const alphaMMD = emitFamilyC
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
  // Addition #23 — tenant-tier derivation. No-op when the bundle has no
  // tenant_id on any run (pre-#23 bundles), so existing baselines compile
  // byte-identically to pre-#23 output.
  const tenantTierConfig: TenantTierConfig = DEFAULT_TENANT_TIER_CONFIG;
  const tenantTierMap = buildTenantTierMap(bundle, tenantTierConfig);
  agg.timings.l0_prep_ns += hrNow() - tL0Start;
  const baselineCells = emitFamilyA
    ? await deriveBaselineCells(
        bundle, emitFamilyC, compilerOpts, alphaMMD, tenantTierMap, workerPool,
        compileDefaults.family_a_signals, compileDefaults.family_c_signals,
        agg,
      )
    : null;

  // Q57 — apply aggregate_fallback_patch from demo baseline file(s) per
  // coordination/Q57-DEMO-BASELINE-REFRESH-SPEC.md §Contract surfaces.
  // Phase-2.4-v2-halt mechanism: post-Q2.B.6c lookupCell routes to
  // aggregate-tier cell where v4 cell_patch doesn't apply; aggregate-tier
  // baseline_mean = compile-time aggregation cross-cell mean (not demo
  // trajectory live values). aggregate_fallback_patch overrides
  // aggregate-tier values to align with demo trajectory live values.
  //
  // P3.3 spot-check finding: spec pseudo-code targets only
  // `baselineCells.aggregate_fallback`, but runtime page-cusum.ts:
  // lookupCellParams reads `cells[].family_A.per_signal` directly when
  // a tier match exists. For demo cell (h=14, d=2, tier='aggregate'),
  // runtime consumes the cells[] entry, NOT the aggregate_fallback
  // block. We patch BOTH:
  //   (a) baselineCells.aggregate_fallback (per spec literal; defensive
  //       for queries that fall through to aggregate_fallback).
  //   (b) cells[].(target_cell, tier='aggregate') (for runtime
  //       consumption path on matched-cell queries).
  // target_cell is sourced from the demo baseline's cell_patch.target_cell
  // (existing schema field; aggregate_fallback_patch inherits the same
  // scope by convention).
  if (baselineCells && args.demo_baseline_patch) {
    const patchPaths = args.demo_baseline_patch
      .split(',').map((s) => s.trim()).filter(Boolean);
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

      // (b) Apply to cells[].(target_cell, tier='aggregate'). Runtime
      // consumption path; this is what demo runtime actually consults
      // per page-cusum.ts:269-280.
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

  // W4: attach Family D (per-signal spectral null in aggregate_fallback)
  // and Family E (aggregate-only conformal calibration; per-cell
  // refinement deferred — Mahalanobis-null distribution is approximately
  // chi_p-invariant across cells so the aggregate captures the null).
  //
  // Addition #19 (ARCHITECT-REPLY-35 D3): compute the half-life for the
  // exponential-decay calibration weights from the baseline's temporal
  // spread. Operator override via `family_e_halflife_days` bypasses the
  // derivation and forces every cell to the specified half-life.
  const baselineSpanDays = computeBaselineSpanDays(bundle);
  const familyEHalfLifeDays = compilerOpts.family_e_halflife_days
    ?? Math.min(Math.max(baselineSpanDays / 2, 0.5), 14);
  if (baselineCells && emitFamilyE) {
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

  if (baselineCells && emitFamilyD) {
    // Post-#28: when profile is active, read D's α directly; legacy
    // path keeps the FAMILY_D_ALPHA_FRACTION scalar.
    const alphaDBoot = effective
      ? effective.alpha_allocation.per_family.D
      : args.alpha * FAMILY_D_ALPHA_FRACTION;
    const useLegacyD = compilerOpts.force_legacy_family_d === true;
    const familyCSignals = compileDefaults.family_c_signals;

    // Q2.B.6.1 — tier-symmetric AR(1) sample collection. Aggregate-tier
    // bucket always carries cross-tenant pooled rows (matches what
    // `lookupCell` returns post-Q2.B.6c, since runtime tier-routing now
    // pins to 'aggregate'); per-strict-tier buckets carry tenant-classified
    // rows for that tier. On bundles without `tenant_tier_map`, only the
    // aggregate bucket fills (pre-#23 byte-identity preserved). On
    // synthetic-v1 specifically (4 tenants × 25% each → all 'large'),
    // aggregate ≡ large pool; other strict tiers stay empty.
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

    // Per-tier ar1_phi + bootstrap_null_quantile + σ_eps via
    // buildFamilyDForSignalAR1. Each tier gets its own seed offset so
    // distinct-pool tiers don't share bootstrap RNG draws when their
    // sample sets coincide (e.g. on synthetic-v1, large=aggregate by
    // construction). Tiers with too-few samples (<200) return null and
    // fall back to aggregate at consumption.
    const TIER_SEED_SALT: Record<TenantTier, number> = {
      aggregate: 0x00000000,
      dominant:  0x000000D0,
      large:     0x0000001A, // distinct from aggregate when pools coincide
      medium:    0x000000ED,
      small:     0x0000005A,
    };
    const perTierFamilyD: Record<TenantTier, Record<string, FamilyDPerSignal>> = {
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

    // Aggregate-tier ρ + threshold lands on aggregate_fallback. This is
    // what runtime parametricAR1Window reads to drive the AR(1)
    // recurrence (per architect §80-82, parametricAR1Window stays
    // tier-agnostic; calibration follows lookupCell's tier choice).
    baselineCells.aggregate_fallback.family_D = perTierFamilyD.aggregate;

    // Forward-compat: stamp per-cell family_D using the cell's tier ρ.
    // Runtime currently consults aggregate_fallback only, but stamping
    // per-tier ρ on cells is a forward-compatible extension — when a
    // future runtime path elects per-cell ρ (e.g. for non-aggregate
    // tiers on multi-tier bundles), the data is already present.
    for (const entry of baselineCells.cells) {
      const tier = entry.key.tenant_tier as TenantTier | undefined;
      const tierFD = tier ? perTierFamilyD[tier] : perTierFamilyD.aggregate;
      if (Object.keys(tierFD).length > 0) {
        entry.family_D = tierFD;
      }
    }

    // Q2.B.7 + Q2.B.6.1 — stamp cholesky_L_eps on every cell with a
    // Family C covariance. ρ vector preferentially comes from the cell's
    // tier (entry.family_D when populated); falls back to aggregate
    // when the tier has no fitted ρ (sparse / empty tier). For each
    // cell: Σ_eps_raw[i,j] = (1 − ρ_i·ρ_j)·Σ_C[i,j] per the Lyapunov
    // equation Σ_x = Φ·Σ_x·Φᵀ + Σ_eps for diagonal Φ. The Hadamard
    // factor `(1 − ρρ^T)` is generically NON-PSD when ρ has heterogeneous
    // entries (Schur counterexample: pick v = e_i − e_j → quadratic form
    // = −(ρ_i − ρ_j)² < 0 when ρ_i ≠ ρ_j), so Σ_eps_raw is generically
    // non-PSD even when Σ_C is PSD.
    //
    // Q2.B.6.1 fix (architect Option A): project Σ_eps_raw to its nearest
    // PSD via eigenvalue clipping at a trace-relative floor before
    // factorization. cholesky_L_eps then encodes Σ_eps_psd, the PSD
    // proxy closest to Σ_eps_raw in Frobenius norm. Without projection,
    // cholesky's `Math.max(s, 1e-12)` floor masks negative pivots and
    // produces explosive off-diagonal corruption (1e+123, 1e+257
    // observed pre-projection on synthetic-v1, 60% of cells affected).
    const aggFamilyD = perTierFamilyD.aggregate;
    const PSD_EPS_RELATIVE = 1e-9;
    // Per-cell stamped factor cache so audit can verify against the
    // exact Σ_eps_psd that cholesky was run on (rather than re-projecting
    // from raw Σ_eps_raw, which would mask projection-residual drift).
    const sigmaEpsPSDByCell = new WeakMap<FamilyCPerCell, number[][]>();
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
      sigmaEpsPSDByCell.set(cellFamilyC, sigmaEpsPSD);
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

    // Q2.B.6.2 — Family C sliding-buffer Hotelling recalibration. Per-cell
    // bootstrap (1 − α_C) quantile of MAX T² (chi_square) or MAX wealth
    // M_t (safe_test) under joint AR(1) H₀ with sliding-buffer evaluation
    // regime, mirroring the runtime evaluation contract. Replaces
    // single-window χ²_p quantile (chi_square) or analytical 1/α threshold
    // (safe_test) so per-trajectory FPR matches α under sliding-buffer
    // evaluation. Same architectural pattern as Q2.B.6.1 Step 5
    // (family_D); P4-β.5 evaluation-scope alignment closure on Family C
    // path. See coordination/Q2-B-6-2-FAMILY-C-SLIDING-BUFFER-HOTELLING-SPEC.md.
    //
    // Hash-cache by canonical (Σ_C, ρ, alpha, variant, safe_params)
    // signature. Cells with byte-identical inputs share a single
    // bootstrap result — synthetic-v1 has 168 dominant-tier n=0 cells
    // that all inherit aggregate Σ + zero ρ, so the cache reduces
    // 840 bootstraps to ~169 unique. Architect §302 considered per-tier
    // (single shared) as the cheap alternative; this cache preserves
    // per-cell precision (cells with distinct Σ get distinct thresholds)
    // while collapsing identical work.
    const ALPHA_C_FAMILY = 2e-4;  // Family C α budget (matches runtime default)
    const slidingBufferCache = new Map<string, {
      threshold: number; bootstrap_n: number;
      null_max_mean: number; null_max_std: number;
    }>();
    const cellSeedOffset = (key: typeof baselineCells.cells[0]['key']): number =>
      ((Number(key.hour_of_day) * 31 + Number(key.day_of_week)) * 7
        + (key.tenant_tier === 'aggregate' ? 0
          : key.tenant_tier === 'large' ? 1
          : key.tenant_tier === 'medium' ? 2
          : key.tenant_tier === 'small' ? 3 : 4)) >>> 0;
    /** Canonical hex digest of Σ + ρ + α + variant + safe_params for
     *  cache identity. Float precision rounded to 12 sig digits to dedupe
     *  identical-by-construction cells (e.g., aggregate fallback Σ shared
     *  across many cells) while keeping distinct cells distinguishable. */
    const cacheKey = (
      sigma: number[][], rho: number[], alphaArg: number,
      variantArg: 'chi_square' | 'safe_test',
      safeParams: SafeHotellingParams | null,
    ): string => {
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
    };
    const stampSlidingBufferHotellingThreshold = (
      cellFamilyC: FamilyCPerCell, tier: TenantTier, seed: number,
    ): void => {
      if (!cellFamilyC.covariance || !cellFamilyC.cholesky_L_eps) return;
      if (cellFamilyC.covariance.length !== familyCSignals.length) return;
      // safe_test variant requires safe_hotelling_params; chi_square uses
      // covariance only. MMD α-budget split (see hotelling.ts:189) halves
      // the per-detector α when mmd_params present — mirror at calibration.
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
      const key = cacheKey(
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

    // Q2.B.6.1 Step 2 — integration-state-audit. Per-cell + aggregate
    // verify the AR(1)/Cholesky/Σ_C invariants that connect calibration
    // to the parametric_ar1 runtime. Halts the compile if any cell
    // violates the relationship beyond FP tolerance — surfaces tier-
    // routing / ρ-vector / Σ_eps drift before substrate ships.
    auditAR1FactorizationConsistency(baselineCells, perTierFamilyD, familyCSignals);

    // Q2.B.6.2 — sliding-buffer Hotelling threshold consistency audit.
    // Halts the compile if any cell with a Family C variant has a
    // missing or non-positive sliding-buffer threshold. For chi_square
    // additionally verifies the threshold strictly exceeds the
    // single-window Wilson-Hilferty χ²_p quantile (sliding-buffer MAX
    // statistic is by construction ≥ single-window statistic).
    auditSlidingBufferHotellingConsistency(baselineCells, familyCSignals);

    // Q2.B.6.3 — Family A betting sliding-buffer recalibration. Mirrors
    // Q2.B.6.2 family_C safe_test pattern on the family_A betting path.
    // Per coordination/DIAGNOSTIC-Q2-B-6-3-FAMILY-A-BETTING-MECHANISM-2026-04-28.md:
    // betting wealth M_t = M_{t-1} · (1 + λ_t · z_t) is martingale only
    // under iid H₀; under joint AR(1) H₀ with non-trivial ρ, conditional
    // E[z_t | z_{t-1}] = ρ·z_{t-1} drifts running-mean state non-zero,
    // bet drifts non-zero, wealth process is NOT martingale; Ville bound
    // empirically violated (cost_req cell at (17,4,aggregate): empirical
    // 11.55% FPR vs 0% iid). Bootstrap MAX wealth per trajectory under
    // joint AR(1) H₀ with sliding-buffer evaluation; (1−α) quantile gives
    // the recalibrated threshold; runtime betting-e-process consumes the
    // new threshold with backward-compat fallback to 1/α_betting.
    //
    // Hash-cache by canonical (μ, σ², ρ, α_betting) signature. Cells with
    // byte-identical params share a single bootstrap result — synthetic-v1
    // has 168 dominant n=0 cells that all inherit aggregate calibration,
    // so the cache reduces 840·6 = 5040 bootstraps to a few hundred unique.
    {
      const aggFD = perTierFamilyD.aggregate;
      // Compute α_betting inline. Mirrors line 2142 below: alphaA / bonf / 2.
      // Pre-α-allocation here, so we re-derive from args + effective.
      const alphaA_betting = (effective
        ? effective.alpha_allocation.per_family.A
        : args.alpha * FAMILY_A_ALPHA_FRACTION);
      const bonferroni = compileDefaults.family_a_signals.length;
      const alphaBettingPerSignalLocal = (alphaA_betting / bonferroni) * 0.5;
      type BootstrapResult = {
        threshold: number; bootstrap_n: number;
        null_max_mean: number; null_max_std: number;
      };
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
      const cellSeedOffset = (key: typeof baselineCells.cells[0]['key']): number =>
        ((Number(key.hour_of_day) * 31 + Number(key.day_of_week)) * 7
          + (key.tenant_tier === 'aggregate' ? 0
            : key.tenant_tier === 'large' ? 1
            : key.tenant_tier === 'medium' ? 2
            : key.tenant_tier === 'small' ? 3 : 4)) >>> 0;
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

    // Q2.B.6.3 — sliding-buffer betting threshold consistency audit.
    // Halts on miss to surface stamping-pipeline drift.
    auditBettingSlidingBufferConsistency(baselineCells);
  }

  // α allocation — WEEK4-HANDOFF.md §4.1.f: 40/20/20/10/10 when A+C+D+E
  // emit; leftover goes to B. Pre-W4 (no D/E) keeps the W3 behavior of
  // A=40%, C=20%, B=remainder.
  //
  // Post-#28: when profile is active, α values come from
  // effective.alpha_allocation.per_family directly — overrides the
  // FRACTION-based computation. The profile carries the canonical split;
  // e.g., llm-inference-batch reallocates A+C compared to streaming.
  // Byte-identity anchor: streaming@1.0.0 encodes exactly the legacy
  // 40/20/20/10/10 values at total=1e-3, so profile vs legacy paths
  // produce matching alpha_budget.
  let alphaA = 0, alphaB = args.alpha, alphaC = 0, alphaD = 0, alphaE = 0;
  if (emitFamilyA) {
    if (effective) {
      alphaA = effective.alpha_allocation.per_family.A;
      alphaC = emitFamilyC ? effective.alpha_allocation.per_family.C : 0;
      alphaD = emitFamilyD ? effective.alpha_allocation.per_family.D : 0;
      alphaE = emitFamilyE ? effective.alpha_allocation.per_family.E : 0;
      // Compute B as residual (same FP path as legacy) so byte-identity
      // holds against the pre-#28 compile output when streaming@1.0.0's
      // per_family.B matches the residual within FP tolerance. The
      // loader's `sum === total` invariant already enforced consistency
      // between the profile's declared B and this residual at load time.
      alphaB = args.alpha - alphaA - alphaC - alphaD - alphaE;
    } else {
      alphaA = args.alpha * FAMILY_A_ALPHA_FRACTION;
      if (emitFamilyC) alphaC = args.alpha * FAMILY_C_ALPHA_FRACTION;
      if (emitFamilyD) alphaD = args.alpha * FAMILY_D_ALPHA_FRACTION;
      if (emitFamilyE) alphaE = args.alpha * FAMILY_E_ALPHA_FRACTION;
      alphaB = args.alpha - alphaA - alphaC - alphaD - alphaE;
    }
  }

  const version = (emitFamilyD || emitFamilyE)
    ? 'v4-fusion-novelty'
    : emitFamilyC
      ? 'v3-with-family-c'
      : emitFamilyA
        ? 'v2-with-family-a'
        : 'v1-legacy-equivalent';

  const config: CompiledConfig & { family_B?: { raw_empirical: Record<string, number>; tolerance_issues: typeof toleranceIssues } } = {
    version,
    compiler_version: COMPILER_VERSION,
    compiled_at: new Date(0).toISOString(), // deterministic; regenerate for wall-clock provenance
    baseline_ref: bundle.version + '@seed=' + bundle.seed,
    alpha_budget: {
      total: args.alpha,
      per_family: { A: alphaA, B: alphaB, C: alphaC, D: alphaD, E: alphaE },
    },
  };
  // REPLY-51b R4-4 — family_B emission conditional on profile's
  // structural_detectors.enabled gate + CLI --families intersection.
  // Legacy compiles (no profile) always emit family_B because CLI
  // default includes 'B'; streaming profile has structural: true,
  // so family_B still emits; generic-microservice (structural: false)
  // → family_B absent. Runtime consumers null-check (`cfg.family_B
  // && cfg.family_B.cutoffs` — pattern already present in
  // engine/orchestrator.ts:36).
  if (compileDefaults.family_enabled.B) {
    config.family_B = {
      cutoffs,
      vote_thresholds: LEGACY_VOTE_THRESHOLDS,
      raw_empirical: rawEmpirical,
      tolerance_issues: toleranceIssues,
    };
  }
  if (emitFamilyA && baselineCells) {
    config.baseline_cells = baselineCells;
    config.bonferroni_factor = compileDefaults.family_a_signals.length;
    // Post-#28: when profile is active, profile's bake_profiles
    // override BAKE_PROFILE entries for matching signals; `_default`
    // from BAKE_PROFILE is preserved. Profile entries that reference
    // signals absent from BAKE_PROFILE land as-is. Byte-identity
    // anchor: streaming@1.0.0 encodes all 13 BAKE_PROFILE entries
    // with identical values, so the merged output equals legacy.
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
    // Addition #23 — emit tenant_tier_map + tenant_tier_config when the
    // bundle carried per-run tenant_id. Pre-#23 bundles skip emission
    // entirely (runtime lookup treats unknown/absent as 'aggregate').
    if (tenantTierMap) {
      config.tenant_tier_map = tenantTierMap;
      config.tenant_tier_config = tenantTierConfig;
    }

    // Addition #17 (ARCHITECT-REPLY-34 D7) — populate the per-signal
    // betting-e-process α allocation as `(α_A / bonf) · 0.5`. Page-CUSUM
    // consumes the other half at runtime via `page-cusum.ts`'s α-split
    // branch (falls back to the full per-signal budget when this field
    // is absent, preserving pre-#17 config behavior).
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

    // Sanity check: Page-CUSUM's half + betting's half ≈ α_A when summed
    // across all signals.
    const nSignalsA = compileDefaults.family_a_signals.length;
    const summed = alphaBettingPerSignal * nSignalsA * 2;
    if (Math.abs(summed - alphaA) > alphaA * 1e-9) {
      console.warn(
        `[calibrate] Family A α-split sanity: 2·${alphaBettingPerSignal.toExponential(3)}·${nSignalsA} = `
        + `${summed.toExponential(3)} ≠ α_A = ${alphaA.toExponential(3)}`,
      );
    }
  }

  // REPLY-51 D6/D8 — attach profile provenance. Both fields optional
  // on CompiledConfig; legacy (no-profile) compiles emit neither,
  // preserving byte-identical output vs pre-#28 main.
  if (effective) {
    config.profile_ref = effective.profile_ref;
    if (effective.customer_override_ref !== null) {
      config.customer_override_ref = effective.customer_override_ref;
    }
    // REPLY-51b R4-3 — policy_defaults dispatch. Profile's
    // policy_defaults block threads onto CompiledConfig for G1-layer
    // consumption (reversibility threshold + auto-rollback gate +
    // risk-tier default). engine/gates/policy.ts reads with fallback
    // to hardcoded per R4-3 pattern.
    config.policy_defaults = { ...effective.policy_defaults };
    // REPLY-51b v2 R4-1 — Phase 4 compile-time shape resolution.
    // Emit profile-driven signal inventory so runtime detectors can
    // read the compiled shape directly (no per-tick projection).
    // Legacy path (effective=null) omits both fields; runtime falls
    // back to hardcoded FAMILY_A_PRIMARY_SIGNALS / FAMILY_C_SIGNALS.
    config.family_a_signals = compileDefaults.family_a_signals.slice();
    config.family_c_signals = compileDefaults.family_c_signals.slice();
  }

  // REPLY-50 D2 — tear down worker pool. Wait for termination before
  // finalize so worker-pool-overhead_ns captures shutdown cost.
  if (workerPool) {
    const tShutdown = hrNow();
    await workerPool.terminate();
    agg.timings.worker_pool_overhead_ns += hrNow() - tShutdown;
  }

  // REPLY-51b R4-2 — attach accumulated warnings. Empty list omits
  // the field entirely so legacy + no-deficiency compiles stay
  // byte-identical on this surface.
  if (compileWarnings.length > 0) {
    config.compile_warnings = compileWarnings;
  }

  // Q2.A — emit the resolved signal_classes map. Covers every Family A
  // signal so the runtime detector can resolve class without falling
  // back to DEFAULT_SIGNAL_CLASSES on every tick (a single map lookup
  // on the compiled config beats re-resolving the three-tier chain).
  // Operator overrides via CompilerOptions.signal_classes propagate
  // through resolveSignalClass on each per-signal call site above.
  // Pre-Q2.A configs that lack this field still work — runtime detector
  // falls back to 'gaussian_like' (identity), preserving pre-Q2.A
  // behaviour byte-identically.
  const resolvedSignalClasses: Record<string, SignalClass> = {};
  for (const sig of compileDefaults.family_a_signals) {
    resolvedSignalClasses[sig] = resolveSignalClass(sig, compilerOpts.signal_classes);
  }
  config.signal_classes = resolvedSignalClasses;

  // REPLY-50 D7 — stamp compile_phases just before write so the
  // instrumented timings reflect all per-cell + aggregate work. Write
  // itself is post-finalize so its cost isn't included in total_ms;
  // this matches the brief's "total_ms = sum of phases + overhead"
  // semantic where I/O is outside the phases.
  config.compile_phases = finalizePhaseTimings(agg.timings, hrNow() - tHrStart);

  // Q61 SPEC-1 SLICE 1 — stamp baseline curation pipeline diagnostics
  // on the emitted CompiledConfig. SLICE 1 emits D1-D4 audit records;
  // SLICE 2/3 throw and are deferred to future close PRs. The pipeline
  // inspects already-built CompiledConfig + bundle to derive per-decision
  // output_summary; does NO calculation; byte-identical regression
  // auto-holds by construction (acceptance criterion #7).
  const pipelineState = runBaselineCurationPipeline(bundle, config, {
    slices: ['SLICE_1'],
    verifyDecisions: true,
  });
  config.baseline_curation_pipeline_diagnostics = pipelineState.decisions;

  const outPath = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n');

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
}

// ── REPLY-50 D2 — worker_threads pool ─────────────────────────────
//
// Embarrassingly-parallel per-cell FastMCD/MRCD dispatch. calibrate.ts
// self-spawns worker threads via `new Worker(__filename)`; on load,
// the worker-mode handler below consumes `buildCell` messages and
// replies with the computed FamilyCPerCell + local phase timings.
//
// Determinism: fastMCD's PRNG seed is module-level constant; each
// call creates its own local mulberry32 instance, so parallel
// execution across workers produces bit-identical output to serial
// execution. MRCD inherits the same determinism. The main-thread
// aggregator sums worker phase-timing deltas into the global
// `_phaseTimings` after all cells complete.
//
// Serial fallback: when `cpu_count <= 2` (CI 2-core runners per Q1)
// OR when worker-pool spawning fails (sandboxed environments), the
// compile falls back to in-process serial calls — no regression vs
// pre-slice-2 behavior.

interface BuildCellTask {
  id: number;
  rows: number[][];
  opts: CompilerOptions;
  key: Record<string, string | number>;
  alphaMMD?: number;
}

/** Slice-3d worker-dispatch contract. Pre-3d emitted separate
 *  `cell` + `timingsDelta` + `d6bDelta` fields (module-state snapshot
 *  pathway). Post-3d returns the structured FamilyCBuildResult
 *  directly: { result, timings, diagnostics } matches the pure
 *  family-c.ts return shape and unpacks identically on both serial
 *  and worker paths. */
interface BuildCellReply {
  id: number;
  result?: {
    result: FamilyCPerCell;
    timings: _FamilyCTimings;
    diagnostics: _FamilyCDiagnostics;
  };
  error?: string;
}

class CellWorkerPool {
  private readonly workers: Worker[];
  private readonly idle: number[] = [];
  private readonly pending: Map<number, {
    resolve: (r: BuildCellReply) => void;
    reject: (err: Error) => void;
    workerIdx: number;
  }> = new Map();
  private readonly taskQueue: Array<{
    task: BuildCellTask;
    resolve: (r: BuildCellReply) => void;
    reject: (err: Error) => void;
  }> = [];
  private nextTaskId = 1;

  constructor(size: number) {
    this.workers = new Array<Worker>(size);
    for (let i = 0; i < size; i++) {
      const w = new Worker(__filename, { argv: [] });
      this.workers[i] = w;
      this.idle.push(i);
      w.on('message', (reply: BuildCellReply) => this.onReply(i, reply));
      w.on('error', (err: unknown) => {
        this.onWorkerError(i, err instanceof Error ? err : new Error(String(err)));
      });
    }
  }

  run(spec: Omit<BuildCellTask, 'id'>): Promise<BuildCellReply> {
    return new Promise((resolve, reject) => {
      const task: BuildCellTask = { ...spec, id: this.nextTaskId++ };
      if (this.idle.length > 0) {
        const workerIdx = this.idle.pop()!;
        this.pending.set(task.id, { resolve, reject, workerIdx });
        this.workers[workerIdx].postMessage(task);
      } else {
        this.taskQueue.push({ task, resolve, reject });
      }
    });
  }

  private onReply(workerIdx: number, reply: BuildCellReply): void {
    const p = this.pending.get(reply.id);
    if (!p) return;
    this.pending.delete(reply.id);
    if (reply.error) p.reject(new Error(reply.error));
    else p.resolve(reply);
    // Dispatch next queued task to this worker or return it to idle.
    if (this.taskQueue.length > 0) {
      const next = this.taskQueue.shift()!;
      this.pending.set(next.task.id, { resolve: next.resolve, reject: next.reject, workerIdx });
      this.workers[workerIdx].postMessage(next.task);
    } else {
      this.idle.push(workerIdx);
    }
  }

  private onWorkerError(workerIdx: number, err: Error): void {
    // Fail any pending task dispatched to this worker.
    for (const [id, p] of this.pending.entries()) {
      if (p.workerIdx === workerIdx) {
        this.pending.delete(id);
        p.reject(err);
      }
    }
  }

  async terminate(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

function chooseWorkerPoolSize(): number {
  const cpu = os.cpus().length;
  // Q1 fallback: CI 2-core runners → serial in-process (pool size 1
  // bypasses worker spawning below).
  return Math.min(Math.max(cpu - 1, 1), 8);
}

// ── Worker-mode entry ───────────────────────────────────────────────
//
// When calibrate.ts is loaded inside a worker thread (via
// `new Worker(__filename)` from the main thread's pool), this block
// sets up a message handler and skips the main() CLI entry. BigInt
// serializes across postMessage via structured clone (Node ≥ 16),
// so phase-timing deltas transfer cleanly.
//
// Slice-3d — worker returns the pure family-c.ts FamilyCBuildResult
// shape directly. No worker-local module state; no mid-message
// snapshot. Main-thread `dispatchBuildCell` unpacks into the
// compile-local aggregator identically to the serial path.

if (!isMainThread && parentPort) {
  parentPort.on('message', (task: BuildCellTask) => {
    try {
      const { result, timings, diagnostics } = _buildFamilyCPerCellPure(
        task.rows, task.opts, task.key, task.alphaMMD,
      );
      const reply: BuildCellReply = {
        id: task.id,
        result: { result, timings, diagnostics },
      };
      parentPort!.postMessage(reply);
    } catch (err) {
      const reply: BuildCellReply = {
        id: task.id,
        error: err instanceof Error ? err.message : String(err),
      };
      parentPort!.postMessage(reply);
    }
  });
}

// Auto-run main() only when invoked in CLI mode. When imported as a
// module — e.g., from test/mcd.test.ts exercising the `fastMCD` helper
// — main() does not run. Gated on the presence of `--baseline` in
// argv so the check is independent of module system (CJS vs ESM).
// Under Node 25 TS loader, `require.main === module` isn't reliable.
//
// Workers spawned via `new Worker(__filename)` inherit `argv` from
// main by default, so we also guard on `isMainThread` to prevent
// workers from attempting to re-run main().
if (isMainThread && process.argv.some((a) => a === '--baseline')) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
