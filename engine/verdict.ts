// engine/verdict.ts — Week 4 fusion layer (portfolio topology).
//
// Replaces the implicit cascade verdict at the engine boundary. Where W3's
// `computeVerdict(healthResult, ...)` reads the health gate's `rollback[]`
// and `extend[]` arrays and emits a single `Verdict`, portfolio fusion
// aggregates per-family verdicts explicitly:
//
//   - Any family fires `rollback` → fused verdict is `rollback`.
//   - No fires but ≥1 family `indeterminate` or ≥1 extend signal → `extend`.
//   - All families `clean` (or `suppressed`) → `proceed`.
//
// The math-level difference from cascade: α_spent is summed across firing
// families (union bound) rather than attributed to a single short-circuit
// source. Formal per-family α bound is preserved (Ville's inequality);
// the union bound gives the family-level sum.
//
// Dual-mode during W4: callers can request cascade output (mirrors
// `computeVerdict` for behavior parity) or portfolio output (new default
// after the adversarial sweep confirms zero divergences). The audit
// layer logs `fusion_topology` so replay can distinguish.

import type {
  FusedVerdict, HealthResult, DetectorVerdict, FiredSignal, EvidenceOutlookEntry,
} from './types';

export interface FuseOpts {
  topology: 'cascade' | 'portfolio';
  tick: number;
  totalTicks: number;
  deployRef: string;
  /** Optional Family D verdict injected by future detectors. */
  familyD?: DetectorVerdict | null;
  /** Optional Family E verdict injected by future detectors. */
  familyE?: DetectorVerdict | null;
}

/** Extract Family A verdicts from the health result. The health gate
 *  exposes them on `family_A_shadow`. */
function extractFamilyA(h: HealthResult): DetectorVerdict[] | null {
  return h.family_A_shadow && h.family_A_shadow.length > 0 ? h.family_A_shadow : null;
}

/** Partition rollback signals into Family A synthetic, Family C synthetic,
 *  and pure Family B (rule-based structural rollbacks). Family A entries
 *  are identified by `id` prefix `family_A_`; Family C by exact id
 *  `family_C`. Everything else is Family B (rule detectors). */
function partitionRollbacks(h: HealthResult): { familyB: FiredSignal[] } {
  const familyB: FiredSignal[] = [];
  for (const s of h.rollback) {
    if (s.id.startsWith('family_A_')) continue;
    if (s.id === 'family_C') continue;
    if (s.id === 'family_C_mmd') continue;   // Addition #18 second Family C detector
    if (isFamilyDSyntheticId(s.id)) continue;
    if (s.id === 'family_E') continue;
    familyB.push(s);
  }
  return { familyB };
}

/** Sum α_spent across a verdict collection. Undefined entries contribute 0. */
function alphaSpent(...vs: Array<DetectorVerdict | DetectorVerdict[] | null | undefined>): number {
  let sum = 0;
  for (const v of vs) {
    if (!v) continue;
    if (Array.isArray(v)) {
      for (const vv of v) sum += vv.alpha_spent ?? 0;
    } else {
      sum += v.alpha_spent ?? 0;
    }
  }
  return sum;
}

/** True when any verdict in the collection is `fire`. */
function anyFire(vs: DetectorVerdict[] | null | undefined): boolean {
  if (!vs) return false;
  for (const v of vs) if (v.verdict === 'fire') return true;
  return false;
}

/** True when any verdict is `indeterminate` (accumulating below threshold). */
function anyIndeterminate(vs: DetectorVerdict[] | null | undefined): boolean {
  if (!vs) return false;
  for (const v of vs) if (v.verdict === 'indeterminate') return true;
  return false;
}

/** Partition Family D rollback synthetic IDs (family_D_<signal>) from Family B. */
function isFamilyDSyntheticId(id: string): boolean {
  return id.startsWith('family_D_');
}

// ── WS5 verdict explainability (verdict_rationale + evidence_outlook) ──
//
// Mechanical template over data fuseVerdict already has in scope — no
// new statistics, no FM calls, no new orchestrator parameters. Kept as
// small helper functions per arch-invariants' complexity ceiling.

type FamilyLetter = 'A' | 'B' | 'C' | 'D' | 'E';
type EvidenceState = 'fired' | 'accumulating' | 'clean' | 'suppressed';

