// tools/run-nab-validation.ts — Q64 SPEC-4 NAB validation standalone tool.
//
// Per Q64-NAB-FIREWALL-SPEC.md § Q64.3 + § Implementation surface.
// Wraps existing `orchestrate(...)` engine dispatch via wrapper-layer;
// NO engine/detectors/* runtime code modifications (preserves Q58 ADR
// anti-scope clause 3 + Q59 H4 PERMANENT clause + Q60 anti-scope).
//
// Tool architecture (per spec § Q64.3):
//   1. Discover NAB datasets at nabRepoPath/data/<sub-benchmark>/*.csv.
//   2. Discover NAB labels at nabRepoPath/labels/combined_windows.json.
//   3. Per-(dataset × detector): run DeploySignal detector via
//      orchestrate(...) wrapper; capture per-tick firing decisions.
//   4. Per-(dataset × detector): compute NAB score (3 profiles) via
//      Lavin-Ahmad 2015 scoring formulas (tools/nab-scoring.ts).
//   5. Aggregate per-family across datasets.
//   6. Evaluate acceptance gates (Family A ≥ 50; Family D ≥ 40).
//   7. Emit JSON report at outputPath.
//
// Anti-scope:
//   - NO engine/detectors/* modifications.
//   - NO BaselineProvenance enum extension.
//   - NO integration with tools/build-report-card.js.
//   - NO Phase-3.d activation as Q64 dependency.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { computeNABScore, aggregateFamilyScore, NAB_PROFILES, type NABProfile } from './nab-scoring';
import { evaluateFamilyAShadow, type CUSUMStates } from '../engine/detectors/page-cusum.js';
import { evaluateFamilyABettingShadow, type BettingStates } from '../engine/detectors/betting-e-process.js';
import { evaluateFamilyD } from '../engine/detectors/spectral.js';
import type { CompiledConfig } from '../engine/types/config.js';

// ── Public types ─────────────────────────────────────────────────

/** Detector family identifier (subset of full DetectorFamily enum;
 *  Q64 evaluates Family A + Family D primary per § Q64.1). */
export type NABDetectorFamily =
  | 'family_A_betting'
  | 'family_A_page_cusum'
  | 'family_D_spectral';

export type NABSubBenchmark =
  | 'realKnownCause'
  | 'realAWSCloudwatch'
  | 'artificialNoAnomaly'
  | 'artificialWithAnomaly';

/** Per-tick firing decision captured from detector dispatch. */
export interface DetectorFiringDecision {
  tick: number;
  fire: boolean;
  /** Q64 Phase 4 STUB resolution: per-detector statistic at evaluation
   *  tick (CUSUM S_n; betting wealth M_t; spectral peak |ACF|).
   *  Optional — captured for diagnostic memo emission, not for NAB
   *  scoring (NAB scores depend on `fire` + tick alignment with
   *  annotation windows). */
  statistic_value?: number;
  /** Per-detector threshold (architect-disposed sliding-buffer
   *  threshold or per-cell threshold). Optional. */
  threshold?: number;
}

/** NAB anomaly annotation window (per Numenta labels/combined_windows.json). */
export interface NABDatasetAnnotation {
  anomaly_window_start: number;  // tick index
  anomaly_window_end: number;
}

export interface NABDatasetScore {
  dataset_path: string;
  n_ticks: number;
  n_anomaly_windows: number;
  standard_profile_score: number;
  reward_low_fp_score: number;
  reward_low_fn_score: number;
}

export interface NABValidationOpts {
  /** Path to NAB repository checkout (numenta/NAB GitHub clone). */
  nabRepoPath: string;
  /** Subset of NAB sub-benchmarks. Default: 4 architect-picked. */
  nabSubBenchmarks?: NABSubBenchmark[];
  /** DeploySignal compiled config path (substrate for detector calibration). */
  compiledConfig: string;
  /** Detector families. Default: family_A_betting + family_A_page_cusum + family_D_spectral. */
  detectors?: NABDetectorFamily[];
  /** Output validation report path. */
  outputPath: string;
  /** Optional NAB labels path override. Default: <nabRepoPath>/labels/combined_windows.json. */
  labelsPath?: string;
  /** Q64 Phase 4 architect-disposed calibration signal (default
   *  'p99_latency' heavy_tail signal class). Detector dispatch sources
   *  v5 substrate's family_A.per_signal[calibrationSignal] +
   *  family_D[calibrationSignal] for NAB scoring. */
  calibrationSignal?: string;
}

