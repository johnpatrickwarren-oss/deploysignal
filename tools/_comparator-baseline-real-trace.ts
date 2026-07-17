// tools/_comparator-baseline-real-trace.ts — WS6.2 follow-up (deferred
// Task 8 scope, per ENDPOINTS.md Open Question 4): v8/v9 real-trace
// healthy-FP-only secondary rows.
//
// Methodology (documented here + echoed into the emitted report, per the
// follow-up brief): the "well-tuned" comparator parameters are NOT
// re-tuned per real-trace substrate. They are REUSED, verbatim, from the
// already-committed, pre-registered primary run
// (`runs/comparator-baseline/report-synthetic-v1.json`'s `tuning.threshold
// .params` / `tuning.canary.params`) — the same tuned gates the primary
// report scores, now measured for false-rollback rate against real-trace
// healthy traffic instead of the synthetic tuning/eval split. This is the
// methodologically load-bearing choice for "secondary healthy-FP rows":
// re-tuning per substrate would answer a different question ("how well
// CAN a threshold/canary gate be tuned against this substrate's own
// noise floor") than the one these rows are meant to answer ("how does
// the SAME already-tuned gate the primary report evaluated behave against
// real, out-of-distribution healthy traffic").
//
// A tuned param set built against the synthetic substrate's compiled
// config is not directly portable to a real-trace substrate's compiled
// config: `threshold_tuned`'s per-signal k values only make sense for
// signals the TARGET substrate's own compiled config can resolve a
// {mu, sigma} for (see `resolveMeanSigma` in
// _comparator-baseline-threshold.ts — an unresolvable signal throws, it
// does not silently no-op). `restrictTunedThresholdForSubstrate` /
// `restrictCanaryForSubstrate` below narrow the reused params to each
// substrate's own resolvable/populated signal set (never touching the k
// values, alpha, W, or m themselves — only which signals they apply to),
// and report exactly which signals were dropped so the coverage gap is
// visible rather than silently absorbed.
//
// Per the binding "never bend the window-generation machinery" constraint
// (ENDPOINTS.md Open Question 4's adopted default): this module calls
// `buildWindowPlan` / `materializeWindow` / `runArmsOverWindow` from
// _comparator-baseline-driver.ts completely unmodified, with
// `tuning_windows: 0` and `profiles: []` so only the frozen 131-window,
// seed-42, iid_bootstrap eval-healthy split is generated — exactly the
// same generator/cell-sampling loop the primary run's `false_rollbacks`
// endpoint uses, just re-run against each real-trace substrate's own
// baseline bundle.

import type {
  Baseline,
  CompiledConfig,
  EndpointsSpec,
} from './_comparator-baseline-types';
import {
  buildWindowPlan,
  materializeWindow,
  runArmsOverWindow,
  buildDefaultArmsConfig,
  type TunedArmsConfig,
} from './_comparator-baseline-driver';
import { signalsWithFamilyACalibration, type ThresholdParams } from './_comparator-baseline-threshold';
import type { CanaryParams } from './_comparator-baseline-canary';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cellModule = require('./_build-report-card-cell') as {
  listPopulatedCells: (baseline: Baseline, minSamples: number) => Array<{ hour_of_day: number; day_of_week: number; n_samples: number }>;
  collectCellRows: (baseline: Baseline, hourOfDay: number, dayOfWeek: number) => Record<string, number>[];
};

/** The four v8/v9 real-trace substrates named in Open Question 4. Paths
 *  are repo-root-relative, resolved by the CLI caller. */
export interface RealTraceSubstrate {
  id: string;
  baselineDir: string;
  compiledConfigPath: string;
}

export const REAL_TRACE_SUBSTRATES: RealTraceSubstrate[] = [
  { id: 'real-burstgpt-v1', baselineDir: 'runs/baselines/real-burstgpt-v1', compiledConfigPath: 'runs/compiled-configs/v8a-real-burstgpt-v1.json' },
  { id: 'real-azure-llm-inference-v1', baselineDir: 'runs/baselines/real-azure-llm-inference-v1', compiledConfigPath: 'runs/compiled-configs/v8b-real-azure-llm-inference-v1.json' },
  { id: 'real-mooncake-v1', baselineDir: 'runs/baselines/real-mooncake-v1', compiledConfigPath: 'runs/compiled-configs/v8c-real-mooncake-v1.json' },
  { id: 'real-huggingface-lmsys-arena-v1', baselineDir: 'runs/baselines/real-huggingface-lmsys-arena-v1', compiledConfigPath: 'runs/compiled-configs/v9a-real-huggingface-lmsys-arena-v1.json' },
];