/** Working shape before rendering to the public `note` string;
 *  `firedSignals`/`suppressionReason` feed both `evidence_outlook`
 *  notes and `verdict_rationale` clauses so the two stay consistent. */
interface FamilyEvidenceRaw {
  family_id: FamilyLetter;
  state: EvidenceState;
  progress: number | null;
  /** See `EvidenceOutlookEntry.progress_scale`. */
  progress_scale: 'linear' | 'wealth' | null;
  /** See `EvidenceOutlookEntry.detector_kind`. Family C only. */
  detector_kind?: 'hotelling' | 'e_mmd_betting';
  firedSignals: string[];
  suppressionReason: string | null;
}

/** `statistic / threshold` for one detector verdict. `null` when either
 *  is unavailable or threshold isn't positive. Same formula the audit
 *  layer uses for Family A's `cusum_progress`
 *  (engine/_audit-families.ts `tripFromVerdict`), applied here to any
 *  family — see `EvidenceOutlookEntry.progress` doc for why. */
function detectorProgress(v: DetectorVerdict): number | null {
  if (v.statistic === null || v.threshold === null || v.threshold <= 0) return null;
  return v.statistic / v.threshold;
}

// ── Scale-honest progress (Important-finding fix, 2026-07; corrected
// 2026-07-17 re-review) ─────────────────────────────────────────────
//
// `statistic / threshold` is not one scale across all families. Two
// mathematically distinct detector shapes both populate `statistic`/
// `threshold` on DetectorVerdict:
//
//   'linear'-ish closeness: Page-CUSUM S_n vs -log(α)
//     (engine/detectors/_page-cusum-core.ts evaluateCUSUM), legacy χ²
//     Hotelling T² vs a Wilson-Hilferty quantile (engine/detectors/
//     _hotelling-dispatch.ts evaluateHotellingChiSquare), legacy
//     spectral bootstrap-null peak|ACF| vs a bootstrap quantile
//     (engine/detectors/spectral.ts evaluateSpectralBootstrapNull),
//     legacy conformal p-value/Mahalanobis-distance vs α or a quantile
//     (engine/detectors/conformal.ts evaluateConformalUnweighted /
//     evaluateConformalWeightedQuantile). These grow roughly additively
//     tick-over-tick, so "42% of fire threshold" is an honest read.
//
//   'wealth' (multiplicative e-process): the statistic is a Ville's-
//     inequality wealth martingale M_t = M_{t-1} · e_t vs threshold =
//     1/α (or a sliding-buffer-calibrated analog on the same scale) —
//     Family A betting e-process (engine/detectors/betting-e-process.ts,
//     `threshold = ... ?? 1/alphaBetting`), Family C safe-Hotelling
//     (engine/detectors/_hotelling-safe.ts:58, `... ?? (1/input.alpha)`),
//     Family C e-MMD (engine/detectors/sequential-mmd.ts:323,
//     `1/eMmd.alpha`) and canonical betting (engine/detectors/
//     family-c-betting-e-process.ts, "Fire when S_t ≥ 1/α"), Family D's
//     spectral e-detector (engine/detectors/spectral.ts:303,
//     `1/input.alpha`), Family E's weighted e-value (engine/detectors/
//     conformal.ts:382, `1/input.alpha`). M_t starts at 1 and compounds
//     multiplicatively — it can sit at a small fraction of threshold
//     for many ticks and then cross it within one or two. "72% of fire
//     threshold" phrasing reads as smooth linear progress; it isn't.
//
// `progressScaleFor` below classifies a single DetectorVerdict using
// only fields fuseVerdict already has (no verdict-computation change).
// `reason_code`/`signal` identify the producing evaluator definitively
// in every case but one: Family A's Page-CUSUM and betting e-process
// are co-shipped per signal (Addition #17, ARCHITECT-REPLY-34) and both
// report `reason_code: 'accumulating'` on their `indeterminate` verdict
// (compare _page-cusum-core.ts's `state.S > 0 ? 'accumulating' : ...`
// to betting-e-process.ts's `state.M > 1 ? 'accumulating' : ...`) — no
// field on DetectorVerdict tags which produced a given indeterminate
// entry. For that case, and ONLY that case, this falls back to reading
// `threshold`'s own magnitude via MAGNITUDE_FALLBACK_THRESHOLD_FLOOR.
// Family C no longer reaches this fallback at all — see the header
// comment on `progressScaleForFamilyC` below for why (2026-07-17
// re-review finding: the old comment here claimed "Wilson-Hilferty χ²
// up to 30 joint signals at α=1e-5 stays under 50", which is false —
// χ²(df=30, 1-1e-5) ≈ 75, and even χ²(df=20, 1-1e-4) ≈ 52.4 already
// clears the floor. A future profile widening Family C's joint vector
// to ~15-20 signals would have silently mislabeled the legacy χ²
// Hotelling test 'wealth').
//
// The TRUE margin analysis for the one case this floor is actually
// load-bearing for (Family A's shared 'accumulating' reason_code):
//   - CUSUM: threshold = -log(α) (natural log; `_page-cusum-core.ts`
//     line 96). Crosses the floor of 50 only when -log(α) ≥ 50, i.e.
//     α ≤ e^-50 ≈ 1.9e-22 — this codebase configures α down to 1e-8
//     (threshold ≈ 18.4), nowhere near the floor.
//   - Betting e-process: threshold = 1/α (or a sliding-buffer analog on
//     the same scale). Drops below the floor of 50 only when α > 1/50
//     = 0.02 — this codebase's smallest configured α is far below that
//     (α ≤ 1e-2 per the design doc), so the threshold never drops below
//     the floor either.
//   CUSUM's threshold essentially never reaches 50; betting's threshold
//   essentially never falls below 50 — the floor sits safely in the gap
//   between the two ranges for every α this codebase configures.
//
// Two other call sites still reach this same floor as a defensive
// fallback and remain safe for structural reasons specific to each,
// NOT because of a wide α margin like Family A's:
//   - Family D's legacy bootstrap-null path (`spectral.ts`
//     evaluateSpectralBootstrapNull) and its e-detector wealth sibling
//     share `reason_code: 'below_threshold'` on `clean`, and D's
//     `signal` field is the metric name (e.g. `'kv_cache'`), not a
//     detector-kind tag, so it can't disambiguate. Safe because the
//     legacy threshold is `bootstrap_null_quantile` — a peak|ACF| value
//     structurally bounded in [0, 1] — and can never approach 50,
//     regardless of configuration, the way Family C's χ² threshold
//     (which scales with joint-signal count / degrees of freedom) can.
//   - Family E's `evaluateConformalWeightedEValue` covariance_singular
//     suppression (`conformal.ts` line ~386) omits the `signal:
//     'weighted_conformal_e_value'` tag its fire/clean siblings carry —
//     a pre-existing detector-code gap, out of scope here. Still safe:
//     that branch's `threshold` is unconditionally `1/α` (set before
//     the null check), the same wealth-scale value its tagged siblings
//     use, so the floor resolves it correctly today. Tracked as a
//     follow-up to add the missing signal tag directly in conformal.ts.

