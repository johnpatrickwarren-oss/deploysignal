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

import type { FusedVerdict, HealthResult, DetectorVerdict, FiredSignal } from './types';

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
  };
}
