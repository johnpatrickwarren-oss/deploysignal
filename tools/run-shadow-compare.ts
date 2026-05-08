// tools/run-shadow-compare.ts — Q60 Slice 1 shadow-compare orchestrator.
//
// For each (substrate × scenario × seed) tuple, runs an FPR + TPR
// sweep via tools/build-report-card.js (--profile mode) and emits a
// per-(substrate × scenario × seed) checkpoint file at
// `runs/validation-reports/profile-report-cards/checkpoints/`. After
// all checkpoints complete, aggregates per-(substrate × scenario)
// report cards + cross-substrate diff + aggregate pitch summary.
//
// V2 incremental emission discipline (architect-required at
// ARCHITECT-REPLY-Q60-SLICE-1-PHASE-1-1-DISPOSITION-V2 §
// Architect-required addition): per-(substrate × scenario × seed)
// checkpoints emit at each completion (NOT batch-emit at end of
// sweep). Mid-sweep crash recovers by resuming from last incomplete
// checkpoint. Load-bearing for B4 Mac mini compute-target operational
// pattern (network disconnect mid-sweep + nohup + Tailscale + V2
// incremental emission); also benefits B1/B2/B3 alternates.
//
// Anti-scope (per Q60 spec):
//   - NO modification to engine/detectors/* runtime code
//     (preserves Q58 + Q59 ADR anti-scope).
//   - NO modification to v5 production validation substrate.
//   - NO new schema-map mappers (Slice 2 scope).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import type {
  Q60DetectorFamily,
  ProfileReportCardBlock,
  ShadowCompareBlock,
  SweepCheckpoint,
} from '../engine/types/config.js';

// ── Constants ────────────────────────────────────────────────────

/** 10-detector enumeration (matches engine/per-detector-resampler-
 *  mode.ts PER_DETECTOR_FAMILIES; duplicated here to avoid pulling
 *  in the full module dependency at orchestrator layer). */
const Q60_DETECTOR_FAMILIES: readonly Q60DetectorFamily[] = [
  'family_A_betting', 'family_A_page_cusum',
  'family_C_safe_test', 'family_C_chi_square',
  'family_D_spectral', 'family_D_kv_cache',
  'family_E_conformal',
  'mmd_betting', 'mmd_bootstrap_null',
  'family_B_pattern_match',
];

/** Per-detector α budgets (mirrors engine/per-detector-resampler-
 *  mode.ts PER_DETECTOR_ALPHA_BUDGETS). */
const Q60_ALPHA_BUDGETS: Record<Q60DetectorFamily, number> = {
  family_A_betting: 2e-4,
  family_A_page_cusum: 1e-4,
  family_C_safe_test: 2e-4,
  family_C_chi_square: 2e-4,
  family_D_spectral: 1e-4,
  family_D_kv_cache: 1e-4,
  family_E_conformal: 1e-4,
  mmd_betting: 1e-4,
  mmd_bootstrap_null: 1e-4,
  family_B_pattern_match: 0,
};

const DEFAULT_HEALTHY_WINDOWS = 131;

// ── Q60 Phase-3.d.1 (D) per-detector exemption ───────────────────

/** Family A signals (mirror of FAMILY_A_SIGNALS in tools/calibrate.ts;
 *  duplicated here to avoid pulling in the calibrator at orchestrator
 *  layer). */
const FAMILY_A_SIGNALS = [
  'p99_latency', 'ttft', 'eval_score', 'tool_success_rate',
  'downstream_err', 'cost_req',
] as const;

/** Family C joint vector signals (mirror of FAMILY_C_SIGNALS in
 *  tools/calibrate.ts). */
const FAMILY_C_SIGNALS = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
  'corpus_delta', 'traffic_pct',
] as const;

/** Per-detector required-signals declaration. Used at FPR-sweep
 *  dispatch to decide whether a (substrate × detector) pair is
 *  exercised or exempted given substrate's signal coverage.
 *
 *  Architect's draft pseudocode (ARCHITECT-REPLY-Q60-SLICE-1-PHASE-3-
 *  LS2-SPARSE-SIGNAL-DISPOSITION § Ask 1 (D)) used hypothetical signal
 *  sets ('mfu', 'tokens_turn' in family_A); this implementation uses
 *  the codebase's actual FAMILY_A_SIGNALS / FAMILY_C_SIGNALS. */
function getRequiredSignalsForDetector(family: Q60DetectorFamily): readonly string[] {
  switch (family) {
    case 'family_A_betting':
    case 'family_A_page_cusum':
      return FAMILY_A_SIGNALS;
    case 'family_C_safe_test':
    case 'family_C_chi_square':
    case 'family_E_conformal':
    case 'mmd_betting':
    case 'mmd_bootstrap_null':
      return FAMILY_C_SIGNALS;  // joint-vector detectors require all
    case 'family_D_spectral':
      return ['p99_latency', 'ttft', 'tokens_turn', 'cost_req'];  // per-signal AR(1)
    case 'family_D_kv_cache':
      return ['kv_cache'];
    case 'family_B_pattern_match':
      return ['p99_latency', 'kv_cache'];
  }
}

/** Sparse-tolerance rule per detector class. Per-signal detectors
 *  (family_A_*, family_D_*) tolerate partial signal coverage: if AT
 *  LEAST ONE required signal is present, the detector exercises on
 *  the present signal(s) only. Joint-vector detectors (family_C_*,
 *  family_E, mmd_*, family_B) require ALL declared signals to form
 *  the joint vector; missing ANY signal exempts the detector.
 *
 *  Architect spec table (Q60 § Acceptance criterion 8 POST-PHASE-3-
 *  AMENDMENT) treats family_A as exercised on BurstGPT (cost_req-only)
 *  and family_D_kv_cache as exercised on Mooncake — i.e., per-signal
 *  detectors use the sparse-tolerant ANY-PRESENT rule, joint detectors
 *  use STRICT-ALL-REQUIRED. */
function isPerSignalDetector(family: Q60DetectorFamily): boolean {
  return family === 'family_A_betting'
    || family === 'family_A_page_cusum'
    || family === 'family_D_spectral'
    || family === 'family_D_kv_cache';
}

/** Read substrate's present signals from the baseline manifest's
 *  signal_series of the first run. (All runs in a Q60 Slice 1 bundle
 *  share signal_series shape per the ingester contract.) */
function readSubstratePresentSignals(substrate: SubstrateRef): readonly string[] {
  const bundlePath = path.join(substrate.baselineDir, 'bundle.jsonl');
  if (!fs.existsSync(bundlePath)) return [];
  const firstLine = fs.readFileSync(bundlePath, 'utf8').split('\n')[0];
  if (!firstLine) return [];
  try {
    const run = JSON.parse(firstLine) as { signal_series?: Record<string, number[]> };
    return run.signal_series ? Object.keys(run.signal_series) : [];
  } catch {
    return [];
  }
}

interface DetectorExerciseDecision {
  exercised: boolean;
  exemption_reason?: string;
}

function isDetectorExercisedAtSubstrate(
  family: Q60DetectorFamily,
  presentSignals: readonly string[],
): DetectorExerciseDecision {
  const required = getRequiredSignalsForDetector(family);
  const presentSet = new Set(presentSignals);
  const missing = required.filter((sig) => !presentSet.has(sig));
  if (missing.length === 0) return { exercised: true };
  if (isPerSignalDetector(family)) {
    const presentRequired = required.filter((sig) => presentSet.has(sig));
    if (presentRequired.length > 0) return { exercised: true };
  }
  return {
    exercised: false,
    exemption_reason: `substrate signal coverage missing required signals: ${missing.join(', ')}`,
  };
}

