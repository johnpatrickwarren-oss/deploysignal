// tools/_run-nab-validation-run.ts — Q64 SPEC-4 runNABValidation orchestration.
//
// Extracted from tools/run-nab-validation.ts. The original ~110-line
// runNABValidation body is decomposed into <100-line cohesive helpers
// (per-dataset scoring, per-family aggregation, acceptance gates, metadata
// capture); semantics are unchanged (statements moved verbatim into
// helpers). Re-exported from tools/run-nab-validation.ts to preserve the
// original import surface.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { computeNABScore, aggregateFamilyScore, NAB_PROFILES } from './nab-scoring';
import {
  type NABDetectorFamily,
  type NABValidationOpts,
  type NABValidationReport,
  DEFAULT_SUB_BENCHMARKS,
  DEFAULT_DETECTORS,
  TOOL_VERSION,
} from './_run-nab-validation-types';
import {
  discoverNABDatasets,
  parseNABDatasetCsv,
  loadNABLabels,
  annotationsFromLabels,
} from './_run-nab-validation-loading';
import { runDetectorOverDataset, DEFAULT_CALIBRATION_SIGNAL } from './_run-nab-validation-dispatch';

// ── Main runNABValidation ────────────────────────────────────────

/** Initialize the empty per-family score accumulator. */
function initPerFamilyScores(
  detectors: NABDetectorFamily[],
): NABValidationReport['per_family_scores'] {
  const perFamilyScores: NABValidationReport['per_family_scores'] = {} as
    NABValidationReport['per_family_scores'];
  for (const fam of detectors) {
    perFamilyScores[fam] = {
      standard_profile_score: 0,
      reward_low_fp_score: 0,
      reward_low_fn_score: 0,
      per_dataset_breakdown: {},
    };
  }
  return perFamilyScores;
}

/** Score every (dataset × detector) and fill per_dataset_breakdown. */
function scoreDatasets(
  perFamilyScores: NABValidationReport['per_family_scores'],
  detectors: NABDetectorFamily[],
  opts: NABValidationOpts,
  labels: Record<string, Array<[string, string]>>,
  datasets: ReturnType<typeof discoverNABDatasets>,
): void {
  for (const dataset of datasets) {
    const { values, timestamps } = parseNABDatasetCsv(dataset.absPath);
    const labelWindows = labels[dataset.relPath] ?? [];
    const annotations = annotationsFromLabels(labelWindows, timestamps);

    for (const fam of detectors) {
      const firings = runDetectorOverDataset(fam, values, opts.compiledConfig,
        opts.calibrationSignal ?? DEFAULT_CALIBRATION_SIGNAL);
      const standard = computeNABScore(firings, annotations, NAB_PROFILES.standard);
      const lowFp = computeNABScore(firings, annotations, NAB_PROFILES.reward_low_fp);
      const lowFn = computeNABScore(firings, annotations, NAB_PROFILES.reward_low_fn);
      perFamilyScores[fam].per_dataset_breakdown[dataset.relPath] = {
        dataset_path: dataset.relPath,
        n_ticks: values.length,
        n_anomaly_windows: annotations.length,
        standard_profile_score: standard,
        reward_low_fp_score: lowFp,
        reward_low_fn_score: lowFn,
      };
    }
  }
}

/** Aggregate per-family scores via mean across datasets (Lavin-Ahmad 2015 standard). */
function aggregatePerFamily(
  perFamilyScores: NABValidationReport['per_family_scores'],
  detectors: NABDetectorFamily[],
): void {
  for (const fam of detectors) {
    const fb = perFamilyScores[fam];
    const standardMap: Record<string, number> = {};
    const lowFpMap: Record<string, number> = {};
    const lowFnMap: Record<string, number> = {};
    for (const [rel, ds] of Object.entries(fb.per_dataset_breakdown)) {
      standardMap[rel] = ds.standard_profile_score;
      lowFpMap[rel] = ds.reward_low_fp_score;
      lowFnMap[rel] = ds.reward_low_fn_score;
    }
    fb.standard_profile_score = aggregateFamilyScore(standardMap);
    fb.reward_low_fp_score = aggregateFamilyScore(lowFpMap);
    fb.reward_low_fn_score = aggregateFamilyScore(lowFnMap);
  }
}

/** Evaluate acceptance gates per § Q64.2. */
function evaluateAcceptance(
  perFamilyScores: NABValidationReport['per_family_scores'],
): NABValidationReport['acceptance_results'] {
  // Q69.D: the classical family_A_page_cusum arm is retired; best-of-A in this
  // Q64-era copy is betting only (the engine's own NAB tool runs the Ville pair).
  const familyAStandard = perFamilyScores.family_A_betting?.standard_profile_score ?? 0;
  const familyDStandard = perFamilyScores.family_D_spectral?.standard_profile_score ?? 0;
  const family_A_passes = familyAStandard >= 50;
  const family_D_passes = familyDStandard >= 40;
  return {
    family_A_passes,
    family_D_passes,
    combined_acceptance: family_A_passes && family_D_passes,
  };
}

/** Resolve NAB repo git version (branch ref SHA or detached HEAD SHA). */
function readNabRepoVersion(nabRepoPath: string): string {
  let nabRepoVersion = 'unknown';
  const headPath = path.join(nabRepoPath, '.git', 'HEAD');
  if (fs.existsSync(headPath)) {
    try {
      const head = fs.readFileSync(headPath, 'utf8').trim();
      if (head.startsWith('ref: ')) {
        const refPath = path.join(nabRepoPath, '.git', head.slice(5));
        if (fs.existsSync(refPath)) {
          nabRepoVersion = fs.readFileSync(refPath, 'utf8').trim();
        }
      } else {
        nabRepoVersion = head;  // detached HEAD = direct SHA
      }
    } catch { /* ignore; preserve 'unknown' */ }
  }
  return nabRepoVersion;
}

/** Resolve DeploySignal compiled-config compiler_version. */
function readCompiledConfigVersion(compiledConfig: string): string {
  let dsCompiledVersion = 'unknown';
  if (fs.existsSync(compiledConfig)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(compiledConfig, 'utf8'));
      dsCompiledVersion = cfg.compiler_version ?? 'unknown';
    } catch { /* ignore */ }
  }
  return dsCompiledVersion;
}

export function runNABValidation(opts: NABValidationOpts): NABValidationReport {
  const subBenchmarks = opts.nabSubBenchmarks ?? DEFAULT_SUB_BENCHMARKS;
  const detectors = opts.detectors ?? DEFAULT_DETECTORS;
  const labelsPath = opts.labelsPath ?? path.join(opts.nabRepoPath, 'labels', 'combined_windows.json');

  const datasets = discoverNABDatasets(opts.nabRepoPath, subBenchmarks);
  const labels = loadNABLabels(labelsPath);

  const perFamilyScores = initPerFamilyScores(detectors);
  scoreDatasets(perFamilyScores, detectors, opts, labels, datasets);
  aggregatePerFamily(perFamilyScores, detectors);

  const acceptance_results = evaluateAcceptance(perFamilyScores);

  const report: NABValidationReport = {
    per_family_scores: perFamilyScores,
    acceptance_results,
    metadata: {
      nab_repo_version: readNabRepoVersion(opts.nabRepoPath),
      deploysignal_compiled_config_version: readCompiledConfigVersion(opts.compiledConfig),
      tool_version: TOOL_VERSION,
      sub_benchmarks_evaluated: subBenchmarks,
      detectors_evaluated: detectors,
    },
  };

  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
  fs.writeFileSync(opts.outputPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}