const MAGNITUDE_FALLBACK_THRESHOLD_FLOOR = 50;

/** `reason_code`s that definitively mark a wealth-scale DetectorVerdict,
 *  independent of family — see header comment above for citations.
 *  `emmd_wealth_exceeded`/`emmd_warming_moments` (sequential-mmd.ts
 *  evaluateEMmd) and `family_c_betting_wealth_exceeded`
 *  (_family-c-betting-eval.ts) are defense-in-depth here — Family C's
 *  e-MMD/betting slot is already classified unconditionally 'wealth'
 *  structurally by `progressScaleForFamilyC` and never reaches this
 *  set via `progressScaleFor`, but listing them keeps this set an
 *  accurate reason_code→scale map if `progressScaleFor` is ever reused
 *  directly against a Family C verdict (2026-07-17 re-review). */
const WEALTH_REASON_CODES = new Set([
  'betting_wealth_exceeded_threshold', 'at_initial_wealth',
  'safe_hotelling_wealth_exceeded', 'safe_hotelling_params_missing',
  'covariance_plus_tau_singular',
  'spectral_e_detector_wealth_exceeded', 'spectral_e_detector_params_missing',
  'spectral_null_std_nonpositive',
  'conformal_e_value_wealth_exceeded', 'weighted_e_value_state_missing',
  'emmd_wealth_exceeded', 'emmd_warming_moments',
  'family_c_betting_wealth_exceeded',
]);

