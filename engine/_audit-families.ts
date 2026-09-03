// engine/_audit-families.ts — v2 record construction helpers (W4 §4.1.h).
// Split verbatim from engine/audit.ts; buildFamilyVerdictsV2 decomposed into
// per-family helpers (each <100 lines). Behavior is identical.

import type {
  OrchestrateParams, VerdictResult, FamilyId, DetectorId, DetectorTripV2,
  FamilyVerdictV2, Provenance, DetectorVerdict, FiredSignal, HealthResult,
  CompiledConfig, BaselineCellEntry, TrippedEntry,
} from './types';
import { DETECTOR_REGISTRY } from './types';

// ── v2 record construction helpers (W4 §4.1.h) ──────────────────────

/** Map a synthetic rollback[] id to the canonical {family_id, detector_id}
 *  pair in DETECTOR_REGISTRY. Returns null for unknown ids — the writer
 *  skips them to satisfy "no unknown_detector_id values in shipped
 *  records" (audit/SCHEMA.md v2 acceptance). */
/** Family A rollback ids → registry ids, longest prefix first. Addition #17: betting fires
 *  carry `family_A_betting_`; C64 (a): valid-path fires carry `family_A_safe_t_`
 *  (engine/gates/_health-valid-path.ts); everything else under `family_A_` is the Page-CUSUM
 *  path, emitted as the legacy `mSPRT_` id. `undefined` = not a Family A id. */
const FAMILY_A_ID_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['family_A_safe_t_', 'safe_t_e_value_'],
  ['family_A_betting_', 'betting_e_process_'],
  ['family_A_', 'mSPRT_'],
];
function resolveFamilyAId(id: string): { family_id: FamilyId; detector_id: DetectorId } | null | undefined {
  const hit = FAMILY_A_ID_PREFIXES.find(([prefix]) => id.startsWith(prefix));
  if (!hit) return undefined;
  const did = (hit[1] + id.slice(hit[0].length)) as DetectorId;
  return (DETECTOR_REGISTRY.A as readonly string[]).indexOf(did) >= 0 ? { family_id: 'A', detector_id: did } : null;
}

function resolveDetectorId(id: string): { family_id: FamilyId; detector_id: DetectorId } | null {
  // Addition #17 (ARCHITECT-REPLY-34 D2) — betting-e-process fires come
  // through with a `family_A_betting_` prefix so the audit writer can
  // distinguish them from Page-CUSUM fires (both share `family === 'A'`).
  // Must be checked before the broader `family_A_` branch.
  const a = resolveFamilyAId(id);
  if (a !== undefined) return a;
  if (id === 'family_C') return { family_id: 'C', detector_id: 'hotelling_t2_joint_vector' };
  if (id === 'family_C_mmd') return { family_id: 'C', detector_id: 'sequential_mmd' };
  if (id.startsWith('family_D_')) {
    const signal = id.slice('family_D_'.length);
    const did = ('spectral_peak_acf_' + signal) as DetectorId;
    if ((DETECTOR_REGISTRY.D as readonly string[]).indexOf(did) >= 0) return { family_id: 'D', detector_id: did };
    return null;
  }
  if (id === 'family_E') return { family_id: 'E', detector_id: 'mahalanobis_conformal_baseline' };
  // Family B: registry IDs are 1:1 with rollback[] ids on the portfolio path.
  if ((DETECTOR_REGISTRY.B as readonly string[]).indexOf(id) >= 0) {
    return { family_id: 'B', detector_id: id as DetectorId };
  }
  return null;
}

/** Look up the cell consulted at detector evaluation time. Returns
 *  null-filled provenance when cells don't apply (Family B structural). */
function cellProvenance(
  cfg: CompiledConfig | null | undefined,
  hourOfDay?: number,
  dayOfWeek?: number,
): Pick<Provenance, 'cell_key' | 'cell_confidence' | 'variance_inflated'> {
  if (!cfg?.baseline_cells || hourOfDay === undefined) {
    return { cell_key: null, cell_confidence: null, variance_inflated: false };
  }
  const match = findCell(cfg.baseline_cells.cells, hourOfDay, dayOfWeek);
  if (!match) {
    return { cell_key: null, cell_confidence: 'aggregate', variance_inflated: false };
  }
  return {
    cell_key: match.key,
    cell_confidence: match.confidence,
    variance_inflated: match.variance_inflated === true,
  };
}