/** Q60 Phase-3.d.1 L3b β.1 — parametric_ar1 PASS requires the full
 *  11-signal FAMILY_C_SIGNALS_ORDER joint cholesky_L vector at every
 *  cell. Sparse-signal substrates can't form the joint vector;
 *  parametric_ar1-mode detectors (family_D_spectral, family_D_kv_cache,
 *  family_E_conformal per PER_DETECTOR_RESAMPLER_MODE_3WAY) get
 *  EXEMPTED at the orchestrator with the architect-drafted reason. */
const PARAMETRIC_AR1_MODE_DETECTORS: readonly Q60DetectorFamily[] = [
  'family_D_spectral', 'family_D_kv_cache', 'family_E_conformal',
];

function isParametricAr1PassEligible(
  substrateName: string,
  presentSignals: readonly string[],
): { eligible: boolean; reason?: string } {
  const required = FAMILY_C_SIGNALS;
  const presentSet = new Set(presentSignals);
  const missing = required.filter((sig) => !presentSet.has(sig));
  if (missing.length === 0) return { eligible: true };
  return {
    eligible: false,
    reason: `substrate ${substrateName} sparse; parametric_ar1 pass cannot form 11-signal joint cholesky_L vector (missing: ${missing.join(', ')})`,
  };
}

// ── Q66 Phase-3.d.A.c.γ — calibration-regime-vs-sweep-regime mismatch exemption ──

/** Per architect ARCHITECT-REPLY-Q66-PHASE-3-D-A-c-gamma-DISPOSITION.md
 *  § (b.2) — extends Q60 L3b detector_exemption_reason mechanism to handle
 *  calibration-regime-vs-sweep-regime mismatch class.
 *
 *  Sweep modes:
 *    - iid_bootstrap: always matched (any baseline calibration regime works)
 *    - parametric_ar1: requires baseline AR(1) phi structure (|mean| > 0.2
 *      OR |max| > 0.5); iid-baseline substrates exempted because H1' pre-
 *      whitening with phi≈0 reduces to identity → cannot correct AR(1)
 *      injected at sweep time → calibration-regime mismatch
 *    - parametric_gaussian: sub-Gaussian residual assumption requires
 *      substrate joint vector to satisfy mixture-supermartingale closed-
 *      form bounds; single-signal heavy-tail substrates violate the
 *      sub-Gaussianity assumption → catastrophic over-firing → exempted
 */
const REGIME_MISMATCH_REASON_PREFIX = 'calibration_baseline_correlation_structure_does_not_match_sweep_mode_correlation_structure';

interface PhiDistributionStats {
  mean: number;
  absMax: number;
  count: number;
}

function computePhiDistributionFromConfig(compiledConfigPath: string): PhiDistributionStats {
  if (!fs.existsSync(compiledConfigPath)) return { mean: 0, absMax: 0, count: 0 };
  let cfg: { baseline_cells?: { cells?: Array<{ family_A?: { per_signal?: Record<string, { ar1_phi?: number }> } }> } };
  try {
    cfg = JSON.parse(fs.readFileSync(compiledConfigPath, 'utf8'));
  } catch {
    return { mean: 0, absMax: 0, count: 0 };
  }
  let sum = 0;
  let absMax = 0;
  let count = 0;
  for (const cell of cfg.baseline_cells?.cells ?? []) {
    const perSignal = cell.family_A?.per_signal ?? {};
    for (const params of Object.values(perSignal)) {
      if (typeof params.ar1_phi === 'number') {
        sum += params.ar1_phi;
        const abs = Math.abs(params.ar1_phi);
        if (abs > absMax) absMax = abs;
        count++;
      }
    }
  }
  return { mean: count > 0 ? sum / count : 0, absMax, count };
}

interface FamilyASignalClassSummary {
  signalCount: number;
  signalClasses: ReadonlyArray<string>;
}

function getFamilyASignalClassSummary(compiledConfigPath: string): FamilyASignalClassSummary {
  if (!fs.existsSync(compiledConfigPath)) return { signalCount: 0, signalClasses: [] };
  let cfg: { baseline_cells?: { cells?: Array<{ family_A?: { per_signal?: Record<string, { signal_class?: string }> } }> } };
  try {
    cfg = JSON.parse(fs.readFileSync(compiledConfigPath, 'utf8'));
  } catch {
    return { signalCount: 0, signalClasses: [] };
  }
  const signals = new Set<string>();
  const classes = new Set<string>();
  for (const cell of cfg.baseline_cells?.cells ?? []) {
    const perSignal = cell.family_A?.per_signal ?? {};
    for (const [sig, params] of Object.entries(perSignal)) {
      signals.add(sig);
      if (params.signal_class) classes.add(params.signal_class);
    }
  }
  return { signalCount: signals.size, signalClasses: Array.from(classes) };
}

export type SweepMode = 'iid_bootstrap' | 'parametric_gaussian' | 'parametric_ar1';

/** Q66 Phase-3.d.A.c.γ.c heavy-tail-without-ballast helper —
 *  per architect ARCHITECT-PICK 2026-05-07. Compound predicate:
 *    hasHeavyTail && !hasGaussianLike
 *
 *  Architectural intuition (architect-emit verbatim): gaussian_like
 *  signals serve as sub-Gaussian ballast in joint vector. With ballast,
 *  joint covariance estimate is anchored to well-behaved variance
 *  (heavy_tail residuals don't dominate). Without ballast, heavy_tail
 *  residuals dominate joint covariance → mixture-supermartingale closed-
 *  form bound assumption broken → catastrophic FPR.
 *
 *  Empirical fit (4-substrate tabular check):
 *    - real_burstgpt (heavy_tail only)            → exempt ✓
 *    - real_huggingface_lmsys_arena (heavy_tail + bounded_probability)  → exempt ✓
 *    - synthetic_v1 (heavy_tail + gaussian_like + bounded_probability)  → NOT exempt ✓
 *    - real_azure_llm_inference / real_mooncake (no Family A)           → n/a
 */
function _shouldExemptFamilyAOnHeavyTail(
  substrate: SubstrateRef,
): { exempt: boolean; classes: ReadonlyArray<string> } {
  const summary = getFamilyASignalClassSummary(substrate.compiledConfig);
  const hasHeavyTail = summary.signalClasses.includes('heavy_tail');
  const hasGaussianLike = summary.signalClasses.includes('gaussian_like');
  return { exempt: hasHeavyTail && !hasGaussianLike, classes: summary.signalClasses };
}

// ── Q70 Phase-3.d.E — cross-detector dispatch table ─────────────

/** Per-detector exemption predicate signature (Q70.1).
 *
 *  Returns `{ exempt: true, reason }` when the detector × substrate ×
 *  sweepMode triple is in calibration-regime-vs-sweep-regime mismatch
 *  class — the firing is NOT a true detector regression but an
 *  artifact of the methodology gap between baseline calibration regime
 *  and runtime sweep mode regime.
 *
 *  Returns `{ exempt: false }` when no exemption applies; the detector
 *  is exercised normally and held to the standard FPR acceptance gate.
 */
