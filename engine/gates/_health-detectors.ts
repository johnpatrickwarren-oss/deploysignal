// engine/gates/_health-detectors.ts — Family A/C/D/E detector dispatch for G1.
//
// Extracted verbatim from evaluateHealth's per-family blocks. Each family
// runner mutates the shared HealthResult + rollback array in place,
// preserving the original cascade order and silent-shadow error posture.

import { evaluateFamilyA } from '../detectors/page-cusum';
import { evaluateFamilyABettingShadow, getOrCreateBetting } from '../detectors/betting-e-process';
import { evaluateFamilyC } from '../detectors/hotelling';
import { evaluateFamilyE, freshConformalEValueState } from '../detectors/conformal';
import { evaluateFamilyD, FAMILY_D_SIGNALS, freshSpectralEDetectorState } from '../detectors/spectral';
import { evaluateEMmd } from '../detectors/sequential-mmd';
import { evaluateFamilyCBettingEProcess } from '../detectors/family-c-betting-e-process';
import { shouldSuppress } from '../l0/schema-continuity';
import type {
  Metrics, FiredSignal, HealthResult,
  TrendBufferI, DetectorVerdict,
  SafeHotellingState, ConformalEValueState,
} from '../types';
import type { HealthOpts } from './_health-types';

/** Per-family detector context shared by the Family A/C/D/E dispatch
 *  blocks. Built once per runner from `opts` + `liveMetrics`. */
function detectorCtx(liveMetrics: Metrics, opts: HealthOpts) {
  return {
    hourOfDay:         opts.currentHourOfDay ?? new Date().getHours(),
    dayOfWeek:         opts.currentDayOfWeek,
    ticksSinceDeploy:  opts.ticksSinceDeploy ?? 0,
    deployAgeDays:     opts.deployAgeDays ?? 0,
    trafficPct:        (liveMetrics.traffic_pct as number) ?? 1.0,
    schemaContinuityClass: opts.schemaContinuityClass,
    tenantId:          opts.tenantId,
  };
}

/** Family A Page-CUSUM dispatch + promotion (silent-shadow). */
function runFamilyACusum(
  result: HealthResult, rollbackFired: FiredSignal[], sup: string[],
  liveMetrics: Metrics, tb: TrendBufferI, opts: HealthOpts,
): void {
  try {
    // Q66 Phase-3.d.A close (item g) — dispatch wrapper reads
    // cfg.page_cusum_variant (default 'mixture_supermartingale') and
    // delegates to either the Howard-Ramdas-2021 Ville-bounded path
    // (default) or the classical reset-at-zero path (with deprecation
    // warning; retires at Phase-3.d.C). Both state maps threaded; the
    // unused one stays empty across the deploy lifetime.
    if (!tb.mixtureSupermartingaleStates) tb.mixtureSupermartingaleStates = {};
    const shadow: DetectorVerdict[] = evaluateFamilyA(
      opts.compiledConfig!,
      liveMetrics,
      tb.cusumStates,
      tb.mixtureSupermartingaleStates,
      {
        ...detectorCtx(liveMetrics, opts),
        ignoredSignals:    opts.ignoredSignals,
      },
    );
    result.family_A_shadow = shadow;
    // Promote Page-CUSUM fires to primary rollback entries. Provenance
    // (S_n, threshold, α) lives in `family_A_shadow` — the rollback
    // array carries the minimum v1-schema-compatible surface.
    for (const v of shadow) {
      if (v.verdict !== 'fire' || !v.signal) continue;
      const id = 'family_A_' + v.signal;
      if (sup.indexOf(id) >= 0) continue;  // warmup-suppressed per convention
      rollbackFired.push({ id, label: 'Family A ' + v.signal });
    }
  } catch (_e) {
    // Shadow-mode errors are silent by design. The Week 4 audit schema
    // bump introduces a dedicated error channel.
  }
}