function findCell(cells: BaselineCellEntry[], hour: number, day?: number): BaselineCellEntry | undefined {
  return cells.find((c) => {
    if (c.key.hour_of_day !== hour) return false;
    if (day !== undefined && c.key.day_of_week !== undefined) return c.key.day_of_week === day;
    return true;
  });
}

/** Produce the per-detector trip from a structured DetectorVerdict +
 *  synthetic rollback id + label. Pulls cell provenance server-side so
 *  the detector-side API stays unchanged. */
function tripFromVerdict(
  params: OrchestrateParams,
  rid: { family_id: FamilyId; detector_id: DetectorId },
  v: DetectorVerdict,
  label: string,
  gate: 'health_rollback' | 'health_extend',
  provExtras?: Partial<Pick<Provenance, 'family_c_shrink_fraction_used'>>,
): DetectorTripV2 {
  const prov = cellProvenance(params.compiledConfig, params.currentHourOfDay, params.currentDayOfWeek);
  const baselineVersion = params.compiledConfig?.version ?? 'legacy';
  const provenance: Provenance = {
    ...prov,
    covariate_freshness: 0,  // no CUPAC in current scope
    baseline_version: baselineVersion,
    // W5 §S6 (Addition #8 runtime consumer): pull the continuity class from
    // the detector-evaluation context the caller threaded through. Null when
    // the caller didn't emit an L0 continuity record (runway synthetic data).
    schema_continuity: params.schemaContinuityClass ?? null,
    ...(provExtras?.family_c_shrink_fraction_used !== undefined
      ? { family_c_shrink_fraction_used: provExtras.family_c_shrink_fraction_used }
      : {}),
  };
  const trip: DetectorTripV2 = {
    family_id: rid.family_id,
    detector_id: rid.detector_id,
    statistic: v.statistic,
    threshold: v.threshold,
    alpha_spent: v.alpha_spent,
    reason_code: v.reason_code,
    gate,
    label,
    provenance,
  };
  if (rid.family_id === 'A' && v.threshold && v.statistic !== null) {
    trip.cusum_progress = v.threshold > 0 ? v.statistic / v.threshold : 0;
  }
  // ADR 0027 evidence surface — copied through only when the verdict
  // carries it, so trips from verdicts without it (every trip on the
  // currently pinned engine) serialize to byte-identical JSONL.
  if (v.evidence) trip.evidence = { ...v.evidence };
  return trip;
}

/** Structural-rule Family B trip — no DetectorVerdict shape; fill stats
 *  as null and reason_code via the synthetic signal id. */
function tripFromFamilyB(
  params: OrchestrateParams,
  fired: FiredSignal,
  gate: 'health_rollback' | 'health_extend',
): DetectorTripV2 | null {
  const rid = resolveDetectorId(fired.id);
  if (!rid || rid.family_id !== 'B') return null;
  const prov = cellProvenance(params.compiledConfig, params.currentHourOfDay, params.currentDayOfWeek);
  // Family B structural detectors don't consult cells at today's
  // implementation; null out the cell fields for honesty. `variance_inflated`
  // flag still flows from the Family-A/C-consulted cell iff the scenario
  // happens to hit a pooled cell — emit `false` here since B didn't use it.
  const provenance: Provenance = {
    cell_key: null,
    cell_confidence: null,
    variance_inflated: false,
    covariate_freshness: 0,
    baseline_version: params.compiledConfig?.version ?? 'legacy',
    // W5 §S6: Family B is not suppressed by schema-continuity (per
    // Addition #8 — structural signatures don't depend on continuous metric
    // semantics), but the continuity class still attaches to provenance so
    // downstream consumers can see the L0 signal Family B evaluated against.
    schema_continuity: params.schemaContinuityClass ?? null,
  };
  return {
    family_id: 'B',
    detector_id: rid.detector_id,
    statistic: null,  // ratio-detector statistic not tracked in the v1 health surface
    threshold: null,
    alpha_spent: 0,   // Family B hand-tuned thresholds don't spend Ville budget
    reason_code: fired.id,
    gate,
    label: fired.label,
    provenance,
    // Keep the provenance variable from being flagged as unused when
    // consumers stop reading it. No-op.
    ...(prov ? {} : {}),
  };
}