export interface NABValidationReport {
  per_family_scores: Record<NABDetectorFamily, {
    standard_profile_score: number;
    reward_low_fp_score: number;
    reward_low_fn_score: number;
    per_dataset_breakdown: Record<string, NABDatasetScore>;
  }>;
  acceptance_results: {
    family_A_passes: boolean;     // any family_A_* >= 50
    family_D_passes: boolean;     // family_D_spectral >= 40
    combined_acceptance: boolean;
  };
  metadata: {
    nab_repo_version: string;
    deploysignal_compiled_config_version: string;
    tool_version: string;
    sub_benchmarks_evaluated: NABSubBenchmark[];
    detectors_evaluated: NABDetectorFamily[];
  };
}

const DEFAULT_SUB_BENCHMARKS: NABSubBenchmark[] = [
  'realKnownCause',
  'realAWSCloudwatch',
  'artificialNoAnomaly',
  'artificialWithAnomaly',
];

const DEFAULT_DETECTORS: NABDetectorFamily[] = [
  'family_A_betting',
  'family_A_page_cusum',
  'family_D_spectral',
];

const TOOL_VERSION = 'Q64 SPEC-4 v1.0';

// ── NAB dataset discovery + parsing ─────────────────────────────

/** Discover NAB dataset CSV files under <nabRepoPath>/data/<sub>/*.csv. */
export function discoverNABDatasets(
  nabRepoPath: string, subBenchmarks: NABSubBenchmark[],
): Array<{ subBenchmark: NABSubBenchmark; relPath: string; absPath: string }> {
  const out: Array<{ subBenchmark: NABSubBenchmark; relPath: string; absPath: string }> = [];
  const dataRoot = path.join(nabRepoPath, 'data');
  if (!fs.existsSync(dataRoot)) {
    throw new Error(`NAB repository missing data/ directory at ${nabRepoPath}; verify nabRepoPath`);
  }
  for (const sub of subBenchmarks) {
    const subDir = path.join(dataRoot, sub);
    if (!fs.existsSync(subDir)) continue;
    const entries = fs.readdirSync(subDir);
    for (const entry of entries) {
      if (!entry.endsWith('.csv')) continue;
      const abs = path.join(subDir, entry);
      const rel = path.join(sub, entry);
      out.push({ subBenchmark: sub, relPath: rel, absPath: abs });
    }
  }
  return out;
}

/** Parse NAB dataset CSV. Numenta convention: header row `timestamp,
 *  value`; per-tick observation. Returns per-tick value array (tick
 *  index = row index post-header). */
export function parseNABDatasetCsv(absPath: string): { values: number[]; timestamps: string[] } {
  const data = fs.readFileSync(absPath, 'utf8');
  const lines = data.split('\n').filter((l) => l.trim().length > 0);
  const header = lines[0].split(',').map((s) => s.trim());
  const tsIdx = header.indexOf('timestamp');
  const valIdx = header.indexOf('value');
  if (tsIdx < 0 || valIdx < 0) {
    throw new Error(
      `NAB CSV ${path.basename(absPath)} missing 'timestamp' or 'value' header column. `
      + `Got: ${JSON.stringify(header)}`,
    );
  }
  const values: number[] = [];
  const timestamps: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    timestamps.push(f[tsIdx]);
    values.push(parseFloat(f[valIdx]));
  }
  return { values, timestamps };
}

/** Load NAB combined_windows.json labels file. Maps relative dataset
 *  path (e.g. 'realKnownCause/foo.csv') to array of [start_ts, end_ts]
 *  ISO strings. */