/** Family A betting e-process co-shipped shadow (Addition #17). */
function runFamilyABetting(
  result: HealthResult, rollbackFired: FiredSignal[], sup: string[],
  liveMetrics: Metrics, tb: TrendBufferI, opts: HealthOpts,
): void {
  // Addition #17 (ARCHITECT-REPLY-34) — co-shipped betting e-process
  // shadow. Runs alongside Page-CUSUM on the same cell params under a
  // 50/50 α-split of the per-signal Bonferroni budget. Both detectors
  // emit independent per-signal verdicts; fires promote to
  // `family_A_betting_{signal}` rollback entries so audit records
  // distinguish them from Page-CUSUM fires.
  try {
    if (!tb.bettingStates) tb.bettingStates = {};
    const bettingShadow: DetectorVerdict[] = evaluateFamilyABettingShadow(
      opts.compiledConfig!,
      liveMetrics,
      tb.bettingStates,
      {
        ...detectorCtx(liveMetrics, opts),
        ignoredSignals:    opts.ignoredSignals,
      },
    );
    if (bettingShadow.length > 0) {
      // Extend the existing family_A_shadow array so audit consumers
      // see one contiguous Family A block; fires get a distinct
      // rollback id via the 'family_A_betting_' prefix.
      result.family_A_shadow = (result.family_A_shadow ?? []).concat(bettingShadow);
      for (const v of bettingShadow) {
        if (v.verdict !== 'fire' || !v.signal) continue;
        const id = 'family_A_betting_' + v.signal;
        if (sup.indexOf(id) >= 0) continue;
        rollbackFired.push({ id, label: 'Family A betting ' + v.signal });
      }
    }
    // Touch getOrCreateBetting so the re-export binds at runtime
    // even when FAMILY_A_PRIMARY_SIGNALS emits zero ticks (defensive
    // against tree-shakers — shim is also consumed inside the detector).
    void getOrCreateBetting;
  } catch (_e) {
    // Mirror the Page-CUSUM silent-shadow posture; a betting crash
    // must not fail the primary gate.
  }
}

/** Family A (Page-CUSUM + betting + legacy-shadow promotion). */
export function runFamilyA(
  result: HealthResult, rollbackFired: FiredSignal[], legacyShadow: FiredSignal[],
  sup: string[], liveMetrics: Metrics, tb: TrendBufferI, opts: HealthOpts,
): void {
  runFamilyACusum(result, rollbackFired, sup, liveMetrics, tb, opts);
  runFamilyABetting(result, rollbackFired, sup, liveMetrics, tb, opts);
  if (legacyShadow.length > 0) result.family_A_legacy_shadow = legacyShadow;
}

/** Family C Hotelling T² dispatch (safe-Hotelling state threaded). */
function runFamilyCHotelling(
  result: HealthResult, rollbackFired: FiredSignal[], sup: string[],
  liveMetrics: Metrics, tb: TrendBufferI | null, opts: HealthOpts,
): void {
  // Addition #20 — safe-Hotelling dispatch threads a per-(deploy, cell)
  // state store through evaluateFamilyC. Legacy chi_square cells ignore
  // the store (stateless); safe_test cells lazy-allocate wealth state
  // keyed by `__sh_<tier>_<h>_<d>`. Pre-#20 TrendBuffers without
  // `safeHotellingStates` degrade gracefully via the `??= {}`.
  const shStates: Record<string, SafeHotellingState> | undefined = tb
    ? (tb.safeHotellingStates ??= {})
    : undefined;
  try {
    const v = evaluateFamilyC(opts.compiledConfig!, liveMetrics, detectorCtx(liveMetrics, opts), shStates);
    if (v) {
      result.family_C_verdict = v;
      if (v.verdict === 'fire' && sup.indexOf('family_C') < 0) {
        rollbackFired.push({ id: 'family_C', label: 'Family C (multivariate)' });
      }
    }
  } catch (_e) {
    // Silent — see Family A comment above.
  }
}