/** `reason_code`s that definitively mark a linear-ish DetectorVerdict. */
const LINEAR_REASON_CODES = new Set([
  'cusum_exceeded_threshold', 'reset_to_zero',
  'hotelling_exceeded_threshold',
  'conformal_p_below_threshold', 'weighted_conformal_threshold_exceeded',
]);

/** `signal` values that definitively mark a wealth-scale detector at
 *  EVERY verdict state, including states whose `reason_code` is shared
 *  with a linear sibling detector (see header comment). */
const WEALTH_SIGNAL_NAMES = new Set([
  'hotelling_t2_safe', 'sequential_mmd_e_process',
  'sequential_mmd_betting_e_process', 'weighted_conformal_e_value',
]);

/** Classify one DetectorVerdict's `statistic`/`threshold` scale. See the
 *  header comment above for the full evaluator-by-evaluator mapping and
 *  the documented last-resort magnitude fallback. NOT used for Family C
 *  — see `progressScaleForFamilyC`, which classifies Family C
 *  structurally and never reaches the magnitude fallback below. */
function progressScaleFor(v: DetectorVerdict): 'linear' | 'wealth' {
  if (v.signal && WEALTH_SIGNAL_NAMES.has(v.signal)) return 'wealth';
  if (WEALTH_REASON_CODES.has(v.reason_code)) return 'wealth';
  if (LINEAR_REASON_CODES.has(v.reason_code) || v.reason_code.startsWith('spectral_peak_at_lag_')) {
    return 'linear';
  }
  return (v.threshold !== null && v.threshold >= MAGNITUDE_FALLBACK_THRESHOLD_FLOOR) ? 'wealth' : 'linear';
}

/** Classify a Family C DetectorVerdict's scale structurally — no
 *  magnitude fallback, ever (2026-07-17 re-review: this is exactly the
 *  fallback path that could silently mislabel the legacy χ² Hotelling
 *  test 'wealth' if a future profile widened the joint vector — see the
 *  header comment above `MAGNITUDE_FALLBACK_THRESHOLD_FLOOR`).
 *
 *  `kind === 'e_mmd_betting'` (the `family_C_mmd_verdict` slot) is
 *  unconditionally 'wealth': every evaluator that can produce it —
 *  `evaluateEMmd` (sequential-mmd.ts, `signal:
 *  'sequential_mmd_e_process'`) and `evaluateFamilyCBettingEProcess`
 *  (_family-c-betting-eval.ts, `signal:
 *  'sequential_mmd_betting_e_process'`) — is a Ville's-inequality
 *  wealth process by construction (fires at `S_t ≥ 1/α`), on every
 *  verdict state including `suppressed`.
 *
 *  `kind === 'hotelling'` (the `family_C_verdict` slot) co-ships two
 *  variants selected per-cell (`_hotelling-dispatch.ts`
 *  `hotellingVariantForDispatch`): the legacy χ² test
 *  (`evaluateHotellingChiSquare`) is stateless and never sets `.signal`
 *  — always 'linear'. The safe-Hotelling e-process
 *  (`evaluateSafeHotelling`, _hotelling-safe.ts) sets `signal:
 *  'hotelling_t2_safe'` on every verdict it returns — fire, clean, AND
 *  suppressed — so that tag alone is a definitive, non-magnitude
 *  discriminator for which variant produced a given `famC` verdict. */
function progressScaleForFamilyC(
  v: DetectorVerdict, kind: 'hotelling' | 'e_mmd_betting',
): 'linear' | 'wealth' {
  if (kind === 'e_mmd_betting') return 'wealth';
  return v.signal === 'hotelling_t2_safe' ? 'wealth' : 'linear';
}

/** Max per-detector progress among `vs` classified as `scale`; `null`
 *  when none report one. Scale-scoped so callers never average/max
 *  across incomparable scales into one ratio. */
function maxProgressOfScale(vs: DetectorVerdict[], scale: 'linear' | 'wealth'): number | null {
  let best: number | null = null;
  for (const v of vs) {
    if (progressScaleFor(v) !== scale) continue;
    const p = detectorProgress(v);
    if (p !== null && (best === null || p > best)) best = p;
  }
  return best;
}