/** The arm roster this secondary study reports — exactly the frozen
 *  ENDPOINTS.md `arms` list (all six), so the real-trace rows stay
 *  comparable arm-for-arm against the primary report. */
export const REAL_TRACE_ARM_IDS = [
  'portfolio_alpha',
  'portfolio_combined',
  'threshold_tuned',
  'canary_tuned',
  'combined_tuned',
  'combined_default',
] as const;

// ── OQ-4 feasibility gate ───────────────────────────────────────────────

export interface SubstrateFeasibility {
  feasible: boolean;
  reason?: string;
  populatedCells: number;
}

/** ENDPOINTS.md Open Question 4's adopted-default gate, applied verbatim
 *  as its literal text — (a) at least one run in the baseline bundle
 *  carries non-empty per-tick `hour_of_day`/`day_of_week` arrays, AND (b)
 *  `listPopulatedCells(baseline, 20)` (the SAME helper + SAME minSamples
 *  the frozen eval-healthy split's `buildWindowPlan` already calls)
 *  returns a non-empty cell list — PLUS one further precondition the
 *  literal OQ-4 text doesn't name but the frozen generator itself
 *  requires and cannot tolerate being modified for: `bootstrapHealthyWindow`
 *  samples from `collectCellRows`, which only counts a tick as a usable
 *  row when EVERY `baseline.manifest.signals` entry is defined for it
 *  (`_build-report-card-cell.js`'s `collectCellRows`, unmodified). A
 *  bundle can satisfy (a)+(b) — `listPopulatedCells` only checks
 *  hour/day presence, not per-signal completeness — while every one of
 *  its "populated" cells has zero rows with full signal coverage, in
 *  which case `bootstrapHealthyWindow` throws unconditionally for every
 *  window draw (verified empirically for all four v8/v9 bundles: each
 *  carries real per-tick data for only 1-3 of the 15 manifest signals,
 *  the rest undefined at every tick — so `collectCellRows` returns zero
 *  rows for every cell in every bundle). Rather than let that surface as
 *  an uncaught crash mid-run — or, worse, "fix" it by loosening
 *  `collectCellRows`'s completeness requirement (bending the shared
 *  window machinery, explicitly out of scope) — this probes the SAME
 *  helper the generator itself calls and folds a real generation failure
 *  into the same skip path as an OQ-4 gate failure, with a distinct
 *  reason string so the two failure modes stay auditable apart. */
export function checkSubstrateFeasibility(baseline: Baseline, minSamples = 20): SubstrateFeasibility {
  const hasPerTickHourDay = baseline.runs.some(
    (r) => Array.isArray(r.hour_of_day) && Array.isArray(r.day_of_week) && r.hour_of_day.length > 0 && r.day_of_week.length > 0,
  );
  if (!hasPerTickHourDay) {
    return { feasible: false, reason: 'no run in the baseline bundle carries non-empty per-tick hour_of_day/day_of_week arrays', populatedCells: 0 };
  }
  const cells = cellModule.listPopulatedCells(baseline, minSamples);
  if (cells.length === 0) {
    return { feasible: false, reason: `listPopulatedCells(baseline, ${minSamples}) returned 0 populated cells`, populatedCells: 0 };
  }
  const hasCompleteRowSomewhere = cells.some(
    (c) => cellModule.collectCellRows(baseline, c.hour_of_day, c.day_of_week).length > 0,
  );
  if (!hasCompleteRowSomewhere) {
    return {
      feasible: false,
      reason: `OQ-4 listPopulatedCells(baseline, ${minSamples}) gate passed (${cells.length} populated cells), but every ` +
        'cell has zero rows with ALL baseline.manifest.signals defined — collectCellRows (the frozen bootstrapHealthyWindow ' +
        'dependency) cannot resolve a single row anywhere in this bundle, so the frozen window generator would throw ' +
        'unconditionally on every draw. This bundle likely carries real per-tick data for only a subset of the manifest\'s ' +
        'signals (the rest undefined at every tick) rather than full per-tick coverage.',
      populatedCells: cells.length,
    };
  }
  return { feasible: true, populatedCells: cells.length };
}

