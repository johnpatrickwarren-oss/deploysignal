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
  };
  const setters = cliFlagSetters(out);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--allow-nonregistered-params') { out.allowNonRegisteredParams = true; continue; }
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

// ── main ────────────────────────────────────────────────────────────

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const repo = repoRoot();
  const endpointsPath = path.resolve(repo, args.endpoints);
  const { spec, sha256 } = parseEndpointsFile(endpointsPath);

  const { overrides, armsOverride, mismatches } = checkFrozenParams(args, spec.frozen_params);

  if (armsOverride !== undefined) {
    const provided = [...armsOverride].sort();
    const frozenArms = [...spec.arms].sort();
    if (JSON.stringify(provided) !== JSON.stringify(frozenArms)) {
      mismatches.push(`--arms: CLI=${provided.join(',')} frozen arms=${frozenArms.join(',')}`);
    }
  }

  const nonRegisteredRun = mismatches.length > 0;
  if (nonRegisteredRun && !args.allowNonRegisteredParams) {
    console.error('[run-comparator-baseline] CLI arguments disagree with the frozen ' +
      'runs/comparator-baseline/ENDPOINTS.md parameters:');
    for (const m of mismatches) console.error(`  - ${m}`);
    console.error('Refusing to run. Pass --allow-nonregistered-params to run anyway ' +
      '(stamps non_registered_run:true into the report; smoke/test runs only).');
    process.exit(1);
  }
  if (nonRegisteredRun) {
    console.warn('[run-comparator-baseline] --allow-nonregistered-params: running with frozen-param ' +
      'mismatches (non_registered_run:true will be stamped into the report):');
    for (const m of mismatches) console.warn(`  - ${m}`);
  }

  const effectiveFrozenParams: FrozenParams = { ...spec.frozen_params, ...overrides };
  const effectiveSpec: EndpointsSpec = {
    ...spec,
    frozen_params: effectiveFrozenParams,
    arms: armsOverride ?? spec.arms,
  };

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
