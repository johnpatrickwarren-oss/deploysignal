#!/usr/bin/env node
// tools/run-comparator-baseline.ts — WS6.2 Task 7 CLI entry point.
//
// node tools/run-comparator-baseline.ts \
//   --baseline runs/baselines/synthetic-v1 \
//   --compiled runs/compiled-configs/v5-sequential-e-process.json \
//   --endpoints runs/comparator-baseline/ENDPOINTS.md \
//   --out runs/comparator-baseline/report-synthetic-v1.json \
//   --summary runs/comparator-baseline/SUMMARY-synthetic-v1.md \
//   [--arms <csv>] [--healthy-windows N] [--tuning-windows N] [--seed N] \
//   [--tuning-seed N] [--canary-ticks N] [--injection-tick N] \
//   [--repeats-per-profile N] [--allow-nonregistered-params]
//
// Flow: parse ENDPOINTS.md's frozen JSON block -> hard-fail if any CLI
// override disagrees with `frozen_params` (or the frozen `arms` list)
// unless --allow-nonregistered-params is passed (stamps
// `non_registered_run: true` into the report; smoke/test runs only) ->
// build the window plan -> tune (threshold, canary, combined-escalation)
// against the tuning split -> evaluate every arm over every eval window ->
// emit the report JSON + markdown summary.
//
// Per the implementation plan's binding constraint: the untyped
// `_build-report-card-*.js` modules are require()d as-is and never
// modified/refactored in this PR.
//
// ── --healthy-fp-only (secondary mode) ──────────────────────────────
//
// node tools/run-comparator-baseline.ts --healthy-fp-only \
//   --tuned-params runs/comparator-baseline/report-synthetic-v1.json \
//   --endpoints runs/comparator-baseline/ENDPOINTS.md \
//   --out runs/comparator-baseline/report-real-traces.json \
//   --summary runs/comparator-baseline/SUMMARY-real-traces.md
//
// The v8/v9 real-trace healthy-FP-only SECONDARY rows deferred by
// ENDPOINTS.md's Open Question 4 (adopted default). No tuning split, no
// injected split, no --arms/--baseline/--compiled (each of the four
// hardcoded real-trace substrates — see
// `_comparator-baseline-real-trace.ts`'s `REAL_TRACE_SUBSTRATES` — brings
// its own baseline + compiled config). `--tuned-params` points at an
// already-emitted primary report (default: the committed
// report-synthetic-v1.json); its `tuning.threshold.params` /
// `tuning.canary.params` are REUSED verbatim (never re-tuned) and
// restricted per substrate to that substrate's own resolvable signal set.
// Only `false_rollbacks` is measured (no injection => no escaped
// regressions or detection delay). This mode does not touch
// tuning_windows/repeats_per_profile/injection_tick, so it never disagrees
// with `frozen_params` on those axes and does not require
// --allow-nonregistered-params at the frozen healthy_windows=131/
// eval_seed=42 defaults — it IS pre-registered, via Open Question 4, not
// an ad hoc override.

import * as fs from 'node:fs';
import * as path from 'node:path';

// NOTE on the `.js`-suffixed relative specifiers below (matching the
// established tools/calibrate.ts convention): this file is executed
// directly (`node tools/run-comparator-baseline.ts`). Node's native TS
// support detects the `import`/`export` syntax, can't parse the file as
// CommonJS, and transparently reparses it as ESM — under which relative
// specifiers must resolve to an exact file (no CJS-style extensionless
// auto-resolution). Pointing the specifier at the tsc-compiled `.js`
// sibling (always present after `pretest`/`npm run build`) lands on a
// plain CommonJS file, and everything required transitively from there
// goes through ordinary `require()` resolution (extensionless fine) —
// so only this entry file's own top-level imports need the suffix.
import type { Baseline, CompiledConfig, EndpointsSpec, FrozenParams } from './_comparator-baseline-types';
import {
  parseEndpointsFile,
  resolveEngineVersion,
  buildReport,
  renderMarkdownSummary,
  loadBaselineForCli,
  type WindowResultEntry,
} from './_comparator-baseline-report.js';
import { buildWindowPlan, materializeWindow, runArmsOverWindow, buildDefaultArmsConfig } from './_comparator-baseline-driver.js';
import { tuneThreshold, tuneCanary, tuneCombined } from './_comparator-baseline-tune.js';
import { loadAllRegressionProfiles } from './inject-regression.js';
import {
  REAL_TRACE_SUBSTRATES,
  evaluateSubstrateHealthyFp,
  type RealTraceSubstrateResult,
} from './_comparator-baseline-real-trace.js';
import {
  buildRealTraceReport,
  renderRealTraceMarkdownSummary,
  sha256Hex,
} from './_comparator-baseline-real-trace-report.js';
import type { ComparatorBaselineReport } from './_comparator-baseline-report.js';