/** Pick one scale-honest `progress`/`progress_scale` pair for a family
 *  whose per-signal detector array may co-ship linear AND wealth
 *  detectors on the same signal (Family A: Page-CUSUM + betting
 *  e-process, per Addition #17 — both run every tick, not mutually
 *  exclusive). Prefers `wealth` when both scales report a value: a
 *  compounding wealth process nearing its threshold is the more
 *  decision-relevant thing to surface, and — per the header comment
 *  above — it can move much faster than the linear reading beside it
 *  would suggest. Never combines the two into one ratio. */
function pickScaleAndProgress(
  vs: DetectorVerdict[],
): { progress: number | null; scale: 'linear' | 'wealth' | null } {
  const wealth = maxProgressOfScale(vs, 'wealth');
  if (wealth !== null) return { progress: wealth, scale: 'wealth' };
  const linear = maxProgressOfScale(vs, 'linear');
  return linear !== null ? { progress: linear, scale: 'linear' } : { progress: null, scale: null };
}

/** True when a non-empty detector list is entirely `suppressed`. */
function allSuppressed(vs: DetectorVerdict[]): boolean {
  return vs.length > 0 && vs.every((v) => v.verdict === 'suppressed');
}

/** Map suppressed `reason_code`s to a stable vocabulary. Mirrors
 *  `mapSuppression` in engine/_audit-families.ts (kept local here to
 *  avoid a fusion-layer → audit-layer import; both read the same
 *  `DetectorVerdict.reason_code` values). */
function suppressionReasonFor(codes: string[]): string {
  if (codes.indexOf('observability_stack_deploy') >= 0) return 'observability_stack_deploy';
  if (codes.indexOf('schema_continuity_breaking') >= 0) return 'schema_continuity_breaking';
  if (codes.indexOf('expected_failure_pattern') >= 0) return 'expected_failure_pattern';
  if (codes.indexOf('ignore_threshold') >= 0) return 'ignore_threshold';
  return 'bake_profile';
}

/** Summarize a per-signal detector family (A/D/E-shaped: a flat array
 *  of DetectorVerdicts, each optionally naming its `.signal`). */
function summarizeSignalFamily(id: FamilyLetter, vs: DetectorVerdict[]): FamilyEvidenceRaw {
  const fired = vs.filter((v) => v.verdict === 'fire');
  const state: EvidenceState = fired.length > 0 ? 'fired'
    : allSuppressed(vs) ? 'suppressed'
    : anyIndeterminate(vs) ? 'accumulating'
    : 'clean';
  const { progress, scale } = pickScaleAndProgress(vs);
  return {
    family_id: id,
    state,
    progress,
    progress_scale: scale,
    firedSignals: fired.map((v) => v.signal ?? 'unknown'),
    suppressionReason: state === 'suppressed' ? suppressionReasonFor(vs.map((v) => v.reason_code)) : null,
  };
}

/** Family B — structural rules from FiredSignal[]. No statistic /
 *  threshold, no suppression or indeterminate concept (see header
 *  comment: "Family B doesn't spend Ville budget"); binary
 *  fired-or-clean this tick. */
function summarizeFamilyB(familyB: FiredSignal[]): FamilyEvidenceRaw {
  return {
    family_id: 'B',
    state: familyB.length > 0 ? 'fired' : 'clean',
    progress: null,
    progress_scale: null,
    firedSignals: familyB.map((s) => s.label),
    suppressionReason: null,
  };
}

/** Summarize one Family C detector (Hotelling T² or Sequential MMD/
 *  betting) as its own `FamilyEvidenceRaw`. Single-DetectorVerdict form
 *  of `summarizeSignalFamily` — Family C's two detectors are separate
 *  fields on `HealthResult` (`family_C_verdict`/`family_C_mmd_verdict`),
 *  not a per-signal array, so there's no scale-mixing risk *within* one
 *  call; the mixing risk this whole module fixes is calling this twice
 *  and combining the results, which `summarizeFamilyC` below never
 *  does — see its header comment. */
