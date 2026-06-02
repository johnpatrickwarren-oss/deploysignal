// tools/_run-shadow-compare-orchestrator.ts — the runShadowCompare
// orchestrator, decomposed into <100-line helpers (extracted from
// tools/run-shadow-compare.ts during a behavior-preserving module
// split). Behavior is identical to the pre-split single function.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Q60DetectorFamily } from '../engine/types/config.js';
import {
  DEFAULT_HEALTHY_WINDOWS,
  FAMILY_C_SIGNALS,
  Q60_DETECTOR_FAMILIES,
  type PerProfileReportCard,
  type ShadowCompareOpts,
  type ShadowCompareReport,
  type SubstrateRef,
} from './_run-shadow-compare-types';
import {
  PARAMETRIC_AR1_MODE_DETECTORS,
  isDetectorExercisedAtSubstrate,
  isParametricAr1PassEligible,
  readSubstratePresentSignals,
} from './_run-shadow-compare-exemptions';
import {
  aggregateSeedsToReportCard,
  checkpointPathFor,
  readCheckpoint,
  runProfileValidationSingleSeed,
  writeCheckpoint,
} from './_run-shadow-compare-checkpoints';
import { computeCrossSubstrateDiff } from './_run-shadow-compare-diff';

type ExemptionMap = Partial<Record<Q60DetectorFamily, string>>;

interface SubstrateExemptionPlan {
  exemptionsBySubstrate: Map<string, ExemptionMap>;
  skipParametricAr1BySubstrate: Map<string, boolean>;
}

/** Step 0 — Q60 Phase-3.d.1 (D) per-substrate detector exemption map.
 *  Computed once per substrate at sweep entry; injected into each
 *  (substrate × scenario × seed) checkpoint and used to zero out
 *  exempted detector counts during aggregation.
 *  Phase-3.d.1 L3b β.1 extension: parametric_ar1-mode detectors are
 *  additionally exempted on substrates that can't form the 11-signal
 *  joint cholesky_L vector. The orchestrator passes --skip-parametric-ar1
 *  to build-report-card so it stubs that pass with iid_bootstrap;
 *  orchestrator zeroes the parametric_ar1-mode detectors' counts at
 *  trial completion via the L2 exemption map. */