const emptyFamilyVerdict = (): FamilyVerdictV2 => ({
  verdict: 'clean', detectors: [], alpha_spent: 0, suppression_reason: null,
});

// Map a suppressed DetectorVerdict.reason_code to the family-level
// suppression_reason vocabulary per audit/SCHEMA.md v2. W5 §S6 adds the
// two Addition-#8 codes; Addition #13 adds 'ignore_threshold';
// everything else is bake_profile.
function mapSuppression(codes: string[]): FamilyVerdictV2['suppression_reason'] {
  if (codes.indexOf('observability_stack_deploy') >= 0) return 'observability_stack_deploy';
  if (codes.indexOf('schema_continuity_breaking') >= 0) return 'schema_continuity_breaking';
  if (codes.indexOf('expected_failure_pattern') >= 0) return 'expected_failure_pattern';
  if (codes.indexOf('ignore_threshold') >= 0) return 'ignore_threshold';
  return 'bake_profile';
}

/** C64 (a): a valid-path verdict is told apart by its reason_code, since the per-signal
 *  Family A array carries the plug-ins and the terminal e-value alike. */
function familyARollbackId(v: DetectorVerdict): string {
  return (v.reason_code.startsWith('safe_t_') ? 'family_A_safe_t_' : 'family_A_') + v.signal;
}

// Family A — per-signal shadow verdicts.
function evalFamilyA(params: OrchestrateParams, hr: HealthResult, fa: FamilyVerdictV2): void {
  if (!hr.family_A_shadow || hr.family_A_shadow.length === 0) return;
  let anyFire = false, anyIndet = false, allSuppressed = true, anyEvaluated = false;
  let alphaSum = 0;
  const suppressCodes: string[] = [];
  for (const v of hr.family_A_shadow) {
    anyEvaluated = true;
    if (v.verdict !== 'suppressed') allSuppressed = false;
    else suppressCodes.push(v.reason_code);
    if (v.verdict === 'fire' && v.signal) {
      anyFire = true;
      const rid = resolveDetectorId(familyARollbackId(v));
      if (rid) {
        fa.detectors.push(tripFromVerdict(params, rid, v, 'Family A ' + v.signal, 'health_rollback'));
        alphaSum += v.alpha_spent;
      }
    } else if (v.verdict === 'indeterminate') {
      anyIndet = true;
    }
  }
  if (!anyEvaluated) fa.verdict = 'clean';
  else if (anyFire) fa.verdict = 'fire';
  else if (allSuppressed) { fa.verdict = 'suppressed'; fa.suppression_reason = mapSuppression(suppressCodes); }
  else if (anyIndet) fa.verdict = 'indeterminate';
  else fa.verdict = 'clean';
  fa.alpha_spent = alphaSum;
}

// Family B — structural rule detectors from rollback[] (post-Family-A-promotion).
function evalFamilyB(params: OrchestrateParams, hr: HealthResult, fb: FamilyVerdictV2): void {
  if (hr.rollback.length === 0) return;
  for (const fired of hr.rollback) {
    const rid = resolveDetectorId(fired.id);
    if (!rid || rid.family_id !== 'B') continue;
    const trip = tripFromFamilyB(params, fired, 'health_rollback');
    if (trip) fb.detectors.push(trip);
  }
  if (fb.detectors.length > 0) fb.verdict = 'fire';
}