// ── Reused-tuned-param restriction (per substrate) ──────────────────────

export interface RestrictedThreshold {
  params: ThresholdParams;
  usableSignals: string[];
  droppedSignals: string[];
}

/** Narrow a reused (primary-run) `threshold_tuned` param set to the
 *  signals THIS substrate's own compiled config can resolve a family_A
 *  {mu, sigma} for — reusing `signalsWithFamilyACalibration` unmodified
 *  (the same guard the primary harness already uses for its untuned
 *  default arm). k values, m, and the direction table are carried through
 *  unchanged for the signals that survive; nothing is re-tuned. */
export function restrictTunedThresholdForSubstrate(
  tuned: ThresholdParams,
  compiledConfig: CompiledConfig,
): RestrictedThreshold {
  const originalSignals = Object.keys(tuned.kPerSignal);
  const usableSignals = signalsWithFamilyACalibration(compiledConfig, originalSignals);
  const usableSet = new Set(usableSignals);
  const kPerSignal: Record<string, number> = {};
  for (const s of usableSignals) kPerSignal[s] = tuned.kPerSignal[s];
  const droppedSignals = originalSignals.filter((s) => !usableSet.has(s));
  return {
    params: { kPerSignal, consecutiveTicks: tuned.consecutiveTicks, directions: tuned.directions },
    usableSignals,
    droppedSignals,
  };
}

export interface RestrictedCanary {
  params: CanaryParams;
  usableSignals: string[];
  droppedSignals: string[];
  skipped: boolean;
}

/** Narrow a reused (primary-run) `canary_tuned` param set to the signals
 *  actually present in THIS substrate's baseline manifest (the canary arm
 *  needs raw signal series, not calibration, so manifest presence — not
 *  family_A coverage — is the relevant guard). `skipped` is true when zero
 *  signals survive: per the follow-up brief, the canary arm is then
 *  omitted for that substrate rather than reported as a vacuous 0% row
 *  (a threshold arm with zero signals is honestly "never fires"; a canary
 *  arm with zero signals has nothing to even attempt a comparison on). */
export function restrictCanaryForSubstrate(tuned: CanaryParams, baseline: Baseline): RestrictedCanary {
  const manifestSignals = new Set(baseline.manifest.signals);
  const usableSignals = tuned.signals.filter((s) => manifestSignals.has(s));
  const droppedSignals = tuned.signals.filter((s) => !manifestSignals.has(s));
  return {
    params: { ...tuned, signals: usableSignals },
    usableSignals,
    droppedSignals,
    skipped: usableSignals.length === 0,
  };
}

// ── Per-substrate healthy-FP evaluation ─────────────────────────────────

export interface RealTraceArmResult {
  false_rollbacks: { count: number; total: number; rate: number };
  usable_signals?: string[];
  dropped_signals?: string[];
  skipped?: true;
  skip_reason?: string;
}

export interface RealTraceSubstrateResult {
  id: string;
  populated_cells: number;
  window_count: number;
  arms: Record<string, RealTraceArmResult>;
}

export type SubstrateEvalOutcome =
  | { skipped: true; id: string; reason: string }
  | ({ skipped: false } & RealTraceSubstrateResult);