function computeSubstrateExemptions(opts: ShadowCompareOpts): SubstrateExemptionPlan {
  const exemptionsBySubstrate = new Map<string, ExemptionMap>();
  const skipParametricAr1BySubstrate = new Map<string, boolean>();
  for (const substrate of opts.substrates) {
    const presentSignals = opts.dryRun ? FAMILY_C_SIGNALS : readSubstratePresentSignals(substrate);
    const exemptions: ExemptionMap = {};
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
  return { exemptionsBySubstrate, skipParametricAr1BySubstrate };
}

/** Run a single (substrate × scenario × seed) trial with V2 incremental
 *  emission: write an in_progress checkpoint, execute the trial, zero
 *  out exempted detectors, then write the completed checkpoint. On error
 *  writes a failed checkpoint and rethrows. */
function runSingleTrialWithCheckpoint(
  substrate: SubstrateRef,
  scenario: string,
  seed: number,
  opts: ShadowCompareOpts,
  healthyWindows: number,
  exemptions: ExemptionMap,
  skipParametricAr1: boolean,
): void {
  const checkpointPath = checkpointPathFor(
    opts.outputDir, substrate.name, scenario, seed,
  );
  const existing = readCheckpoint(checkpointPath);
  if (existing?.status === 'completed') return;

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
      skipParametricAr1,
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

/** Step 1 — per-(substrate × scenario × seed) sweep with V2 incremental
 *  emission. Resume semantic: completed checkpoints are skipped;
 *  in-progress / failed / pending checkpoints are re-run. */
function runSweep(opts: ShadowCompareOpts, healthyWindows: number, plan: SubstrateExemptionPlan): void {
  for (const substrate of opts.substrates) {
    const exemptions = plan.exemptionsBySubstrate.get(substrate.name) ?? {};
    const skipParametricAr1 = plan.skipParametricAr1BySubstrate.get(substrate.name) ?? false;
    for (const scenario of opts.scenarios) {
      for (const seed of opts.seeds) {
        runSingleTrialWithCheckpoint(
          substrate, scenario, seed, opts, healthyWindows, exemptions, skipParametricAr1,
        );
      }
    }
  }
}

/** Steps 2-3 — aggregate seed checkpoints into per-profile report cards,
 *  then attach the cross-substrate diff vs the reference substrate. */
function buildReportCards(
  opts: ShadowCompareOpts,
  healthyWindows: number,
  referenceSubstrate: string,
): { reportCards: Record<string, PerProfileReportCard>; crossSubstrateDiff: ReturnType<typeof computeCrossSubstrateDiff> } {
  const reportCards: Record<string, PerProfileReportCard> = {};
  for (const substrate of opts.substrates) {
    for (const scenario of opts.scenarios) {
      const key = `${substrate.name}--${scenario}`;
      reportCards[key] = aggregateSeedsToReportCard(
        substrate, scenario, opts.seeds, opts.outputDir, healthyWindows,
      );
    }
  }

  const crossSubstrateDiff = computeCrossSubstrateDiff(
    reportCards, referenceSubstrate, opts.scenarios,
  );
  for (const key of Object.keys(crossSubstrateDiff)) {
    reportCards[key].shadow_compare = crossSubstrateDiff[key];
  }
  return { reportCards, crossSubstrateDiff };
}

/** Steps 4-6 — emit per-profile report card files, the cross-substrate
 *  diff aggregate, and the aggregate pitch summary. Returns the artifact
 *  paths produced. */
function emitArtifacts(
  opts: ShadowCompareOpts,
  reportCards: Record<string, PerProfileReportCard>,
  crossSubstrateDiff: ReturnType<typeof computeCrossSubstrateDiff>,
  referenceSubstrate: string,
): { crossDiffPath: string; pitchSummaryPath: string } {
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

  return { crossDiffPath, pitchSummaryPath };
}

/** Aggregate acceptance gates: union (AND) across cross-substrate diffs. */
function aggregateAcceptanceGates(
  crossSubstrateDiff: ReturnType<typeof computeCrossSubstrateDiff>,
): Record<string, boolean> {
  const acceptanceGates: Record<string, boolean> = {};
  for (const key of Object.keys(crossSubstrateDiff)) {
    for (const gate of Object.keys(crossSubstrateDiff[key].acceptance_gates_passed)) {
      acceptanceGates[gate] = (acceptanceGates[gate] ?? true)
        && crossSubstrateDiff[key].acceptance_gates_passed[gate];
    }
  }
  return acceptanceGates;
}

// ── Main orchestrator ────────────────────────────────────────────

export function runShadowCompare(opts: ShadowCompareOpts): ShadowCompareReport {
  const healthyWindows = opts.healthyWindows ?? DEFAULT_HEALTHY_WINDOWS;
  fs.mkdirSync(opts.outputDir, { recursive: true });

  // Step 0 — per-substrate detector exemption map.
  const plan = computeSubstrateExemptions(opts);

  // Step 1 — per-(substrate × scenario × seed) sweep.
  runSweep(opts, healthyWindows, plan);

  // Steps 2-3 — aggregate report cards + cross-substrate diff vs
  // reference (synthetic_v1 by convention; first substrate in
  // opts.substrates[]).
  const referenceSubstrate = opts.substrates[0].name;
  const { reportCards, crossSubstrateDiff } = buildReportCards(
    opts, healthyWindows, referenceSubstrate,
  );

  // Steps 4-6 — emit artifacts.
  const { crossDiffPath, pitchSummaryPath } = emitArtifacts(
    opts, reportCards, crossSubstrateDiff, referenceSubstrate,
  );

  return {
    per_profile_report_cards: reportCards,
    cross_substrate_diff_path: crossDiffPath,
    acceptance_gates: aggregateAcceptanceGates(crossSubstrateDiff),
    pitch_summary_path: pitchSummaryPath,
  };
}