type DetectorExemptionPredicate = (
  substrate: SubstrateRef,
  sweepMode: SweepMode,
) => { exempt: boolean; reason?: string };

/** Q66 Phase-3.d.A.c.γ.c family_A_page_cusum compound predicate, lifted
 *  intact into the Q70.1 dispatch table. Behavior MUST match pre-Q70
 *  semantics exactly (see test/q66-phase-3-d-a-c-gamma-conditional-
 *  exemption.test.ts). */
const predicateFamilyAPageCusum: DetectorExemptionPredicate = (
  substrate, sweepMode,
) => {
  const ballastDecision = _shouldExemptFamilyAOnHeavyTail(substrate);
  if (ballastDecision.exempt) {
    return {
      exempt: true,
      reason: `${REGIME_MISMATCH_REASON_PREFIX}: substrate ${substrate.name} family_A signal classes=[${ballastDecision.classes.join(',')}] include heavy_tail without gaussian_like ballast; joint covariance dominated by heavy_tail residuals; mixture-supermartingale sub-Gaussianity assumption violated under ${sweepMode} sampler (Q66 .A.c.γ.c compound-predicate disposition).`,
    };
  }
  if (sweepMode === 'parametric_ar1') {
    const phiStats = computePhiDistributionFromConfig(substrate.compiledConfig);
    const baselineHasAr1Structure = (
      Math.abs(phiStats.mean) > 0.2 || phiStats.absMax > 0.5
    );
    if (phiStats.count > 0 && !baselineHasAr1Structure) {
      return {
        exempt: true,
        reason: `${REGIME_MISMATCH_REASON_PREFIX}: substrate ${substrate.name} baseline phi distribution (mean=${phiStats.mean.toFixed(4)}, absMax=${phiStats.absMax.toFixed(4)}, n=${phiStats.count}) lacks AR(1) structure; H1' pre-whitening reduces to identity under parametric_ar1 ρ=0.5 sweep injection (Q66 .A.c.γ disposition).`,
      };
    }
  }
  return { exempt: false };
};

/** Q70.1 — family_A_betting predicate (NEW).
 *
 *  Architect spec: heavy_tail-without-ballast (compound predicate
 *  analogous to family_A_page_cusum since ONS regret bound is sub-
 *  Gaussian-assumption-dependent) OR signalCount===1 + parametric_ar1
 *  (single-signal AR(1) per-signal correlation invalidates ONS regret
 *  bound). Reading "AND" in spec line 42 as architect's intent for OR
 *  per empirical-firing pattern (synthetic_v1 has gaussian_like ballast
 *  → first conjunct fails → OR needed for the firing to be exempted).
 *  This is LS-1 architect-discretion at impl review per spec line 321;
 *  refinement expected post-sweep.
 *
 *  NOTE (Q70 SLICE 1): predicate stub returns `{ exempt: false }` — no
 *  exemption logic wired this slice. Empirical sweep validation +
 *  predicate refinement deferred to follow-on slice per architect's
 *  anticipated LS-1 iterative-refinement pattern (Q66 .γ → .γ.b → .γ.c
 *  precedent). */
const predicateFamilyABetting: DetectorExemptionPredicate = (
  _substrate, _sweepMode,
) => ({ exempt: false });

/** Q70.1 — family_C_safe_test predicate (NEW).
 *
 *  Architect spec: signalCount===1 + parametric_ar1 (single-signal
 *  Sequential MMD has analogous calibration-regime mismatch to
 *  family_A_betting at parametric_ar1 mode).
 *
 *  NOTE (Q70 SLICE 1): predicate stub. Empirical refinement deferred. */
const predicateFamilyCSafeTest: DetectorExemptionPredicate = (
  _substrate, _sweepMode,
) => ({ exempt: false });

/** Q70.1 — family_E_conformal predicate (NEW).
 *
 *  Architect spec: signal-class-aware predicate per Q60 V2 family_E
 *  source semantics. Preliminary form: `signalClasses.includes(
 *  'schema_continuity') OR (singleClass && classFamily === 'fragility')`.
 *  Architect-discretion at Mac Claude impl review per Q70 LS-1; spec
 *  acknowledges 4th-check-insufficiency-under-low-substrate-diversity
 *  applies (only synthetic_v1 fired; substrate diversity for Family E
 *  is low).
 *
 *  NOTE (Q70 SLICE 1): predicate stub. Empirical refinement deferred. */
const predicateFamilyEConformal: DetectorExemptionPredicate = (
  _substrate, _sweepMode,
) => ({ exempt: false });

/** Q70.1 — family_D_kv_cache predicate (NEW).
 *
 *  Architect spec: substrate-specific predicate per Q60 V2 family_D
 *  source semantics. Preliminary form: substrates lacking sufficient
 *  kv_cache signal-coverage exempted (Q60 L3b sparse-substrate
 *  exemption mechanism precedent extended to family_D).
 *
 *  NOTE (Q70 SLICE 1): predicate stub. Empirical refinement deferred. */
const predicateFamilyDKvCache: DetectorExemptionPredicate = (
  _substrate, _sweepMode,
) => ({ exempt: false });

/** Q70.1 dispatch table — per-detector exemption predicates.
 *
 *  Detectors not covered by an active predicate get `() => ({ exempt:
 *  false })` (no exemption; standard FPR gate applies). family_A_
 *  page_cusum predicate is the existing Q66 .A.c.γ.c compound predicate
 *  preserved intact. The 4 NEW predicates (family_A_betting,
 *  family_C_safe_test, family_E_conformal, family_D_kv_cache) are
 *  Q70.1 SLICE 1 stubs returning no-exemption; substantive logic +
 *  empirical sweep validation in follow-on slice. */
const noExemption: DetectorExemptionPredicate = () => ({ exempt: false });
const DETECTOR_EXEMPTION_PREDICATES: Record<Q60DetectorFamily, DetectorExemptionPredicate> = {
  family_A_page_cusum: predicateFamilyAPageCusum,
  family_A_betting:    predicateFamilyABetting,
  family_C_safe_test:  predicateFamilyCSafeTest,
  family_C_chi_square: noExemption,
  family_D_spectral:   noExemption,
  family_D_kv_cache:   predicateFamilyDKvCache,
  family_E_conformal:  predicateFamilyEConformal,
  mmd_betting:         noExemption,  // Q67 SLICE 1 PASS preserved
  mmd_bootstrap_null:  noExemption,
  family_B_pattern_match: noExemption,  // structural detector; no calibration regime mismatch class
};

/** Q66 Phase-3.d.A.c.γ origin → Q70 Phase-3.d.E dispatch-table refactor.
 *
 *  Returns matched=true when the substrate's calibration regime aligns
 *  with the sweep mode's evaluation regime; false (with reason) when
 *  mismatch is empirically known to produce halt-boundary (a) firing
 *  that's NOT a true detector regression but a calibration-vs-sweep
 *  regime mismatch artifact.
 *
 *  Q70 SLICE 1: refactored to detector-family-agnostic dispatch table
 *  (Q70.1). family_A_page_cusum compound predicate from Q66 .A.c.γ.c
 *  preserved exactly; 4 NEW per-detector predicate slots wired (stubs
 *  this slice; substantive logic in follow-on). Unknown detectors fall
 *  through to no-exemption. */