/** Walk up from this script's own path (not `__dirname` — this file runs
 *  as ESM at the top level per the note above, where `__dirname` is
 *  unavailable) to find the repo root (nearest ancestor with a
 *  package.json), mirroring inject-regression.ts's `_repoRoot` helper. */
function repoRoot(): string {
  let dir = path.dirname(path.resolve(process.argv[1] ?? '.'));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found from tools/run-comparator-baseline.ts');
}

// ── CLI parsing ──────────────────────────────────────────────────────

interface CliArgs {
  baseline: string;
  compiled: string;
  endpoints: string;
  out: string;
  summary: string;
  arms?: string;
  healthyWindows?: number;
  tuningWindows?: number;
  seed?: number;
  tuningSeed?: number;
  canaryTicks?: number;
  injectionTick?: number;
  repeatsPerProfile?: number;
  allowNonRegisteredParams: boolean;
  healthyFpOnly: boolean;
  tunedParams?: string;
}

/** Flag -> setter dispatch table (data-driven rather than a long
 *  switch/if-chain, so this stays a flat, low-complexity lookup no matter
 *  how many flags the CLI grows to support — each setter is a trivial
 *  one-line closure). */
function cliFlagSetters(out: CliArgs): Record<string, (v: string) => void> {
  return {
    '--baseline': (v) => { out.baseline = v; },
    '--compiled': (v) => { out.compiled = v; },
    '--endpoints': (v) => { out.endpoints = v; },
    '--out': (v) => { out.out = v; },
    '--summary': (v) => { out.summary = v; },
    '--arms': (v) => { out.arms = v; },
    '--healthy-windows': (v) => { out.healthyWindows = parseInt(v, 10); },
    '--tuning-windows': (v) => { out.tuningWindows = parseInt(v, 10); },
    '--seed': (v) => { out.seed = parseInt(v, 10); },
    '--tuning-seed': (v) => { out.tuningSeed = parseInt(v, 10); },
    '--canary-ticks': (v) => { out.canaryTicks = parseInt(v, 10); },
    '--injection-tick': (v) => { out.injectionTick = parseInt(v, 10); },
    '--repeats-per-profile': (v) => { out.repeatsPerProfile = parseInt(v, 10); },
    '--tuned-params': (v) => { out.tunedParams = v; },
  };
}

function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    baseline: 'runs/baselines/synthetic-v1',
    compiled: 'runs/compiled-configs/v5-sequential-e-process.json',
    endpoints: 'runs/comparator-baseline/ENDPOINTS.md',
    out: 'runs/comparator-baseline/report-synthetic-v1.json',
    summary: 'runs/comparator-baseline/SUMMARY-synthetic-v1.md',
    allowNonRegisteredParams: false,
    healthyFpOnly: false,
  };
  const setters = cliFlagSetters(out);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--allow-nonregistered-params') { out.allowNonRegisteredParams = true; continue; }
    if (k === '--healthy-fp-only') { out.healthyFpOnly = true; continue; }
    const setter = setters[k];
    if (setter) { setter(argv[i + 1]); i++; continue; }
    if (k.startsWith('--')) throw new Error(`run-comparator-baseline: unrecognized flag "${k}"`);
  }
  return out;
}

// ── Frozen-param disagreement check ─────────────────────────────────

