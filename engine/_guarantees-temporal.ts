// engine/_guarantees-temporal.ts — C87 (2026-10-02): the rollback authority of the temporal path.
// Split out of engine/guarantees.ts (file-size ceiling) and re-exported from it; import from
// './guarantees'. No imports here, so it can never form a cycle with the guarantee table.

/** C87, 2026-10-02 — the TEMPORAL PATH is ADVISORY: every detector that tests the canary against
 *  a baseline fitted from history — Family A (mixture supermartingale, betting e-process, and the
 *  terminal safe-t path of C64 a), Family C (Hotelling T² in both variants, e-MMD, the canonical
 *  betting e-process) and Family D (spectral, both variants). Evidence, real telemetry, engine
 *  v0.12.2-pre, Ville thresholds 1/α with α_total = 1e-3, registered bar 0.05:
 *    - GWDG GPU telemetry (studies/gwdg-gate/REPORT.md, E1 FAIL): a Family-A-only gate rolled back
 *      40 of 44 healthy two-day units (0.909); with Family C beside it, 42 of 44 (0.955).
 *    - BurstGPT request stream (studies/burstgpt-gate/REPORT.md, E1 FAIL): the Family A gate on
 *      `cost_req` rolled back 13 of 87 healthy 100-tick windows (0.149).
 *  The Family A and C plug-in envelopes declare `validUnderEstimatedBaseline: false` (engine
 *  detectors/validity-envelope.ts). NOT measured on real telemetry, and advisory for want of a
 *  measurement rather than on a failed one: Family C alone, Family D, and the terminal safe-t
 *  path (its null needs the calibration window and the canary window to share one distribution).
 *
 *  While this is 'advisory', on every surface: a fire is recorded (the family's verdicts on the
 *  HealthResult, `evidence_outlook`, the audit record's family block and `advisory_fires`) with
 *  `advisory_reason` TEMPORAL_PATH_ADVISORY_REASON; every verdict of these families books
 *  `alpha_spent: 0`; no fire enters the health gate's `rollback[]` (engine/gates/
 *  _health-detectors.ts, _health-valid-path.ts), so the cascade verdict (`computeVerdict`,
 *  engine/core.ts) and the gate service never roll back on one; the fused verdict lists the
 *  family on `advisory_families`, never on `firing_families` (engine/verdict.ts). A rollback then
 *  comes from the policy gates (POLICY_GATE_IDS), from Family B where it still has a rollback
 *  effect (no compiled config, or a B-only compiled config: FAMILY_B_AUTHORITY), from the policy,
 *  approval, state, fail-fast and sample-ratio short-circuits, and nothing else. An `indeterminate` verdict still extends the canary as before.
 *  The twin path (TWIN_ARM_AUTHORITY) is separate and untouched.
 *
 *  Reversal, per family: a registered study on real telemetry showing that family's
 *  false-rollback rate within its declared bound under a declared null. Then this constant
 *  becomes per-family. test/c87-temporal-path-advisory.test.ts states the contract. */
export const TEMPORAL_PATH_AUTHORITY: 'advisory' | 'rollback' = 'advisory';

/** `advisory_reason` a temporal-path fire carries while TEMPORAL_PATH_AUTHORITY is 'advisory'. */
export const TEMPORAL_PATH_ADVISORY_REASON = 'advisory_temporal_path_no_valid_null';

/** The families TEMPORAL_PATH_AUTHORITY governs. */
export const TEMPORAL_PATH_FAMILIES: ReadonlySet<string> = new Set(['A', 'C', 'D']);

/** Is the temporal path advisory? One predicate so every surface agrees. */
export function temporalPathAdvisory(): boolean {
  return TEMPORAL_PATH_AUTHORITY === 'advisory';
}

/** `alpha_participating` on every DETECTOR_GUARANTEES row of Families A, C and D (C87): false while
 *  the path is advisory, because an advisory fire books no α. The rows keep their validity class,
 *  which describes the construction; this says no α is spent on it and no rollback follows. */
export const TEMPORAL_ALPHA_PARTICIPATING: boolean = temporalPathAdvisory() === false;
