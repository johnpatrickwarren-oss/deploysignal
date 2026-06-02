// tools/_run-shadow-compare-exemptions.ts — Q60/Q66/Q70 detector
// exemption logic for the shadow-compare orchestrator (extracted
// verbatim from tools/run-shadow-compare.ts during a behavior-
// preserving module split).

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Q60DetectorFamily } from '../engine/types/config.js';
import {
  FAMILY_A_SIGNALS,
  FAMILY_C_SIGNALS,
  type SubstrateRef,
  type SweepMode,
} from './_run-shadow-compare-types';

// ── Q60 Phase-3.d.1 (D) per-detector exemption ───────────────────

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
export function readSubstratePresentSignals(substrate: SubstrateRef): readonly string[] {
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

export function isDetectorExercisedAtSubstrate(
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
export const PARAMETRIC_AR1_MODE_DETECTORS: readonly Q60DetectorFamily[] = [
  'family_D_spectral', 'family_D_kv_cache', 'family_E_conformal',
];

export function isParametricAr1PassEligible(
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