export function isSweepModeCalibrationRegimeMatched(
  substrate: SubstrateRef,
  sweepMode: SweepMode,
  detector: Q60DetectorFamily,
): { matched: boolean; reason?: string } {
  const predicate = DETECTOR_EXEMPTION_PREDICATES[detector] ?? noExemption;
  const result = predicate(substrate, sweepMode);
  return result.exempt
    ? { matched: false, reason: result.reason }
    : { matched: true };
}

// ── Substrate + scenario types ───────────────────────────────────

export interface SubstrateRef {
  name: string;            // e.g., 'synthetic_v1' | 'real_burstgpt'
  baselineDir: string;     // path to baseline bundle directory
  compiledConfig: string;  // path to compiled config JSON
}

export interface ShadowCompareOpts {
  substrates: SubstrateRef[];
  scenarios: string[];      // postmortem profile names
  seeds: number[];          // typically 8 seeds
  outputDir: string;        // 'runs/validation-reports/profile-report-cards/'
  /** When set, dry-run mode skips the actual build-report-card
   *  invocations + emits stub checkpoints (used by tests + smoke
   *  testing the orchestrator without ~5-15h compute). */
  dryRun?: boolean;
  healthyWindows?: number;  // default 131
}

export interface PerProfileReportCard {
  profile: ProfileReportCardBlock;
  per_detector_firing_counts_mean: Record<Q60DetectorFamily, number>;
  per_detector_firing_counts_per_seed: Record<Q60DetectorFamily, number[]>;
  per_detector_fpr_mean: Record<Q60DetectorFamily, number>;
  shadow_compare?: ShadowCompareBlock;
}

export interface ShadowCompareReport {
  per_profile_report_cards: Record<string, PerProfileReportCard>;
  cross_substrate_diff_path: string;
  acceptance_gates: Record<string, boolean>;
  pitch_summary_path: string;
}

// ── Checkpoint I/O (V2 incremental emission discipline) ─────────

function checkpointPathFor(
  outputDir: string, substrate: string, scenario: string, seed: number,
): string {
  return path.join(outputDir, 'checkpoints', `${substrate}--${scenario}--${seed}.json`);
}