function summarizeSingleCDetector(
  v: DetectorVerdict, label: string, kind: 'hotelling' | 'e_mmd_betting',
): FamilyEvidenceRaw {
  const state: EvidenceState = v.verdict === 'fire' ? 'fired'
    : v.verdict === 'suppressed' ? 'suppressed'
    : v.verdict === 'indeterminate' ? 'accumulating'
    : 'clean';
  const progress = detectorProgress(v);
  return {
    family_id: 'C',
    state,
    progress,
    progress_scale: progress !== null ? progressScaleForFamilyC(v, kind) : null,
    detector_kind: kind,
    firedSignals: state === 'fired' ? [label] : [],
    suppressionReason: state === 'suppressed' ? suppressionReasonFor([v.reason_code]) : null,
  };
}

/** Family C — two independent, numerically-incomparable detectors
 *  (Hotelling T² — χ² on the legacy path, a Ville's-inequality wealth
 *  process on the safe-Hotelling path; Sequential MMD/betting — always
 *  a wealth process, see `progressScaleForFamilyC` header comment).
 *  Emits ONE `FamilyEvidenceRaw` per detector that produced a verdict this tick
 *  (never combines their `statistic`/`threshold` into a single
 *  `maxProgress` — that was the confirmed finding: Hotelling's χ²-scale
 *  ratio and e-MMD's wealth-scale ratio are not comparable numbers), or
 *  one placeholder `'clean'` entry (matching the pre-fix single-entry
 *  shape) when neither detector produced data. `detector_kind`
 *  distinguishes the two in `evidence_outlook`/`verdict_rationale`. */
function summarizeFamilyC(famC: DetectorVerdict | null, famCMmd: DetectorVerdict | null): FamilyEvidenceRaw[] {
  if (!famC && !famCMmd) {
    return [{
      family_id: 'C', state: 'clean', progress: null, progress_scale: null,
      firedSignals: [], suppressionReason: null,
    }];
  }
  const out: FamilyEvidenceRaw[] = [];
  if (famC) out.push(summarizeSingleCDetector(famC, 'Hotelling T²', 'hotelling'));
  if (famCMmd) out.push(summarizeSingleCDetector(famCMmd, 'Sequential MMD', 'e_mmd_betting'));
  return out;
}

function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** `0.72×`-style rendering for a wealth-scale progress ratio — see
 *  `renderAccumulatingNote`. */
function formatMultiplier(p: number): string {
  return `${p.toFixed(2)}×`;
}

/** `Family X` note prefix, optionally qualified with the Family-C
 *  detector-kind label (`detector_kind` is only ever set on Family C's
 *  split Hotelling/e-MMD entries — see `summarizeFamilyC`). Not used on
 *  the `'fired'` branch of `renderNote`, which already names the
 *  detector via `firedSignals`. */
function notePrefix(r: FamilyEvidenceRaw): string {
  const kindLabel = r.detector_kind === 'hotelling' ? 'Hotelling T²'
    : r.detector_kind === 'e_mmd_betting' ? 'e-MMD/betting' : null;
  return kindLabel ? `Family ${r.family_id} (${kindLabel})` : `Family ${r.family_id}`;
}

/** `'accumulating'`-state note, scale-honest per `progress_scale` — see
 *  the "Scale-honest progress" header comment above `progressScaleFor`
 *  for why "N% of fire threshold" misreads a multiplicative wealth
 *  process. */
function renderAccumulatingNote(r: FamilyEvidenceRaw): string {
  const prefix = notePrefix(r);
  if (r.progress === null) return `${prefix} accumulating evidence`;
  if (r.progress_scale === 'wealth') {
    return `${prefix} accumulating evidence, wealth at ${formatMultiplier(r.progress)} fire threshold `
      + '(multiplicative — evidence can compound quickly under sustained drift)';
  }
  return `${prefix} accumulating evidence at ${formatPct(r.progress)} of fire threshold`;
}

/** Render an `EvidenceOutlookEntry.note` from a family's raw summary. */
function renderNote(r: FamilyEvidenceRaw): string {
  if (r.state === 'fired') {
    return r.firedSignals.length > 0
      ? `Family ${r.family_id} fired on ${r.firedSignals.join(', ')}`
      : `Family ${r.family_id} fired`;
  }
  if (r.state === 'accumulating') return renderAccumulatingNote(r);
  if (r.state === 'suppressed') {
    return `${notePrefix(r)} suppressed (${r.suppressionReason ?? 'unknown'})`;
  }
  return `${notePrefix(r)} clean`;
}