/** Family C e-MMD (Option-B betting e-process, Addition #20). */
function runFamilyCEMmd(
  result: HealthResult, rollbackFired: FiredSignal[], sup: string[],
  liveMetrics: Metrics, tb: TrendBufferI, opts: HealthOpts,
): void {
  // Addition #20 — e-MMD (betting e-process) parallel call. Self-
  // gates on `e_mmd_params` presence (absent → pre-#20 cell or
  // bootstrap-null variant cell; evaluateEMmd returns null). Also
  // self-gates when Q67 v2 `betting_e_process_params` are populated
  // (Q67 v2 supersedes Option-B per § Q67.5).
  // Emits its own detector_id via verdict.signal='sequential_mmd_e_process'
  // so audit can distinguish from the bootstrap-null path.
  try {
    const eStates = (tb.eMmdStates ??= {}) as Record<string, unknown>;
    const emmd = evaluateEMmd(opts.compiledConfig!, liveMetrics, eStates, detectorCtx(liveMetrics, opts));
    if (emmd) {
      // Reuse family_C_mmd_verdict slot since bootstrap_null and
      // betting_e_process are mutually exclusive per cell.variant.
      result.family_C_mmd_verdict = emmd;
      if (emmd.verdict === 'fire' && sup.indexOf('family_C_mmd') < 0) {
        rollbackFired.push({ id: 'family_C_mmd', label: 'Family C (e-MMD)' });
      }
    }
  } catch (_e) { /* silent */ }
}

/** Family C canonical betting-e-process (Q67 v2 Shekhar-Ramdas-2023). */
function runFamilyCBetting(
  result: HealthResult, rollbackFired: FiredSignal[], sup: string[],
  liveMetrics: Metrics, tb: TrendBufferI, opts: HealthOpts,
): void {
  // Q67 SPEC § Q67.2 — canonical Shekhar-Ramdas-2023 betting-e-process
  // parallel call. Self-gates on `mmd_variant === 'betting_e_process'`
  // AND `betting_e_process_params` populated (Q67 v2 compile output);
  // returns null on pre-Q67 cells, letting the parallel evaluateEMmd
  // and evaluateSequentialMMD calls cover those variants. Emits its
  // own detector_id via verdict.signal='sequential_mmd_betting_e_process'
  // so audit distinguishes Q67 v2 from Option-B and bootstrap-null.
  try {
    const fcbStates = (tb.familyCBettingStates ??= {}) as Record<string, unknown>;
    const fcb = evaluateFamilyCBettingEProcess(
      opts.compiledConfig!, liveMetrics, fcbStates, detectorCtx(liveMetrics, opts));
    if (fcb) {
      // Reuse family_C_mmd_verdict slot — Q67 v2, Option-B, and
      // bootstrap-null are mutually exclusive per cell.variant +
      // cell-params layout (supersession guards in evaluateEMmd +
      // evaluateSequentialMMD enforce single-route).
      result.family_C_mmd_verdict = fcb;
      if (fcb.verdict === 'fire' && sup.indexOf('family_C_mmd') < 0) {
        rollbackFired.push({ id: 'family_C_mmd', label: 'Family C (canonical betting-e-process)' });
      }
    }
  } catch (_e) { /* silent */ }
}

/** Family C (Hotelling T²) — W3 addition. End of the cascade; any fire
 *  adds a `family_C` rollback entry. Stateless (per-tick test); error
 *  swallowing identical to Family A. */
export function runFamilyC(
  result: HealthResult, rollbackFired: FiredSignal[], sup: string[],
  liveMetrics: Metrics, tb: TrendBufferI | null, opts: HealthOpts,
): void {
  runFamilyCHotelling(result, rollbackFired, sup, liveMetrics, tb, opts);
  // Q68 Phase-3.d.C consolidation — classical Sequential MMD (Addition
  // #18 bootstrap-null) retired. Family C MMD dispatch routes solely
  // through Q67 v2 canonical betting-e-process variant
  // (`evaluateFamilyCBettingEProcess`) + Option-B Addition #20
  // (`evaluateEMmd`) for backward-compat with pre-Q67 cells lacking
  // betting_e_process_params (Option-B is Ville-bounded by construction;
  // preserved at Q68 .C scope).
  if (tb) {
    runFamilyCEMmd(result, rollbackFired, sup, liveMetrics, tb, opts);
    runFamilyCBetting(result, rollbackFired, sup, liveMetrics, tb, opts);
  }
}

/** Family D (ACF oscillation) — W4 addition. Per-signal; consumes the
 *  TrendBuffer's long view (default 30 samples). Fires push
 *  `family_D_${signal}` into rollback. Silent error swallow per Family A. */