export function loadNABLabels(labelsPath: string): Record<string, Array<[string, string]>> {
  if (!fs.existsSync(labelsPath)) {
    throw new Error(`NAB labels missing at ${labelsPath}; verify nabRepoPath/labels/combined_windows.json`);
  }
  const data = fs.readFileSync(labelsPath, 'utf8');
  return JSON.parse(data);
}

/** Convert NAB ISO-timestamp anomaly windows to tick-index annotations
 *  by indexing into the per-dataset timestamps array. */
/** Normalize a NAB timestamp string for comparison.
 *  Labels carry microseconds (`"2014-04-10 07:15:00.000000"`) while
 *  CSVs drop them (`"2014-04-10 07:15:00"`). Strip the fractional
 *  seconds component so label timestamps match CSV timestamps for
 *  tick-bucket lookup. Also tolerates `T` separator and `Z` suffix
 *  defensively. */
function normalizeNABTimestamp(ts: string): string {
  // Convert ISO 'T' separator to space; drop trailing 'Z'.
  let s = ts.replace('T', ' ').replace(/Z$/, '');
  // Strip fractional seconds.
  s = s.replace(/\.\d+$/, '');
  return s;
}

export function annotationsFromLabels(
  labelWindows: Array<[string, string]>, timestamps: string[],
): NABDatasetAnnotation[] {
  const tsToTick = new Map<string, number>();
  for (let i = 0; i < timestamps.length; i++) tsToTick.set(normalizeNABTimestamp(timestamps[i]), i);
  const out: NABDatasetAnnotation[] = [];
  for (const [startTs, endTs] of labelWindows) {
    const start = tsToTick.get(normalizeNABTimestamp(startTs));
    const end = tsToTick.get(normalizeNABTimestamp(endTs));
    if (start === undefined || end === undefined) continue;  // label timestamp not in dataset
    out.push({ anomaly_window_start: start, anomaly_window_end: end });
  }
  return out;
}

// ── Detector dispatch (wrapper-layer) ────────────────────────────

/** Run a single detector family over a NAB dataset and capture per-
 *  tick firing decisions. Pure wrapper-layer: imports orchestrate
 *  via shared.js (preserves Q58/Q59/Q60 anti-scope on engine/detectors/*).
 *
 *  Mac Claude implementation deferred to Phase 3 empirical run; tool
 *  framework + scoring helper testable independent of detector
 *  dispatch path. Stub returns empty firing list (caller handles via
 *  Phase 3 architect-disposition or per-detector dispatch resolution
 *  with real NAB data). */
/** Q64 Phase 4 architect-disposed default calibration signal — heavy_tail
 *  signal class most representative of NAB time-series anomalies
 *  (realAWSCloudwatch CPU; realKnownCause sensor data). Settable via
 *  --calibration-signal CLI flag. */
export const DEFAULT_CALIBRATION_SIGNAL = 'p99_latency';

/** Rolling window length for Family D spectral peak-ACF evaluation. */
const FAMILY_D_WINDOW = 60;