function toEvidenceOutlook(raw: FamilyEvidenceRaw[]): EvidenceOutlookEntry[] {
  return raw.map((r) => ({
    family_id: r.family_id,
    state: r.state,
    progress: r.progress,
    progress_scale: r.progress_scale,
    detector_kind: r.detector_kind,
    note: renderNote(r),
  }));
}

/** `rollback` rationale: which families fired, on which signals; a
 *  trailing clause names any concurrently-suppressed family. */
function rationaleRollback(raw: FamilyEvidenceRaw[]): string {
  const fired = raw.filter((r) => r.state === 'fired');
  const suppressed = raw.filter((r) => r.state === 'suppressed');
  let s = `Rollback triggered: ${fired.map(renderNote).join('; ')}.`;
  if (suppressed.length > 0) s += ` ${suppressed.map(renderNote).join('; ')}.`;
  return s;
}

/** `extend` rationale: which families are accumulating evidence
 *  (indeterminate) and/or which rule-based extend signals fired,
 *  followed by any suppressed families with `suppression_reason`. */
function rationaleExtend(raw: FamilyEvidenceRaw[], extendSignalLabels: string[]): string {
  const accumulating = raw.filter((r) => r.state === 'accumulating');
  const suppressed = raw.filter((r) => r.state === 'suppressed');
  const parts: string[] = [];
  if (accumulating.length > 0) parts.push(accumulating.map(renderNote).join('; '));
  if (extendSignalLabels.length > 0) parts.push(`extend signal(s): ${extendSignalLabels.join(', ')}`);
  const first = parts.length > 0
    ? `Extending observation: ${parts.join('; ')}.`
    : 'Extending observation: evidence accumulating below the fire threshold.';
  const second = suppressed.length > 0 ? ` ${suppressed.map(renderNote).join('; ')}.` : '';
  return first + second;
}

/** `proceed` / `baking` rationale: all families clean / in-window.
 *  `proceed` additionally flags evidence that was still accumulating
 *  when the window closed (indeterminate collapses to the `proceed`
 *  verdict per the header comment, but evidence_outlook keeps the
 *  honest per-family state, so the rationale stays consistent with it). */
function rationaleSettled(verdict: 'proceed' | 'baking', raw: FamilyEvidenceRaw[]): string {
  const suppressed = raw.filter((r) => r.state === 'suppressed');
  const accumulating = raw.filter((r) => r.state === 'accumulating');
  let base: string;
  if (verdict === 'proceed') {
    base = accumulating.length > 0
      ? 'Proceed: observation window closed with no rollback signals; some evidence remained below the fire threshold.'
      : 'Proceed: observation window closed with no rollback signals across all families.';
  } else {
    base = 'Baking: all families clean so far; continuing observation within the window.';
  }
  return suppressed.length > 0 ? `${base} ${suppressed.map(renderNote).join('; ')}.` : base;
}

function buildRationale(
  verdict: FusedVerdict['verdict'],
  raw: FamilyEvidenceRaw[],
  extendSignalLabels: string[],
): string {
  if (verdict === 'rollback') return rationaleRollback(raw);
  if (verdict === 'extend') return rationaleExtend(raw, extendSignalLabels);
  return rationaleSettled(verdict, raw);
}