export function runFamilyD(
  result: HealthResult, rollbackFired: FiredSignal[], sup: string[],
  liveMetrics: Metrics, tb: TrendBufferI, opts: HealthOpts,
): void {
  try {
    const out: DetectorVerdict[] = [];
    // W5 §S6: schema-continuity suppression must fire before the
    // window-fill gate below. Otherwise 'breaking' runs with an
    // underfilled buffer would produce family.D.verdict === 'clean'
    // instead of 'suppressed', contradicting Addition #8.
    const klass = opts.schemaContinuityClass;
    if (klass && shouldSuppress(klass, 'D')) {
      const reason = klass === 'observability_stack'
        ? 'observability_stack_deploy' : 'schema_continuity_breaking';
      for (const sig of FAMILY_D_SIGNALS) {
        out.push({
          verdict: 'suppressed', statistic: null, threshold: null,
          alpha_consumed: 0, alpha_spent: 0,
          reason_code: reason, family: 'D', signal: sig,
        });
      }
    } else {
      // Addition #21 — lazy-allocate spectral-e-detector state store
      // per-(deploy, signal). Each signal owns its own wealth martingale;
      // legacy bootstrap-null path ignores the state (stateless). Pre-#21
      // TrendBuffers without `spectralEDetectorStates` degrade gracefully
      // via the `??= {}` — legacy variant dispatch still works without
      // a state store populated.
      const spectralStates = tb.spectralEDetectorStates ??= {};
      for (const sig of FAMILY_D_SIGNALS) {
        const longView = tb.dataLong[sig];
        if (!longView || longView.length < 20) continue;
        const sigState = spectralStates[sig] ??= freshSpectralEDetectorState();
        const v = evaluateFamilyD(opts.compiledConfig!, sig, longView, {
          hourOfDay:        opts.currentHourOfDay ?? new Date().getHours(),
          dayOfWeek:        opts.currentDayOfWeek,
          ticksSinceDeploy: opts.ticksSinceDeploy ?? 0,
          deployAgeDays:    opts.deployAgeDays    ?? 0,
          trafficPct:       (liveMetrics.traffic_pct as number) ?? 1.0,
          schemaContinuityClass: opts.schemaContinuityClass,
        }, sigState);
        if (v) out.push(v);
      }
    }
    if (out.length > 0) {
      result.family_D_shadow = out;
      for (const v of out) {
        if (v.verdict !== 'fire' || !v.signal) continue;
        const id = 'family_D_' + v.signal;
        if (sup.indexOf(id) >= 0) continue;
        rollbackFired.push({ id, label: 'Family D ' + v.signal });
      }
    }
  } catch (_e) { /* silent */ }
}

/** Family E (conformal novelty) — W4 addition. Single multivariate test;
 *  fires push `family_E` into rollback. */
export function runFamilyE(
  result: HealthResult, rollbackFired: FiredSignal[], sup: string[],
  liveMetrics: Metrics, tb: TrendBufferI | null, opts: HealthOpts,
): void {
  // Addition #22 — lazy-allocate weighted-conformal-e-value state
  // store per-(deploy, cell). Cell-keyed (`e_<tier>_<h>_<d>`) so
  // multi-tenant deployments keep per-cell wealth. Pre-#22
  // TrendBuffers without `conformalEValueStates` degrade gracefully
  // via `??= {}` — legacy unweighted/weighted paths ignore the store.
  const eCellKey = `e_${opts.tenantId ?? 'none'}_${opts.currentHourOfDay ?? 0}_${opts.currentDayOfWeek ?? -1}`;
  const eStates: Record<string, ConformalEValueState> | undefined = tb
    ? (tb.conformalEValueStates ??= {})
    : undefined;
  const eState = eStates
    ? (eStates[eCellKey] ??= freshConformalEValueState())
    : undefined;
  try {
    const v = evaluateFamilyE(opts.compiledConfig!, liveMetrics, detectorCtx(liveMetrics, opts), eState);
    if (v) {
      result.family_E_verdict = v;
      if (v.verdict === 'fire' && sup.indexOf('family_E') < 0) {
        rollbackFired.push({ id: 'family_E', label: 'Family E (novelty)' });
      }
    }
  } catch (_e) { /* silent */ }
}