export function runDetectorOverDataset(
  family: NABDetectorFamily,
  values: number[],
  compiledConfigPath: string,
  calibrationSignal: string = DEFAULT_CALIBRATION_SIGNAL,
): DetectorFiringDecision[] {
  // Q64 Phase 4 STUB resolution per architect option (i.a) single-signal-
  // detector emulation (ARCHITECT-REPLY-Q64-PHASE-4-NAB-ACQUISITION-STUB-
  // DISPOSITION.md § Ask 1). Family A + Family D natively per-signal;
  // NAB univariate maps cleanly. Calibration source: v5 substrate's
  // family_A.per_signal[calibrationSignal] / family_D[calibrationSignal]
  // (default 'p99_latency' heavy_tail signal class).
  //
  // Architect pseudo-code uses `evaluatePageCusumPerSignal` /
  // `evaluateBettingEProcessPerSignal` / `evaluateSpectralPeakAcfPerSignal`;
  // codebase actuals are `evaluateFamilyAShadow` /
  // `evaluateFamilyABettingShadow` / `evaluateFamilyD` — naming drift
  // only; semantics match (single-signal evaluation per call).
  const cfg = JSON.parse(fs.readFileSync(compiledConfigPath, 'utf8')) as CompiledConfig;

  // NAB datasets carry no hour-of-day metadata; pin to (h=0, d=0) so the
  // detectors fall through to aggregate_fallback (per architect-disposed
  // calibration source: aggregate_fallback.family_A.per_signal[sig] +
  // aggregate_fallback.family_D[sig]).
  const ctx = {
    hourOfDay: 0,
    dayOfWeek: 0,
    ticksSinceDeploy: 0,
    deployAgeDays: 0,
    trafficPct: 1,
  };

  const out: DetectorFiringDecision[] = [];

  if (family === 'family_A_page_cusum') {
    const states: CUSUMStates = {};
    for (let t = 0; t < values.length; t++) {
      const verdicts = evaluateFamilyAShadow(
        cfg,
        { [calibrationSignal]: values[t] },
        states,
        { ...ctx, ticksSinceDeploy: t },
      );
      const v = verdicts.find((x) => x.signal === calibrationSignal);
      out.push({
        tick: t,
        fire: v?.verdict === 'fire',
        statistic_value: v?.statistic ?? undefined,
        threshold: v?.threshold ?? undefined,
      });
    }
  } else if (family === 'family_A_betting') {
    const states: BettingStates = {};
    for (let t = 0; t < values.length; t++) {
      const verdicts = evaluateFamilyABettingShadow(
        cfg,
        { [calibrationSignal]: values[t] },
        states,
        { ...ctx, ticksSinceDeploy: t },
      );
      const v = verdicts.find((x) => x.signal === calibrationSignal);
      out.push({
        tick: t,
        fire: v?.verdict === 'fire',
        statistic_value: v?.statistic ?? undefined,
        threshold: v?.threshold ?? undefined,
      });
    }
  } else if (family === 'family_D_spectral') {
    const recent: number[] = [];
    for (let t = 0; t < values.length; t++) {
      recent.push(values[t]);
      if (recent.length > FAMILY_D_WINDOW) recent.shift();
      const v = evaluateFamilyD(
        cfg,
        calibrationSignal,
        recent,
        { ...ctx, ticksSinceDeploy: t },
      );
      out.push({
        tick: t,
        fire: v?.verdict === 'fire',
        statistic_value: v?.statistic ?? undefined,
        threshold: v?.threshold ?? undefined,
      });
    }
  } else {
    throw new Error(
      `Detector ${family} not supported at Q64 NAB validation; only `
      + 'family_A_betting + family_A_page_cusum + family_D_spectral architect-picked '
      + '(per Q64 spec § Q64.1 + ARCHITECT-REPLY-Q64-PHASE-4-NAB-ACQUISITION-STUB-DISPOSITION.md).');
  }

  return out;
}

// ── Main runNABValidation ────────────────────────────────────────

export function runNABValidation(opts: NABValidationOpts): NABValidationReport {
  const subBenchmarks = opts.nabSubBenchmarks ?? DEFAULT_SUB_BENCHMARKS;
  const detectors = opts.detectors ?? DEFAULT_DETECTORS;
  const labelsPath = opts.labelsPath ?? path.join(opts.nabRepoPath, 'labels', 'combined_windows.json');

  const datasets = discoverNABDatasets(opts.nabRepoPath, subBenchmarks);
  const labels = loadNABLabels(labelsPath);

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

  // Aggregate per-family scores via mean across datasets (Lavin-Ahmad 2015 standard).
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

  // Acceptance gates per § Q64.2.
  const familyAStandard = Math.max(
    perFamilyScores.family_A_betting?.standard_profile_score ?? 0,
    perFamilyScores.family_A_page_cusum?.standard_profile_score ?? 0,
  );
  const familyDStandard = perFamilyScores.family_D_spectral?.standard_profile_score ?? 0;
  const family_A_passes = familyAStandard >= 50;
  const family_D_passes = familyDStandard >= 40;

  // Capture metadata.
  let nabRepoVersion = 'unknown';
  const headPath = path.join(opts.nabRepoPath, '.git', 'HEAD');
  if (fs.existsSync(headPath)) {
    try {
      const head = fs.readFileSync(headPath, 'utf8').trim();
      if (head.startsWith('ref: ')) {
        const refPath = path.join(opts.nabRepoPath, '.git', head.slice(5));
        if (fs.existsSync(refPath)) {
          nabRepoVersion = fs.readFileSync(refPath, 'utf8').trim();
        }
      } else {
        nabRepoVersion = head;  // detached HEAD = direct SHA
      }
    } catch { /* ignore; preserve 'unknown' */ }
  }
  let dsCompiledVersion = 'unknown';
  if (fs.existsSync(opts.compiledConfig)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(opts.compiledConfig, 'utf8'));
      dsCompiledVersion = cfg.compiler_version ?? 'unknown';
    } catch { /* ignore */ }
  }

  const report: NABValidationReport = {
    per_family_scores: perFamilyScores,
    acceptance_results: {
      family_A_passes,
      family_D_passes,
      combined_acceptance: family_A_passes && family_D_passes,
    },
    metadata: {
      nab_repo_version: nabRepoVersion,
      deploysignal_compiled_config_version: dsCompiledVersion,
      tool_version: TOOL_VERSION,
      sub_benchmarks_evaluated: subBenchmarks,
      detectors_evaluated: detectors,
    },
  };

  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
  fs.writeFileSync(opts.outputPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}