// Addition #20 (REPLY-43b) — on safe-Hotelling fires, surface the
// cell's shrink_fraction in Provenance so replay consumers can
// reproduce fire timings across different c values.
function familyCShrinkExtras(
  params: OrchestrateParams,
  sig: DetectorId | undefined,
): { family_c_shrink_fraction_used?: number } | undefined {
  if (sig !== 'hotelling_t2_safe' || !params.compiledConfig?.baseline_cells
      || params.currentHourOfDay === undefined) {
    return undefined;
  }
  const matchedCell = findCell(
    params.compiledConfig.baseline_cells.cells,
    params.currentHourOfDay, params.currentDayOfWeek,
  );
  const shrink = matchedCell?.family_C?.safe_hotelling_params?.shrink_fraction
    ?? params.compiledConfig.baseline_cells.aggregate_fallback.family_C?.safe_hotelling_params?.shrink_fraction;
  if (shrink !== undefined) return { family_c_shrink_fraction_used: shrink };
  return undefined;
}

// Family C — per-detector verdict(s). Hotelling T² is primary; Addition
// #18 adds Sequential MMD as a second detector running alongside. Both
// contribute to the family-level verdict; either firing flips the
// family to 'fire' and appends a DetectorTripV2.
function evalFamilyC(params: OrchestrateParams, hr: HealthResult, fc: FamilyVerdictV2): void {
  const familyCVerdicts: Array<{ v: DetectorVerdict; rid: 'family_C' | 'family_C_mmd'; label: string }> = [];
  if (hr.family_C_verdict) {
    familyCVerdicts.push({
      v: hr.family_C_verdict, rid: 'family_C', label: 'Family C (multivariate)',
    });
  }
  if (hr.family_C_mmd_verdict) {
    familyCVerdicts.push({
      v: hr.family_C_mmd_verdict, rid: 'family_C_mmd', label: 'Family C (Sequential MMD)',
    });
  }
  if (familyCVerdicts.length === 0) return;
  let anyFire = false;
  let anySuppressed = false, allSuppressed = true;
  let anyIndet = false;
  let alphaSum = 0;
  const suppressCodes: string[] = [];
  for (const { v, rid, label } of familyCVerdicts) {
    if (v.verdict === 'fire') {
      anyFire = true;
      allSuppressed = false;
      const rr = resolveDetectorId(rid)!;
      // Addition #20 — variant-aware detector_id. When the verdict carries
      // a Family-C-registered signal (`hotelling_t2_safe` /
      // `sequential_mmd_e_process` / `sequential_mmd_betting_e_process`),
      // use it as detector_id instead of the default chi_square /
      // legacy-mmd mapping. Preserves audit distinction between
      // chi_square/legacy-mmd and the safe_test / e-process variants.
      // `sequential_mmd_betting_e_process` registration closed a gap: the
      // Q67 v2 canonical evaluator's own signal id used to be absent from
      // DETECTOR_REGISTRY.C, so this membership check fell through to
      // `rr` (the legacy `sequential_mmd` id) for its fires — see
      // engine/guarantees.ts sequential_mmd.id_mapping_note.
      const sig = v.signal as DetectorId | undefined;
      const ridResolved = (sig && (DETECTOR_REGISTRY.C as readonly string[]).indexOf(sig) >= 0)
        ? { family_id: 'C' as const, detector_id: sig }
        : rr;
      const provExtras = familyCShrinkExtras(params, sig);
      fc.detectors.push(tripFromVerdict(params, ridResolved, v, label, 'health_rollback', provExtras));
      alphaSum += v.alpha_spent;
    } else if (v.verdict === 'suppressed') {
      anySuppressed = true;
      suppressCodes.push(v.reason_code);
    } else if (v.verdict === 'indeterminate') {
      anyIndet = true;
      allSuppressed = false;
    } else {
      allSuppressed = false;  // 'clean'
    }
  }
  if (anyFire) fc.verdict = 'fire';
  else if (allSuppressed && anySuppressed) {
    fc.verdict = 'suppressed';
    fc.suppression_reason = mapSuppression(suppressCodes);
  } else if (anyIndet) fc.verdict = 'indeterminate';
  fc.alpha_spent = alphaSum;
}