function checkFrozenParams(
  args: CliArgs,
  frozen: FrozenParams,
): { overrides: Partial<FrozenParams>; armsOverride: string[] | undefined; mismatches: string[] } {
  const overrides: Partial<FrozenParams> = {};
  const mismatches: string[] = [];

  function check<K extends keyof FrozenParams>(cliVal: number | undefined, key: K, flag: string): void {
    if (cliVal === undefined) return;
    if (cliVal !== frozen[key]) mismatches.push(`${flag}: CLI=${cliVal} frozen_params.${String(key)}=${frozen[key]}`);
    (overrides as Record<string, unknown>)[key] = cliVal;
  }
  check(args.healthyWindows, 'healthy_windows', '--healthy-windows');
  check(args.tuningWindows, 'tuning_windows', '--tuning-windows');
  check(args.seed, 'eval_seed', '--seed');
  check(args.tuningSeed, 'tuning_seed', '--tuning-seed');
  check(args.canaryTicks, 'canary_ticks', '--canary-ticks');
  check(args.injectionTick, 'injection_tick', '--injection-tick');
  check(args.repeatsPerProfile, 'repeats_per_profile', '--repeats-per-profile');

  let armsOverride: string[] | undefined;
  if (args.arms !== undefined) {
    armsOverride = args.arms.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    // caller supplies frozen.arms-equivalent comparison; folded in by the caller.
  }
  return { overrides, armsOverride, mismatches };
}

// ── --healthy-fp-only (secondary mode) ──────────────────────────────

interface TunedParamsSource {
  sourcePathRelative: string;
  sha256: string;
  tunedThreshold: ComparatorBaselineReport['tuning']['threshold']['params'];
  tunedCanary: ComparatorBaselineReport['tuning']['canary']['params'];
}

/** Load the reused tuned threshold/canary params from an already-emitted
 *  primary report (default: the committed report-synthetic-v1.json),
 *  plus the provenance (relative path + sha256 of the raw file text) the
 *  secondary report echoes so a reader can verify exactly which primary
 *  run's tuning these real-trace rows reuse. */
function loadTunedParamsSource(repo: string, tunedParamsArg: string | undefined): TunedParamsSource {
  const sourcePath = path.resolve(repo, tunedParamsArg ?? 'runs/comparator-baseline/report-synthetic-v1.json');
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const sourceReport = JSON.parse(raw) as ComparatorBaselineReport;
  return {
    sourcePathRelative: path.relative(repo, sourcePath),
    sha256: sha256Hex(raw),
    tunedThreshold: sourceReport.tuning.threshold.params,
    tunedCanary: sourceReport.tuning.canary.params,
  };
}

/** Evaluate every registered real-trace substrate's healthy-FP-only
 *  secondary row set, partitioning into (feasible) `substrates` and
 *  (OQ-4-gate-failed) `skippedSubstrates` — never bending the window
 *  machinery to force a skipped substrate in. */
function evaluateAllSubstrates(
  repo: string,
  spec: EndpointsSpec,
  tuned: TunedParamsSource,
): { substrates: RealTraceSubstrateResult[]; skippedSubstrates: Array<{ id: string; reason: string }> } {
  const substrates: RealTraceSubstrateResult[] = [];
  const skippedSubstrates: Array<{ id: string; reason: string }> = [];

  for (const substrate of REAL_TRACE_SUBSTRATES) {
    const baselinePath = path.resolve(repo, substrate.baselineDir);
    const compiledPath = path.resolve(repo, substrate.compiledConfigPath);
    console.log(`[run-comparator-baseline] [healthy-fp-only] evaluating ${substrate.id}...`);
    const baseline: Baseline = loadBaselineForCli(baselinePath);
    const compiledConfig: CompiledConfig = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));
    const outcome = evaluateSubstrateHealthyFp(
      substrate.id, baseline, compiledConfig, spec, tuned.tunedThreshold, tuned.tunedCanary,
    );
    if (outcome.skipped) {
      console.warn(`[run-comparator-baseline] [healthy-fp-only] SKIPPING ${substrate.id}: ${outcome.reason}`);
      skippedSubstrates.push({ id: outcome.id, reason: outcome.reason });
    } else {
      const { skipped: _skipped, ...result } = outcome;
      substrates.push(result);
    }
  }
  return { substrates, skippedSubstrates };
}