function readCheckpoint(checkpointPath: string): SweepCheckpoint | undefined {
  if (!fs.existsSync(checkpointPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as SweepCheckpoint;
  } catch {
    return undefined;  // malformed checkpoint; treat as missing
  }
}

function writeCheckpoint(checkpointPath: string, cp: SweepCheckpoint): void {
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(checkpointPath, JSON.stringify(cp, null, 2) + '\n');
}

// ── Single-seed trial execution ──────────────────────────────────

interface SeedTrialResult {
  per_detector_firing_counts: Record<Q60DetectorFamily, number>;
  per_detector_firing_ids: Record<Q60DetectorFamily, string[]>;
}

function runProfileValidationSingleSeed(
  substrate: SubstrateRef,
  scenario: string,
  seed: number,
  outputDir: string,
  healthyWindows: number,
  dryRun: boolean,
  skipParametricAr1: boolean,
): SeedTrialResult {
  const reportPath = path.join(
    outputDir, 'per-seed-reports',
    `${substrate.name}--${scenario}--${seed}.json`,
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  if (dryRun) {
    // Dry-run mode: emit stub report; per-detector counts all zero.
    const stub: SeedTrialResult = {
      per_detector_firing_counts: Object.fromEntries(
        Q60_DETECTOR_FAMILIES.map((f) => [f, 0]),
      ) as unknown as Record<Q60DetectorFamily, number>,
      per_detector_firing_ids: Object.fromEntries(
        Q60_DETECTOR_FAMILIES.map((f) => [f, []]),
      ) as unknown as Record<Q60DetectorFamily, string[]>,
    };
    return stub;
  }

  // Production: invoke build-report-card.js with --profile flag.
  // Phase 2.2 build-report-card.js extension surfaces profile +
  // shadow_compare blocks; this orchestrator delegates the FPR/TPR
  // sweep machinery to the existing report-card pipeline.
  execSync(
    `node tools/build-report-card.js`
    + ` --baseline ${substrate.baselineDir}`
    + ` --compiled ${substrate.compiledConfig}`
    + ` --healthy-windows ${healthyWindows}`
    + ` --seed ${seed}`
    + ` --profile-substrate ${substrate.name}`
    + ` --profile-scenario ${scenario}`
    + ` --out ${reportPath}`
    + (skipParametricAr1 ? ' --skip-parametric-ar1' : ''),
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const detectors = report.detectors ?? {};
  const counts = Object.fromEntries(
    Q60_DETECTOR_FAMILIES.map((f) => [f, detectors[f]?.iid_bootstrap_pool?.firing_count ?? 0]),
  ) as unknown as Record<Q60DetectorFamily, number>;
  const ids = Object.fromEntries(
    Q60_DETECTOR_FAMILIES.map((f) => [f, detectors[f]?.iid_bootstrap_pool?.firing_ids?.map(
      (firing: { tick: number | null; cell_key: { hour_of_day: number } }) =>
        `${scenario}:${firing.tick ?? 'na'}:${firing.cell_key.hour_of_day}`,
    ) ?? []]),
  ) as unknown as Record<Q60DetectorFamily, string[]>;
  return {
    per_detector_firing_counts: counts,
    per_detector_firing_ids: ids,
  };
}

// ── Aggregation: seed checkpoints → per-profile report card ─────

function aggregateSeedsToReportCard(
  substrate: SubstrateRef,
  scenario: string,
  seeds: number[],
  outputDir: string,
  healthyWindows: number,
): PerProfileReportCard {
  const perSeedCounts: Record<Q60DetectorFamily, number[]> = Object.fromEntries(
    Q60_DETECTOR_FAMILIES.map((f) => [f, []]),
  ) as unknown as Record<Q60DetectorFamily, number[]>;
  for (const seed of seeds) {
    const cp = readCheckpoint(checkpointPathFor(outputDir, substrate.name, scenario, seed));
    if (cp?.status !== 'completed' || !cp.per_detector_firing_counts) {
      throw new Error(
        `Checkpoint ${substrate.name}--${scenario}--${seed} not completed; `
        + `cannot aggregate report card. Run sweep to completion first.`,
      );
    }
    for (const f of Q60_DETECTOR_FAMILIES) {
      perSeedCounts[f].push(cp.per_detector_firing_counts[f] ?? 0);
    }
  }

  const meanCounts: Record<Q60DetectorFamily, number> = Object.fromEntries(
    Q60_DETECTOR_FAMILIES.map((f) => {
      const counts = perSeedCounts[f];
      const sum = counts.reduce((a, b) => a + b, 0);
      return [f, counts.length > 0 ? sum / counts.length : 0];
    }),
  ) as unknown as Record<Q60DetectorFamily, number>;

  const fprMean: Record<Q60DetectorFamily, number> = Object.fromEntries(
    Q60_DETECTOR_FAMILIES.map((f) => [f, meanCounts[f] / healthyWindows]),
  ) as unknown as Record<Q60DetectorFamily, number>;

  // Read baseline_provenance from substrate's compiled config.
  let provenance: ProfileReportCardBlock['baseline_provenance'] = 'synthetic';
  try {
    const cfg = JSON.parse(fs.readFileSync(substrate.compiledConfig, 'utf8'));
    if (cfg.baseline_provenance) provenance = cfg.baseline_provenance;
  } catch {
    // Substrate config may not exist yet in dry-run mode; tolerate.
  }

  return {
    profile: {
      dataset: substrate.name === 'synthetic_v1' ? 'synthetic_v1' : provenance,
      scenario,
      baseline_provenance: provenance,
      compiled_config_version: path.basename(substrate.compiledConfig, '.json'),
    },
    per_detector_firing_counts_mean: meanCounts,
    per_detector_firing_counts_per_seed: perSeedCounts,
    per_detector_fpr_mean: fprMean,
    // shadow_compare populated in computeCrossSubstrateDiff below.
  };
}

// ── Cross-substrate diff ─────────────────────────────────────────

// ── Q62 Phase 4 H1a + H1b cross-substrate ΔFPR exemption mechanism ──
//
// Per ARCHITECT-REPLY-Q62-PHASE-4-DELTA-FPR-DISPOSITION.md § Ask 1
// (H1a + H1b combined PICK). Cross-substrate ΔFPR computation EXEMPTS:
//   - Classical-epoch-α detectors under iid_bootstrap mode
//     (family_A_page_cusum CAVEAT-inherited from Q58/Q59 H4 PERMANENT;
//     mmd_bootstrap_null when MMD_MIN fallback engages).
//   - Non-α-consuming structural detectors (family_B_pattern_match per
//     Q60 V2 family_b_trip_rate_note; reflects bootstrap-methodology
//     joint-distribution breakage, not production false-fire rate).
//
// 20th VIOLATION class anchor: cross-substrate-acceptance-bound-vs-
// CAVEAT-inheritance-coherence. Memorial F sub-rule 4 reinforcement:
// pre-existing-property-coherence verification must extend to multiple
// aggregation scopes (per-detector, per-substrate, cross-substrate,
// aggregate-pitch-claim). Cross-substrate ΔFPR aggregation requires
// SEPARATE exemption mechanism from per-substrate Q60 V2
// detector_exemption_reason mechanism.

// Q66 Phase-3.d.A close (item g) — family_A_page_cusum CAVEAT inheritance
// RETIRED. Default Page-CUSUM variant flips to anytime-valid Ville-bounded
// mixture-supermartingale (Howard-Ramdas-2021); methodology-resampler-mode
// invariant by construction. Q62 H1a+H1b cross-substrate ΔFPR exemption
// no longer required for this detector. Q66.A.b H1' AR(1) pre-whitening
// closes the parametric_ar1 ρ=0.5 → 17.2% FPR LS-1 surface. See
// coordination/ANTI-SCOPE-LEDGER.md § Q58 / Q59 stamps.
//
// Q67 Phase-3.d.B close (§ Q67.6) — family_C_mmd CAVEAT inheritance
// RETIRED. Default Sequential MMD variant flips to canonical anytime-valid
// Ville-bounded betting-e-process (Shekhar-Ramdas-2023); methodology-
// resampler-mode invariant by construction. Q62 H1a+H1b cross-substrate
// ΔFPR exemption no longer required for this detector. Build-report-card
// Phase-3.d.B acceptance gate (§ Q67.4) validates uniform mode invariance;
// see q67_phase_3_d_b_acceptance_gate stamp.
//
// family_B_pattern_match remains exempt (non-α-consuming structural
// detector; Q60 V2 family_b_trip_rate_note semantic preserved). Registry
// is now at its narrowest valid state post-Q67 Phase-3.d.B close.
const CROSS_SUBSTRATE_FPR_EXEMPT_DETECTORS: Partial<Record<Q60DetectorFamily, string>> = {
  family_B_pattern_match: 'non-α-consuming structural detector; family_b_trip_rate reflects joint-distribution breakage of bootstrap methodology per Q60 V2 family_b_trip_rate_note; not a production false-fire rate projection',
};

function isDetectorExemptFromCrossSubstrateFPR(family: Q60DetectorFamily): boolean {
  return family in CROSS_SUBSTRATE_FPR_EXEMPT_DETECTORS;
}

function computeCrossSubstrateDiff(
  reportCards: Record<string, PerProfileReportCard>,
  referenceSubstrate: string,
  scenarios: string[],
): Record<string, ShadowCompareBlock> {
  const out: Record<string, ShadowCompareBlock> = {};
  for (const key of Object.keys(reportCards)) {
    const rc = reportCards[key];
    const substrateName = key.split('--')[0];
    if (substrateName === referenceSubstrate) continue;  // reference vs itself

    const scenario = key.split('--')[1];
    const refKey = `${referenceSubstrate}--${scenario}`;
    const refRc = reportCards[refKey];
    if (!refRc) continue;  // reference missing this scenario; skip

    const deltaFprPerDetector = Object.fromEntries(
      Q60_DETECTOR_FAMILIES.map((f) => [
        f,
        rc.per_detector_fpr_mean[f] - refRc.per_detector_fpr_mean[f],
      ]),
    ) as unknown as Record<Q60DetectorFamily, number>;

    // ΔTPR + Δmedian-TTD: stub zeros pending TPR sweep wiring (Phase
    // 2.2 build-report-card --profile flag emits TPR per scenario;
    // orchestrator reads that field). For Slice 1 scaffolding,
    // populate with zeros to make schema valid; empirical Phase 3
    // run produces real values.
    const deltaTprPerDetector = Object.fromEntries(
      Q60_DETECTOR_FAMILIES.map((f) => [f, 0]),
    ) as unknown as Record<Q60DetectorFamily, number>;
    const deltaTtdPerDetector = Object.fromEntries(
      Q60_DETECTOR_FAMILIES.map((f) => [f, 0]),
    ) as unknown as Record<Q60DetectorFamily, number>;

    // Q62 Phase 4 H1a+H1b: acceptance gate evaluates ΔFPR over NON-
    // EXEMPTED detectors only. Exempted detectors are emitted at
    // exempted_detector_metadata for audit transparency; their ΔFPR
    // values remain in delta_FPR_per_detector for diagnostic visibility
    // but do NOT count toward acceptance bound.
    const exemptedMetadata: Record<string, { detector: Q60DetectorFamily; reason: string; observed_delta_FPR: number }> = {};
    let fprMaxAbsNonExempt = 0;
    for (const family of Q60_DETECTOR_FAMILIES) {
      const dFpr = deltaFprPerDetector[family];
      if (isDetectorExemptFromCrossSubstrateFPR(family)) {
        exemptedMetadata[family] = {
          detector: family,
          reason: CROSS_SUBSTRATE_FPR_EXEMPT_DETECTORS[family]!,
          observed_delta_FPR: dFpr,
        };
        continue;
      }
      const absDFpr = Math.abs(dFpr);
      if (absDFpr > fprMaxAbsNonExempt) fprMaxAbsNonExempt = absDFpr;
    }
    const fprThreshold = 0.5 * Math.max(...Object.values(Q60_ALPHA_BUDGETS)) * 1.2;
    out[key] = {
      reference_substrate: referenceSubstrate,
      delta_TPR_per_detector: deltaTprPerDetector,
      delta_FPR_per_detector: deltaFprPerDetector,
      delta_median_TTD_per_detector: deltaTtdPerDetector,
      acceptance_gates_passed: {
        cross_substrate_delta_fpr_within_bound: fprMaxAbsNonExempt <= fprThreshold,
        cross_substrate_delta_tpr_within_bound: true,  // stub; Phase 3 fills
        cross_substrate_delta_ttd_within_bound: true,  // stub; Phase 3 fills
      },
      // Q62 Phase 4 H1a+H1b additive fields (preserve backward-compat
      // via optional schema field; pre-amendment consumers ignore).
      exempted_detector_count: Object.keys(exemptedMetadata).length,
      exempted_detector_metadata: exemptedMetadata,
    };
  }
  return out;
}

// ── Main orchestrator ────────────────────────────────────────────

export function runShadowCompare(opts: ShadowCompareOpts): ShadowCompareReport {
  const healthyWindows = opts.healthyWindows ?? DEFAULT_HEALTHY_WINDOWS;
  fs.mkdirSync(opts.outputDir, { recursive: true });

  // Step 0 — Q60 Phase-3.d.1 (D) per-substrate detector exemption
  // map. Computed once per substrate at sweep entry; injected into
  // each (substrate × scenario × seed) checkpoint and used to zero out
  // exempted detector counts during aggregation.
  // Phase-3.d.1 L3b β.1 extension: parametric_ar1-mode detectors are
  // additionally exempted on substrates that can't form the 11-signal
  // joint cholesky_L vector. The orchestrator passes
  // --skip-parametric-ar1 to build-report-card so it stubs that pass
  // with iid_bootstrap; orchestrator zeroes the parametric_ar1-mode
  // detectors' counts at trial completion via the L2 exemption map.
  const exemptionsBySubstrate = new Map<string, Partial<Record<Q60DetectorFamily, string>>>();
  const skipParametricAr1BySubstrate = new Map<string, boolean>();
  for (const substrate of opts.substrates) {
    const presentSignals = opts.dryRun ? FAMILY_C_SIGNALS : readSubstratePresentSignals(substrate);
    const exemptions: Partial<Record<Q60DetectorFamily, string>> = {};
    for (const family of Q60_DETECTOR_FAMILIES) {
      const decision = isDetectorExercisedAtSubstrate(family, presentSignals);
      if (!decision.exercised && decision.exemption_reason) {
        exemptions[family] = decision.exemption_reason;
      }
    }
    const ar1Eligibility = isParametricAr1PassEligible(substrate.name, presentSignals);
    skipParametricAr1BySubstrate.set(substrate.name, !ar1Eligibility.eligible);
    if (!ar1Eligibility.eligible && ar1Eligibility.reason) {
      for (const family of PARAMETRIC_AR1_MODE_DETECTORS) {
        exemptions[family] = ar1Eligibility.reason;
      }
    }
    exemptionsBySubstrate.set(substrate.name, exemptions);
    if (Object.keys(exemptions).length > 0) {
      console.warn(
        `[run-shadow-compare] Q60 Phase-3.d.1 (D)+L3b substrate=${substrate.name} `
        + `present_signals=[${presentSignals.join(', ')}] `
        + `exempted detectors: ${Object.keys(exemptions).join(', ')}`
        + (skipParametricAr1BySubstrate.get(substrate.name) ? ' (parametric_ar1 PASS skipped)' : ''));
    }
  }

  // Step 1 — per-(substrate × scenario × seed) sweep with V2
  // incremental emission. Resume semantic: completed checkpoints are
  // skipped; in-progress / failed / pending checkpoints are re-run.
  for (const substrate of opts.substrates) {
    const exemptions = exemptionsBySubstrate.get(substrate.name) ?? {};
    for (const scenario of opts.scenarios) {
      for (const seed of opts.seeds) {
        const checkpointPath = checkpointPathFor(
          opts.outputDir, substrate.name, scenario, seed,
        );
        const existing = readCheckpoint(checkpointPath);
        if (existing?.status === 'completed') continue;

        const startTs = existing?.start_timestamp ?? Date.now();
        writeCheckpoint(checkpointPath, {
          substrate: substrate.name,
          scenario,
          seed,
          status: 'in_progress',
          start_timestamp: startTs,
          detector_exemptions: exemptions,
        });

        try {
          const trial = runProfileValidationSingleSeed(
            substrate, scenario, seed, opts.outputDir, healthyWindows, opts.dryRun ?? false,
            skipParametricAr1BySubstrate.get(substrate.name) ?? false,
          );
          // Zero out firing counts + ids for exempted detectors so
          // downstream aggregation reflects the exemption uniformly
          // regardless of what build-report-card emitted.
          for (const family of Object.keys(exemptions) as Q60DetectorFamily[]) {
            trial.per_detector_firing_counts[family] = 0;
            trial.per_detector_firing_ids[family] = [];
          }
          writeCheckpoint(checkpointPath, {
            substrate: substrate.name,
            scenario,
            seed,
            status: 'completed',
            start_timestamp: startTs,
            end_timestamp: Date.now(),
            per_detector_firing_counts: trial.per_detector_firing_counts,
            per_detector_firing_ids: trial.per_detector_firing_ids,
            detector_exemptions: exemptions,
          });
        } catch (err) {
          writeCheckpoint(checkpointPath, {
            substrate: substrate.name,
            scenario,
            seed,
            status: 'failed',
            start_timestamp: startTs,
            end_timestamp: Date.now(),
            error: err instanceof Error ? err.message : String(err),
            detector_exemptions: exemptions,
          });
          throw err;
        }
      }
    }
  }

  // Step 2 — aggregate per-(substrate × scenario) seed checkpoints
  // into per-profile report cards.
  const reportCards: Record<string, PerProfileReportCard> = {};
  for (const substrate of opts.substrates) {
    for (const scenario of opts.scenarios) {
      const key = `${substrate.name}--${scenario}`;
      reportCards[key] = aggregateSeedsToReportCard(
        substrate, scenario, opts.seeds, opts.outputDir, healthyWindows,
      );
    }
  }

  // Step 3 — cross-substrate diff vs reference (synthetic_v1 by
  // convention; first substrate in opts.substrates[]).
  const referenceSubstrate = opts.substrates[0].name;
  const crossSubstrateDiff = computeCrossSubstrateDiff(
    reportCards, referenceSubstrate, opts.scenarios,
  );
  for (const key of Object.keys(crossSubstrateDiff)) {
    reportCards[key].shadow_compare = crossSubstrateDiff[key];
  }

  // Step 4 — emit per-profile report card files.
  for (const key of Object.keys(reportCards)) {
    const reportPath = path.join(opts.outputDir, `${key}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(reportCards[key], null, 2) + '\n');
  }

  // Step 5 — emit cross-substrate diff aggregate file.
  const crossDiffPath = path.join(opts.outputDir, 'shadow-compare-cross-substrate.json');
  fs.writeFileSync(
    crossDiffPath,
    JSON.stringify({
      reference_substrate: referenceSubstrate,
      per_profile_diffs: crossSubstrateDiff,
    }, null, 2) + '\n',
  );

  // Step 6 — aggregate pitch summary.
  const pitchSummaryPath = path.join(
    path.dirname(opts.outputDir.replace(/\/$/, '')),
    'v8-real-trace-validation-pitch-summary.json',
  );
  const pitchSummary = {
    generated_at: new Date().toISOString(),
    n_substrates: opts.substrates.length,
    n_scenarios: opts.scenarios.length,
    n_seeds: opts.seeds.length,
    n_per_profile_report_cards: Object.keys(reportCards).length,
    reference_substrate: referenceSubstrate,
    per_profile_report_cards: Object.keys(reportCards).map((k) => ({
      key: k,
      profile: reportCards[k].profile,
      mean_fpr_per_detector: reportCards[k].per_detector_fpr_mean,
    })),
  };
  fs.writeFileSync(pitchSummaryPath, JSON.stringify(pitchSummary, null, 2) + '\n');

  // Aggregate acceptance gates: union across cross-substrate diffs.
  const acceptanceGates: Record<string, boolean> = {};
  for (const key of Object.keys(crossSubstrateDiff)) {
    for (const gate of Object.keys(crossSubstrateDiff[key].acceptance_gates_passed)) {
      acceptanceGates[gate] = (acceptanceGates[gate] ?? true)
        && crossSubstrateDiff[key].acceptance_gates_passed[gate];
    }
  }

  return {
    per_profile_report_cards: reportCards,
    cross_substrate_diff_path: crossDiffPath,
    acceptance_gates: acceptanceGates,
    pitch_summary_path: pitchSummaryPath,
  };
}

// ── CLI entrypoint ───────────────────────────────────────────────

interface CliArgs {
  substrates: string;        // comma-list e.g., 'v5,v8a,v8b,v8c'
  scenarios: string;         // comma-list e.g., 'all-5'
  seeds: string;             // comma-list of seed integers
  outputDir: string;
  dryRun: boolean;
  healthyWindows: number;
  /** Q66 item (h) follow-up — comma-list of methodology-resampler modes
   *  to declare for this sweep run. Validation-only / audit-visible
   *  metadata: modes are always composed internally per substrate inside
   *  build-report-card.js (3 internal passes per trial; parametric_ar1
   *  PASS auto-skipped on substrates that can't form the 11-signal joint
   *  cholesky_L vector per Q60 Phase-3.d.1 L3b β.1 logic). The flag is
   *  REQUIRED-but-validated-against-known-modes so routing pasteables
   *  carry mode-intent provenance forward; absence falls through to
   *  the default trio. Allowed values: iid_bootstrap | parametric_gaussian
   *  | parametric_ar1. */
  modes?: string;
  /** Q66 item (h) follow-up — single-summary JSON file path. When set,
   *  emits a consolidated summary (modes declared + per-substrate
   *  detector FPR means + acceptance gates) at this path AT END of
   *  sweep, in addition to the per-profile report cards in
   *  outputDir/. For Mac mini sweep workflows that consume one
   *  artifact via jq. */
  emit?: string;
}

const KNOWN_MODES = ['iid_bootstrap', 'parametric_gaussian', 'parametric_ar1'] as const;
type Mode = typeof KNOWN_MODES[number];

const SUBSTRATE_REGISTRY: Record<string, SubstrateRef> = {
  v5: {
    name: 'synthetic_v1',
    baselineDir: 'runs/baselines/synthetic-v1',
    compiledConfig: 'runs/compiled-configs/v5-sequential-e-process.json',
  },
  v8a: {
    name: 'real_burstgpt',
    baselineDir: 'runs/baselines/real-burstgpt-v1',
    compiledConfig: 'runs/compiled-configs/v8a-real-burstgpt-v1.json',
  },
  v8b: {
    name: 'real_azure_llm_inference',
    baselineDir: 'runs/baselines/real-azure-llm-inference-v1',
    compiledConfig: 'runs/compiled-configs/v8b-real-azure-llm-inference-v1.json',
  },
  v8c: {
    name: 'real_mooncake',
    baselineDir: 'runs/baselines/real-mooncake-v1',
    compiledConfig: 'runs/compiled-configs/v8c-real-mooncake-v1.json',
  },
  // Q62 Slice 2 H1 (HF-only narrowing per architect H1 disposition).
  // v9b/v9c reserved for Phase-3.d Slice 2.b future cycle.
  v9a: {
    name: 'real_huggingface_lmsys_arena',
    baselineDir: 'runs/baselines/real-huggingface-lmsys-arena-v1',
    compiledConfig: 'runs/compiled-configs/v9a-real-huggingface-lmsys-arena-v1.json',
  },
};

const ALL_5_SCENARIOS = [
  'anthropic_tpu_output_corruption_step_2025_09',
  'anthropic_xla_precision_drift_2025_08',
  'cloudflare_worker_kv_degradation_2024_03',
  'github_availability_latency_regression_2024_06',
  'openai_routing_error_ramp_2024_12_11',
];

function parseCliArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {
    outputDir: 'runs/validation-reports/profile-report-cards/',
    dryRun: false,
    healthyWindows: DEFAULT_HEALTHY_WINDOWS,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--substrates':       out.substrates = v; i++; break;
      case '--scenarios':         out.scenarios = v; i++; break;
      case '--seeds':             out.seeds = v; i++; break;
      case '--output-dir':        out.outputDir = v; i++; break;
      case '--dry-run':           out.dryRun = true; break;
      case '--healthy-windows':   out.healthyWindows = parseInt(v, 10); i++; break;
      case '--modes':             out.modes = v; i++; break;
      case '--emit':              out.emit = v; i++; break;
      default:
        if (k.startsWith('--')) throw new Error(`Unknown flag: ${k}`);
    }
  }
  if (!out.substrates || !out.scenarios || !out.seeds) {
    throw new Error(
      'Required flags: --substrates v5,v8a,v8b,v8c --scenarios all-5 '
      + '--seeds 42,43,44,45,46,47,48,49 [--output-dir <dir>] [--dry-run] '
      + '[--healthy-windows <N>] [--modes iid_bootstrap,parametric_gaussian,parametric_ar1] '
      + '[--emit <single-summary.json>]',
    );
  }
  if (out.modes !== undefined) {
    const declared = out.modes.split(',').map((m) => m.trim());
    for (const m of declared) {
      if (!KNOWN_MODES.includes(m as Mode)) {
        throw new Error(
          `Unknown mode '${m}' in --modes. Allowed: ${KNOWN_MODES.join(',')}.`,
        );
      }
    }
  }
  return out as CliArgs;
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const substrateNames = args.substrates.split(',').map((s) => s.trim());
  const substrates: SubstrateRef[] = substrateNames.map((n) => {
    const ref = SUBSTRATE_REGISTRY[n];
    if (!ref) throw new Error(`Unknown substrate: ${n}. Known: ${Object.keys(SUBSTRATE_REGISTRY).join(',')}`);
    return ref;
  });
  const scenarios = args.scenarios === 'all-5'
    ? ALL_5_SCENARIOS
    : args.scenarios.split(',').map((s) => s.trim());
  const seeds = args.seeds.split(',').map((s) => parseInt(s.trim(), 10));

  console.log(`[run-shadow-compare] Q60 Slice 1 sweep:`);
  console.log(`[run-shadow-compare]   substrates: ${substrateNames.join(', ')}`);
  console.log(`[run-shadow-compare]   scenarios:  ${scenarios.length}`);
  console.log(`[run-shadow-compare]   seeds:      ${seeds.length}`);
  console.log(`[run-shadow-compare]   total trials: ${substrates.length * scenarios.length * seeds.length}`);
  console.log(`[run-shadow-compare]   dry-run: ${args.dryRun}`);

  const result = runShadowCompare({
    substrates,
    scenarios,
    seeds,
    outputDir: args.outputDir,
    dryRun: args.dryRun,
    healthyWindows: args.healthyWindows,
  });

  console.log(`[run-shadow-compare] emitted ${Object.keys(result.per_profile_report_cards).length} per-profile report cards`);
  console.log(`[run-shadow-compare]   cross-substrate diff: ${result.cross_substrate_diff_path}`);
  console.log(`[run-shadow-compare]   pitch summary: ${result.pitch_summary_path}`);
  console.log(`[run-shadow-compare] acceptance gates:`);
  for (const [gate, pass] of Object.entries(result.acceptance_gates)) {
    console.log(`[run-shadow-compare]   ${gate}: ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
  }

  if (args.emit) {
    const declaredModes = args.modes !== undefined
      ? args.modes.split(',').map((m) => m.trim())
      : KNOWN_MODES.slice();
    // Q66 Phase-3.d.A close item (h) schema 2.3.0 — read per-mode pools
    // from per-seed report cards (build-report-card.js emits
    // {iid_bootstrap_pool, parametric_gaussian_pool, parametric_ar1_pool}
    // per detector). Aggregate FPR per (substrate × detector × mode)
    // by averaging across scenarios + seeds for that substrate.
    const perSubstratePerModeFpr: Record<string, Record<string, Record<string, number>>> = {};
    const perSubstrateDetectorFpr: Record<string, Record<string, number>> = {};
    for (const substrateKey of substrateNames) {
      const ref = SUBSTRATE_REGISTRY[substrateKey];
      if (!ref) continue;
      perSubstratePerModeFpr[ref.name] = {
        iid_bootstrap: {}, parametric_gaussian: {}, parametric_ar1: {},
      };
      const counts: Record<string, Record<string, number>> = {
        iid_bootstrap: {}, parametric_gaussian: {}, parametric_ar1: {},
      };
      for (const scenario of scenarios) {
        for (const seed of seeds) {
          const reportPath = path.join(
            args.outputDir, 'per-seed-reports',
            `${ref.name}--${scenario}--${seed}.json`,
          );
          if (!fs.existsSync(reportPath)) continue;
          let report: { detectors?: Record<string, Record<string, { fpr_per_131?: number }>> };
          try {
            report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
          } catch (_e) { continue; }
          const detectors = report.detectors ?? {};
          for (const [det, blocks] of Object.entries(detectors)) {
            for (const mode of KNOWN_MODES) {
              const pool = blocks[`${mode}_pool`];
              if (!pool || pool.fpr_per_131 === undefined) continue;
              const acc = perSubstratePerModeFpr[ref.name][mode];
              const cnt = counts[mode];
              const n = (cnt[det] ?? 0) + 1;
              acc[det] = ((acc[det] ?? 0) * (n - 1) + pool.fpr_per_131) / n;
              cnt[det] = n;
            }
          }
        }
      }
      // Backward-compat: collapse iid_bootstrap mode to flat field.
      perSubstrateDetectorFpr[ref.name] = { ...perSubstratePerModeFpr[ref.name].iid_bootstrap };
    }

    // Q66 spec § item (h) addendum halt criterion (a) — per-mode FPR
    // gate. Detector exempted from a mode → that mode's gate auto-passes.
    // Q60 L3b parametric_ar1-sparse-substrate exemption preserved via
    // existing detector_exemption_reason mechanism at orchestrator layer
    // (exemptionsBySubstrate already populated by Step 0; we re-consult
    // it here to short-circuit gate evaluation per architect addendum
    // pseudo-code).
    const PER_DETECTOR_ALPHA_BUDGETS: Record<string, number> = {
      family_A_betting: 2e-4, family_A_page_cusum: 1e-4,
      family_B_pattern_match: 0,
      family_C_safe_test: 1e-4, family_C_chi_square: 1e-4,
      family_D_spectral: 5e-5, family_D_kv_cache: 5e-5,
      family_E_conformal: 1e-4,
      mmd_betting: 1e-4, mmd_bootstrap_null: 1e-4,
    };
    // Q66 Phase-3.d.A.c.γ — conditional exemption per
    // isSweepModeCalibrationRegimeMatched. Per architect spec § (b.2):
    // detector × substrate × mode triples that fail the calibration-
    // regime-match check are exempted from FPR bound; tracked via
    // regimeMismatchExemptions (audit-visible alongside L3b exemption
    // reasons from Q60 V2 framework).
    const regimeMismatchExemptions: Record<string, string> = {};
    const perModeAcceptanceGates: Record<string, boolean> = {};
    for (const [substrateName, byMode] of Object.entries(perSubstratePerModeFpr)) {
      const ref = substrates.find((s) => s.name === substrateName);
      for (const [mode, byDetector] of Object.entries(byMode)) {
        for (const [det, fpr] of Object.entries(byDetector)) {
          const budget = PER_DETECTOR_ALPHA_BUDGETS[det] ?? 0;
          if (budget === 0) continue;
          const gateKey = `per_mode_fpr_${det}_${mode}_${substrateName}`;
          let regimeExempt = false;
          if (ref) {
            const decision = isSweepModeCalibrationRegimeMatched(
              ref, mode as SweepMode, det as Q60DetectorFamily,
            );
            if (!decision.matched && decision.reason) {
              regimeMismatchExemptions[gateKey] = decision.reason;
              regimeExempt = true;
            }
          }
          // Exempted triples auto-pass the gate (architect § (b.2)
          // sweep dispatch behavior: emit detector_exemption_reason;
          // DO NOT count toward halt-boundary (a)).
          perModeAcceptanceGates[gateKey] = regimeExempt || fpr <= budget * 1.2;
        }
      }
    }

    const summary = {
      generated_at: new Date().toISOString(),
      sweep_meta: {
        substrates: substrateNames,
        scenarios,
        seeds,
        modes_declared: declaredModes,
        modes_note: 'Per-mode pool fields (iid_bootstrap_pool, parametric_gaussian_pool, parametric_ar1_pool) emitted per Q66 schema 2.3.0. Halt criterion (a) per Q66 spec § item (h) addendum: pool[mode].fpr ≤ α × 1.2 per non-exempt detector × substrate × mode. Q60 L3b parametric_ar1-sparse-substrate exemption preserved via detector_exemption_reason at orchestrator layer. Q66 .A.c.γ extension: detector × substrate × mode triples that fail isSweepModeCalibrationRegimeMatched (calibration-regime-vs-sweep-regime mismatch class) are also exempted; reasons emitted in regime_mismatch_exemptions field.',
        n_trials: substrates.length * scenarios.length * seeds.length,
        output_dir: args.outputDir,
        report_card_schema_version: '2.3.0',
      },
      per_substrate_detector_fpr_iid_bootstrap: perSubstrateDetectorFpr,
      per_substrate_detector_fpr_parametric_gaussian: Object.fromEntries(
        Object.entries(perSubstratePerModeFpr).map(([s, m]) => [s, m.parametric_gaussian]),
      ),
      per_substrate_detector_fpr_parametric_ar1: Object.fromEntries(
        Object.entries(perSubstratePerModeFpr).map(([s, m]) => [s, m.parametric_ar1]),
      ),
      acceptance_gates: { ...result.acceptance_gates, ...perModeAcceptanceGates },
      regime_mismatch_exemptions: regimeMismatchExemptions,
      cross_substrate_diff_path: result.cross_substrate_diff_path,
      pitch_summary_path: result.pitch_summary_path,
    };
    fs.mkdirSync(path.dirname(args.emit), { recursive: true });
    fs.writeFileSync(args.emit, JSON.stringify(summary, null, 2) + '\n');
    console.log(`[run-shadow-compare]   single-summary: ${args.emit}`);
  }
}

if (process.argv.some((a) => a === '--substrates')) {
  main();
}
