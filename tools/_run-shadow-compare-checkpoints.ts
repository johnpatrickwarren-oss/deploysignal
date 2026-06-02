// tools/_run-shadow-compare-checkpoints.ts — checkpoint I/O (V2
// incremental emission discipline), single-seed trial execution, and
// seed→report-card aggregation for the shadow-compare orchestrator
// (extracted verbatim from tools/run-shadow-compare.ts during a
// behavior-preserving module split).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import type {
  Q60DetectorFamily,
  ProfileReportCardBlock,
  SweepCheckpoint,
} from '../engine/types/config.js';
import {
  Q60_DETECTOR_FAMILIES,
  type PerProfileReportCard,
  type SubstrateRef,
} from './_run-shadow-compare-types';

// ── Checkpoint I/O (V2 incremental emission discipline) ─────────

export function checkpointPathFor(
  outputDir: string, substrate: string, scenario: string, seed: number,
): string {
  return path.join(outputDir, 'checkpoints', `${substrate}--${scenario}--${seed}.json`);
}

export function readCheckpoint(checkpointPath: string): SweepCheckpoint | undefined {
  if (!fs.existsSync(checkpointPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as SweepCheckpoint;
  } catch {
    return undefined;  // malformed checkpoint; treat as missing
  }
}

export function writeCheckpoint(checkpointPath: string, cp: SweepCheckpoint): void {
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(checkpointPath, JSON.stringify(cp, null, 2) + '\n');
}

// ── Single-seed trial execution ──────────────────────────────────

export interface SeedTrialResult {
  per_detector_firing_counts: Record<Q60DetectorFamily, number>;
  per_detector_firing_ids: Record<Q60DetectorFamily, string[]>;
}

export function runProfileValidationSingleSeed(
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

export function aggregateSeedsToReportCard(
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