function runHealthyFpOnly(
  args: CliArgs,
  repo: string,
  spec: EndpointsSpec,
  endpointsSha256: string,
  nonRegisteredRun: boolean,
): void {
  const tuned = loadTunedParamsSource(repo, args.tunedParams);
  const { substrates, skippedSubstrates } = evaluateAllSubstrates(repo, spec, tuned);

  const report = buildRealTraceReport({
    endpointsVersion: spec.endpoints_version,
    endpointsSha256,
    engineVersion: resolveEngineVersion(repo),
    tunedParamsProvenance: { source_report: tuned.sourcePathRelative, sha256: tuned.sha256 },
    healthyWindows: spec.frozen_params.healthy_windows,
    seed: spec.frozen_params.eval_seed,
    resampler: spec.frozen_params.resampler,
    substrates,
    skippedSubstrates,
  });
  if (nonRegisteredRun) report.non_registered_run = true;

  const outPath = path.resolve(repo, args.out);
  const summaryPath = path.resolve(repo, args.summary);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, renderRealTraceMarkdownSummary(report));

  console.log(`[run-comparator-baseline] [healthy-fp-only] wrote ${outPath}`);
  console.log(`[run-comparator-baseline] [healthy-fp-only] wrote ${summaryPath}`);
}

// ── frozen-param mismatch reporting ─────────────────────────────────

/** Reconcile the `--arms` CLI override (if any) against the frozen
 *  `arms` list, appending a mismatch entry when they disagree. Extracted
 *  from `main()` (complexity budget — see `handleNonRegisteredRun`
 *  below for why this file keeps splitting these out rather than growing
 *  `main()`'s branch count). */
function reconcileArmsOverride(armsOverride: string[] | undefined, frozenArms: string[], mismatches: string[]): void {
  if (armsOverride === undefined) return;
  const provided = [...armsOverride].sort();
  const frozen = [...frozenArms].sort();
  if (JSON.stringify(provided) !== JSON.stringify(frozen)) {
    mismatches.push(`--arms: CLI=${provided.join(',')} frozen arms=${frozen.join(',')}`);
  }
}

/** Hard-fail (exit 1) on an unacknowledged frozen-param mismatch, or warn
 *  and continue when `--allow-nonregistered-params` was passed. Extracted
 *  from `main()` so `main()` itself stays a flat, low-complexity
 *  orchestration function as this CLI grows more modes (this repo's
 *  `no-complex-functions` architectural gate — see the Task 7 commit's
 *  own note on the same constraint driving the flag-setter dispatch
 *  table above). */
function handleNonRegisteredRun(mismatches: string[], allowNonRegisteredParams: boolean): void {
  if (mismatches.length === 0) return;
  if (!allowNonRegisteredParams) {
    console.error('[run-comparator-baseline] CLI arguments disagree with the frozen ' +
      'runs/comparator-baseline/ENDPOINTS.md parameters:');
    for (const m of mismatches) console.error(`  - ${m}`);
    console.error('Refusing to run. Pass --allow-nonregistered-params to run anyway ' +
      '(stamps non_registered_run:true into the report; smoke/test runs only).');
    process.exit(1);
  }
  console.warn('[run-comparator-baseline] --allow-nonregistered-params: running with frozen-param ' +
    'mismatches (non_registered_run:true will be stamped into the report):');
  for (const m of mismatches) console.warn(`  - ${m}`);
}