// Family D — per-signal array (kv_cache in W4 registry).
function evalFamilyD(params: OrchestrateParams, hr: HealthResult, fd: FamilyVerdictV2): void {
  if (!hr.family_D_shadow || hr.family_D_shadow.length === 0) return;
  let anyFire = false, anySuppressed = false, allSuppressed = true;
  let alphaSum = 0;
  const suppressCodes: string[] = [];
  for (const v of hr.family_D_shadow) {
    if (v.verdict !== 'suppressed') allSuppressed = false;
    else suppressCodes.push(v.reason_code);
    if (v.verdict === 'fire' && v.signal) {
      anyFire = true;
      const rid = resolveDetectorId('family_D_' + v.signal);
      if (rid) {
        // Addition #21 — variant-aware detector_id projection. When the
        // e-detector fired (reason_code matches its wealth-exceeded
        // code), override the default `spectral_peak_acf_*` id with
        // `spectral_e_detector_*` so audit records distinguish the
        // two variants. Bootstrap-null reason codes include
        // `spectral_peak_at_lag_*` per evaluateFamilyD legacy path.
        let ridResolved = rid;
        if (v.reason_code === 'spectral_e_detector_wealth_exceeded') {
          const did = ('spectral_e_detector_' + v.signal) as DetectorId;
          if ((DETECTOR_REGISTRY.D as readonly string[]).indexOf(did) >= 0) {
            ridResolved = { family_id: 'D' as const, detector_id: did };
          }
        }
        fd.detectors.push(tripFromVerdict(params, ridResolved, v, 'Family D ' + v.signal, 'health_rollback'));
        alphaSum += v.alpha_spent;
      }
    } else if (v.verdict === 'suppressed') anySuppressed = true;
  }
  if (anyFire) fd.verdict = 'fire';
  else if (allSuppressed && anySuppressed) { fd.verdict = 'suppressed'; fd.suppression_reason = mapSuppression(suppressCodes); }
  fd.alpha_spent = alphaSum;
}

// Family E — single conformal verdict.
function evalFamilyE(params: OrchestrateParams, hr: HealthResult, fe: FamilyVerdictV2): void {
  if (!hr.family_E_verdict) return;
  const v = hr.family_E_verdict;
  if (v.verdict === 'fire') {
    const rid = resolveDetectorId('family_E')!;
    fe.detectors.push(tripFromVerdict(params, rid, v, 'Family E (novelty)', 'health_rollback'));
    fe.verdict = 'fire';
    fe.alpha_spent = v.alpha_spent;
  } else if (v.verdict === 'suppressed') {
    fe.verdict = 'suppressed';
    fe.suppression_reason = mapSuppression([v.reason_code]);
  } else if (v.verdict === 'indeterminate') {
    fe.verdict = 'indeterminate';
  }
}

export function buildFamilyVerdictsV2(
  params: OrchestrateParams,
  result: VerdictResult,
  hr: HealthResult | null,
): Record<FamilyId, FamilyVerdictV2> {
  const out: Record<FamilyId, FamilyVerdictV2> = {
    A: emptyFamilyVerdict(), B: emptyFamilyVerdict(), C: emptyFamilyVerdict(),
    D: emptyFamilyVerdict(), E: emptyFamilyVerdict(),
  };
  if (!hr) return out;
  evalFamilyA(params, hr, out.A);
  evalFamilyB(params, hr, out.B);
  evalFamilyC(params, hr, out.C);
  evalFamilyD(params, hr, out.D);
  evalFamilyE(params, hr, out.E);
  return out;
}

/** Flattened `tripped[]` projection for v2 records — family-then-detector
 *  ordered, uses canonical detector_id as the v1-compat `id` field. */
export function buildFlatTripped(families: Record<FamilyId, FamilyVerdictV2>): TrippedEntry[] {
  const out: TrippedEntry[] = [];
  const order: FamilyId[] = ['A', 'B', 'C', 'D', 'E'];
  for (const fam of order) {
    const fv = families[fam];
    for (const t of fv.detectors) {
      out.push({ id: t.detector_id, label: t.label, gate: t.gate });
    }
  }
  return out;
}