// ── CLI entrypoint ───────────────────────────────────────────────

interface CliArgs {
  nabRepo: string;
  compiled: string;
  out: string;
  detectors?: NABDetectorFamily[];
  subBenchmarks?: NABSubBenchmark[];
  calibrationSignal?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--nab-repo': out.nabRepo = v; i++; break;
      case '--compiled': out.compiled = v; i++; break;
      case '--out':      out.out = v; i++; break;
      case '--detectors':
        out.detectors = v.split(',').map((s) => s.trim()) as NABDetectorFamily[];
        i++;
        break;
      case '--sub-benchmarks':
        out.subBenchmarks = v.split(',').map((s) => s.trim()) as NABSubBenchmark[];
        i++;
        break;
      case '--calibration-signal':
        out.calibrationSignal = v;
        i++;
        break;
      default:
        if (k.startsWith('--')) throw new Error(`Unknown flag: ${k}`);
    }
  }
  if (!out.nabRepo || !out.compiled || !out.out) {
    throw new Error(
      'Required: --nab-repo <path> --compiled <path> --out <path>. '
      + 'Optional: --detectors family_A_betting,family_A_page_cusum,family_D_spectral '
      + '--sub-benchmarks realKnownCause,realAWSCloudwatch,artificialNoAnomaly,artificialWithAnomaly',
    );
  }
  return out as CliArgs;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[run-nab-validation] tool=${TOOL_VERSION}`);
  console.log(`[run-nab-validation] nab_repo=${args.nabRepo}`);
  console.log(`[run-nab-validation] compiled=${args.compiled}`);
  const report = runNABValidation({
    nabRepoPath: args.nabRepo,
    compiledConfig: args.compiled,
    outputPath: args.out,
    detectors: args.detectors,
    nabSubBenchmarks: args.subBenchmarks,
    calibrationSignal: args.calibrationSignal,
  });
  console.log(`[run-nab-validation]   nab_repo_version=${report.metadata.nab_repo_version}`);
  for (const fam of report.metadata.detectors_evaluated) {
    const fb = report.per_family_scores[fam];
    console.log(
      `[run-nab-validation]   ${fam}: standard=${fb.standard_profile_score.toFixed(2)} `
      + `low_fp=${fb.reward_low_fp_score.toFixed(2)} low_fn=${fb.reward_low_fn_score.toFixed(2)}`,
    );
  }
  console.log(
    `[run-nab-validation]   acceptance: family_A_passes=${report.acceptance_results.family_A_passes} `
    + `family_D_passes=${report.acceptance_results.family_D_passes} `
    + `combined=${report.acceptance_results.combined_acceptance}`,
  );
  console.log(`[run-nab-validation] wrote ${args.out}`);
}

if (process.argv.some((a) => a === '--nab-repo')) {
  main();
}