// ── main ────────────────────────────────────────────────────────────

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const repo = repoRoot();
  const endpointsPath = path.resolve(repo, args.endpoints);
  const { spec, sha256 } = parseEndpointsFile(endpointsPath);

  const { overrides, armsOverride, mismatches } = checkFrozenParams(args, spec.frozen_params);
  reconcileArmsOverride(armsOverride, spec.arms, mismatches);

  const nonRegisteredRun = mismatches.length > 0;
  handleNonRegisteredRun(mismatches, args.allowNonRegisteredParams);

  const effectiveFrozenParams: FrozenParams = { ...spec.frozen_params, ...overrides };
  const effectiveSpec: EndpointsSpec = {
    ...spec,
    frozen_params: effectiveFrozenParams,
    arms: armsOverride ?? spec.arms,
  };

  if (args.healthyFpOnly) {
    runHealthyFpOnly(args, repo, effectiveSpec, sha256, nonRegisteredRun);
    return;
  }

  const baselinePath = path.resolve(repo, args.baseline);
  const compiledPath = path.resolve(repo, args.compiled);

  console.log(`[run-comparator-baseline] loading baseline ${baselinePath} + compiled config ${compiledPath}...`);
  const baseline: Baseline = loadBaselineForCli(baselinePath);
  const compiledConfig: CompiledConfig = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));
  const profiles = loadAllRegressionProfiles();

  console.log(
    `[run-comparator-baseline] building window plan ` +
    `(tuning=${effectiveFrozenParams.tuning_windows}, healthy=${effectiveFrozenParams.healthy_windows}, ` +
    `injected=${profiles.length}x${effectiveFrozenParams.repeats_per_profile})...`,
  );
  const plan = buildWindowPlan(baseline, effectiveSpec, profiles);
  const tuningEntries = plan.filter((e) => e.provenance.split === 'tuning');
  const evalEntries = plan.filter((e) => e.provenance.split !== 'tuning');

  console.log(`[run-comparator-baseline] tuning threshold_tuned on ${tuningEntries.length} tuning windows...`);
  const thresholdTune = tuneThreshold(tuningEntries, compiledConfig, effectiveSpec);
  console.log(`[run-comparator-baseline] tuning canary_tuned...`);
  const canaryTune = tuneCanary(tuningEntries, baseline, effectiveSpec);
  console.log(`[run-comparator-baseline] resolving combined_tuned escalation...`);
  const combinedTune = tuneCombined(thresholdTune, canaryTune, tuningEntries, baseline, compiledConfig, effectiveSpec);

  const defaultArms = buildDefaultArmsConfig(effectiveSpec, compiledConfig);
  const tunedArmsConfig = {
    threshold: combinedTune.params.threshold,
    canary: combinedTune.params.canary,
    thresholdDefault: defaultArms.threshold,
    canaryDefault: defaultArms.canary,
  };

  console.log(`[run-comparator-baseline] evaluating ${evalEntries.length} eval windows across ${effectiveSpec.arms.length} arms...`);
  const armSet = new Set(effectiveSpec.arms);
  const evalWindowResults: WindowResultEntry[] = evalEntries.map((entry, i) => {
    if (i > 0 && i % 50 === 0) console.log(`  ... ${i}/${evalEntries.length} eval windows`);
    const materialized = materializeWindow(entry, baseline, compiledConfig);
    const allArmResults = runArmsOverWindow(materialized, tunedArmsConfig, compiledConfig, effectiveSpec);
    const armResults: Record<string, typeof allArmResults[string]> = {};
    for (const armId of Object.keys(allArmResults)) {
      if (armSet.has(armId)) armResults[armId] = allArmResults[armId];
    }
    return { provenance: entry.provenance, armResults };
  });

  const report = buildReport({
    spec: effectiveSpec,
    endpointsSha256: sha256,
    generatedWith: {
      baseline_id: path.basename(baselinePath),
      compiled_config_ref: path.relative(repo, compiledPath),
      engine_version: resolveEngineVersion(repo),
    },
    nonRegisteredRun,
    tuning: { threshold: thresholdTune, canary: canaryTune, combined: combinedTune },
    evalWindowResults,
    injectionTick: effectiveFrozenParams.injection_tick,
    canaryTicks: effectiveFrozenParams.canary_ticks,
    allWindowProvenance: plan.map((e) => e.provenance),
  });

  const outPath = path.resolve(repo, args.out);
  const summaryPath = path.resolve(repo, args.summary);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, renderMarkdownSummary(report));

  console.log(`[run-comparator-baseline] wrote ${outPath}`);
  console.log(`[run-comparator-baseline] wrote ${summaryPath}`);
}

main();
