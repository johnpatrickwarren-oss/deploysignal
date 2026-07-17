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

/** Max per-detector progress across a family; `null` when none report one. */
function maxProgress(vs: DetectorVerdict[]): number | null {
  let best: number | null = null;
  for (const v of vs) {
    const p = detectorProgress(v);
    if (p !== null && (best === null || p > best)) best = p;
  }
  return best;
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
  return {
    family_id: id,
    state,
    progress: maxProgress(vs),
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
    firedSignals: familyB.map((s) => s.label),
    suppressionReason: null,
  };
}

/** Family C — two independent detectors (Hotelling T², Sequential MMD)
 *  rather than a per-signal array; labeled positionally since neither
 *  carries a metric-signal name on `.signal`. */
function summarizeFamilyC(famC: DetectorVerdict | null, famCMmd: DetectorVerdict | null): FamilyEvidenceRaw {
  const entries: Array<{ v: DetectorVerdict; label: string }> = [];
  if (famC) entries.push({ v: famC, label: 'Hotelling T²' });
  if (famCMmd) entries.push({ v: famCMmd, label: 'Sequential MMD' });
  const vs = entries.map((e) => e.v);
  const fired = entries.filter((e) => e.v.verdict === 'fire');
  const state: EvidenceState = fired.length > 0 ? 'fired'
    : allSuppressed(vs) ? 'suppressed'
    : anyIndeterminate(vs) ? 'accumulating'
    : 'clean';
  return {
    family_id: 'C',
    state,
    progress: maxProgress(vs),
    firedSignals: fired.map((e) => e.label),
    suppressionReason: state === 'suppressed' ? suppressionReasonFor(vs.map((v) => v.reason_code)) : null,
  };
}

function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** Render an `EvidenceOutlookEntry.note` from a family's raw summary. */
function renderNote(r: FamilyEvidenceRaw): string {
  if (r.state === 'fired') {
    return r.firedSignals.length > 0
      ? `Family ${r.family_id} fired on ${r.firedSignals.join(', ')}`
      : `Family ${r.family_id} fired`;
  }
  if (r.state === 'accumulating') {
    return r.progress !== null
      ? `Family ${r.family_id} accumulating evidence at ${formatPct(r.progress)} of fire threshold`
      : `Family ${r.family_id} accumulating evidence`;
  }
  if (r.state === 'suppressed') {
    return `Family ${r.family_id} suppressed (${r.suppressionReason ?? 'unknown'})`;
  }
  return `Family ${r.family_id} clean`;
}

function toEvidenceOutlook(raw: FamilyEvidenceRaw[]): EvidenceOutlookEntry[] {
  return raw.map((r) => ({
    family_id: r.family_id, state: r.state, progress: r.progress, note: renderNote(r),
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
    summarizeFamilyC(famC, famCMmd),
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