/** Portfolio fusion over the health gate's per-family outputs. */
export function fuseVerdict(health: HealthResult, opts: FuseOpts): FusedVerdict {
  const famA = extractFamilyA(health);
  const famC = health.family_C_verdict ?? null;
  const famCMmd = health.family_C_mmd_verdict ?? null;
  // Family D/E are now populated by the health gate; `opts.familyD/E`
  // remain as test-side injection points for unit coverage.
  const famDArr: DetectorVerdict[] = health.family_D_shadow && health.family_D_shadow.length > 0
    ? health.family_D_shadow : [];
  const famDInjected = opts.familyD ?? null;
  const famE = health.family_E_verdict ?? opts.familyE ?? null;
  const { familyB } = partitionRollbacks(health);

  const firing: FusedVerdict['firing_families'] = [];

  // Family A: any per-signal CUSUM fire.
  const aFires = anyFire(famA);
  if (aFires) firing.push('A');

  // Family B: any structural-rule rollback (after stripping A/C synthetic IDs).
  const bFires = familyB.length > 0;
  if (bFires) firing.push('B');

  // Family C: Hotelling T² + Sequential MMD (Addition #18). Either firing
  // flips Family C to fire. Both detectors spend α independently under
  // the 50/50 D8 split.
  const cFires = famC?.verdict === 'fire' || famCMmd?.verdict === 'fire';
  if (cFires) firing.push('C');

  // Family D: per-signal array. Any fire pushes D into firing_families.
  const dFires = anyFire(famDArr) || famDInjected?.verdict === 'fire';
  if (dFires) firing.push('D');
  // Family E: single multivariate verdict.
  const eFires = famE?.verdict === 'fire';
  if (eFires) firing.push('E');

  // ── Verdict ──
  // Portfolio tick-level semantics described in WEEK4-HANDOFF.md §4.1.b,
  // amended in coordination/ARCHITECT-REPLY-19.md Q1:
  //   - Any family fires `rollback` → rollback.
  //   - Observation window has closed (final tick) with no fires →
  //     `proceed`. Indeterminate states collapse to clean for the
  //     proceed decision: the window is a bounded contract, and
  //     "indeterminate past the window" would be extending the window,
  //     not a fusion-layer default.
  //   - Any family indeterminate or any `extend` signal → `extend`
  //     (only reachable pre-final-tick).
  //   - All families clean → baking (during deploy window).
  const isLastTick = opts.tick >= opts.totalTicks - 1;
  const anyExtend =
    health.extend.length > 0 ||
    anyIndeterminate(famA) ||
    famC?.verdict === 'indeterminate' ||
    famCMmd?.verdict === 'indeterminate' ||
    anyIndeterminate(famDArr) ||
    famDInjected?.verdict === 'indeterminate' ||
    famE?.verdict === 'indeterminate';

  let verdict: FusedVerdict['verdict'];
  if (firing.length > 0) {
    verdict = 'rollback';
  } else if (isLastTick) {
    // Window closed without any family firing. Indeterminate collapses
    // to clean for the proceed decision — see header comment above.
    verdict = 'proceed';
  } else if (anyExtend) {
    verdict = 'extend';
  } else {
    verdict = 'baking';
  }

  // ── α_spent sum (Ville's per-family bounds → union bound) ──
  // Family B doesn't spend Ville budget (hand-tuned rule-based detectors).
  const total_alpha_spent = alphaSpent(famA, famC, famCMmd, famDArr, famDInjected, famE);

  // Surface a single Family D verdict (first fire, else first indeterminate,
  // else first clean) for the FusedVerdict shape. Per-signal breakdown is
  // available via health.family_D_shadow for audit.
  const famDSurfaced: DetectorVerdict | null =
    famDArr.find((v) => v.verdict === 'fire') ??
    famDArr.find((v) => v.verdict === 'indeterminate') ??
    famDArr[0] ??
    famDInjected ??
    null;

  // ── WS5 verdict explainability ──
  const famDAll = famDInjected ? [...famDArr, famDInjected] : famDArr;
  const evidenceRaw: FamilyEvidenceRaw[] = [
    summarizeSignalFamily('A', famA ?? []),
    summarizeFamilyB(familyB),
    ...summarizeFamilyC(famC, famCMmd),
    summarizeSignalFamily('D', famDAll),
    summarizeSignalFamily('E', famE ? [famE] : []),
  ];
  const evidence_outlook = toEvidenceOutlook(evidenceRaw);
  const verdict_rationale = buildRationale(verdict, evidenceRaw, health.extend.map((s) => s.label));

  return {
    verdict,
    firing_families: firing,
    per_family_verdicts: {
      A: famA,
      B: familyB.length > 0 ? familyB : null,
      C: famC,
      D: famDSurfaced,
      E: famE,
    },
    total_alpha_spent,
    fusion_topology: opts.topology,
    tick: opts.tick,
    deploy_ref: opts.deployRef,
    verdict_rationale,
    evidence_outlook,
  };
}