function buildTunedArmsConfigForSubstrate(
  spec: EndpointsSpec,
  compiledConfig: CompiledConfig,
  baseline: Baseline,
  tunedThreshold: ThresholdParams,
  tunedCanary: CanaryParams,
): { tunedArmsConfig: TunedArmsConfig; restrictedThreshold: RestrictedThreshold; restrictedCanary: RestrictedCanary } {
  const restrictedThreshold = restrictTunedThresholdForSubstrate(tunedThreshold, compiledConfig);
  const restrictedCanary = restrictCanaryForSubstrate(tunedCanary, baseline);
  const defaultArms = buildDefaultArmsConfig(spec, compiledConfig);
  return {
    tunedArmsConfig: {
      threshold: restrictedThreshold.params,
      canary: restrictedCanary.params,
      thresholdDefault: defaultArms.threshold,
      canaryDefault: defaultArms.canary,
    },
    restrictedThreshold,
    restrictedCanary,
  };
}

function countFalseFiresPerArm(
  healthyEntries: ReturnType<typeof buildWindowPlan>,
  baseline: Baseline,
  compiledConfig: CompiledConfig,
  tunedArmsConfig: TunedArmsConfig,
  spec: EndpointsSpec,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const armId of REAL_TRACE_ARM_IDS) counts[armId] = 0;
  for (const entry of healthyEntries) {
    const materialized = materializeWindow(entry, baseline, compiledConfig);
    const results = runArmsOverWindow(materialized, tunedArmsConfig, compiledConfig, spec);
    for (const armId of REAL_TRACE_ARM_IDS) {
      const r = results[armId];
      if (r && r.firstFireTick !== null) counts[armId]++;
    }
  }
  return counts;
}

/** Evaluate one real-trace substrate's healthy-FP-only secondary row set:
 *  (1) apply the OQ-4 feasibility gate — skip (with reason) rather than
 *  bend the window machinery if it fails; (2) generate the frozen
 *  131-window, seed-42, iid_bootstrap eval-healthy split via the
 *  UNMODIFIED `buildWindowPlan` (tuning_windows forced to 0, no
 *  regression profiles — this study never injects); (3) run every
 *  registered arm over every window using the primary run's tuned
 *  threshold/canary params, restricted to this substrate's own
 *  resolvable/populated signal set; (4) reduce to per-arm false-rollback
 *  count/total/rate — no escape/delay metrics, since nothing is injected. */
export function evaluateSubstrateHealthyFp(
  substrateId: string,
  baseline: Baseline,
  compiledConfig: CompiledConfig,
  spec: EndpointsSpec,
  tunedThreshold: ThresholdParams,
  tunedCanary: CanaryParams,
): SubstrateEvalOutcome {
  const feasibility = checkSubstrateFeasibility(baseline);
  if (!feasibility.feasible) {
    return { skipped: true, id: substrateId, reason: feasibility.reason! };
  }

  const endpointsForSubstrate: EndpointsSpec = {
    ...spec,
    frozen_params: { ...spec.frozen_params, tuning_windows: 0 },
  };
  const plan = buildWindowPlan(baseline, endpointsForSubstrate, []);
  const healthyEntries = plan.filter((e) => e.provenance.split === 'eval_healthy');

  const { tunedArmsConfig, restrictedThreshold, restrictedCanary } =
    buildTunedArmsConfigForSubstrate(spec, compiledConfig, baseline, tunedThreshold, tunedCanary);

  const falseFireCounts = countFalseFiresPerArm(healthyEntries, baseline, compiledConfig, tunedArmsConfig, spec);

  const total = healthyEntries.length;
  const arms: Record<string, RealTraceArmResult> = {};
  for (const armId of REAL_TRACE_ARM_IDS) {
    const count = falseFireCounts[armId];
    arms[armId] = { false_rollbacks: { count, total, rate: total > 0 ? count / total : 0 } };
  }
  arms.threshold_tuned.usable_signals = restrictedThreshold.usableSignals;
  arms.threshold_tuned.dropped_signals = restrictedThreshold.droppedSignals;
  arms.canary_tuned.usable_signals = restrictedCanary.usableSignals;
  arms.canary_tuned.dropped_signals = restrictedCanary.droppedSignals;
  if (restrictedCanary.skipped) {
    arms.canary_tuned.skipped = true;
    arms.canary_tuned.skip_reason = 'no overlap between the reused tuned canary signal set and this substrate\'s baseline manifest';
  }

  return {
    skipped: false,
    id: substrateId,
    populated_cells: feasibility.populatedCells,
    window_count: total,
    arms,
  };
}
