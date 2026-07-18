// tools/recalibrate/_recalibrate-refresh.ts — R2 Task 7. `refresh`
// orchestrator: load a bundle, select a trailing/explicit/full-bundle
// window out of it (Task 6's pure selection module), compile a
// candidate CompiledConfig against the selection (direct import of
// tools/calibrate's `main(argv)`, per the repo's tool-to-tool
// convention — no spawning), and chain into the existing `propose` path
// (`runPropose`) so a refresh candidate goes through the exact same
// readiness-gate / state-machine / event-emission pipeline any other
// candidate does.
//
// DOCUMENTED DEVIATION from D1 ("every subcommand handler runs
// sweepTimeouts first" — _recalibrate-cli.ts header): `--dry-run`
// SKIPS the sweep here. Dry-run's contract is zero store mutation;
// sweepTimeouts can write timeout-rejected candidate records and emit
// events, which would violate that contract. `runPropose` (invoked only
// on the non-dry-run path below) still runs its own sweep first, so the
// D1 discipline holds for every candidate that's actually written.
//
// Circularity note: this module imports `runPropose`/`HandlerResult`
// from `./_recalibrate-cli`, and Task 8 wires `_recalibrate-cli.ts`'s
// `refresh` dispatch case to import `runRefresh` from here — a genuine
// two-file CommonJS require cycle. Safe under Node's CJS semantics
// because every cross-reference is used inside a function body (called
// well after both modules finish loading), never at module-evaluation
// time; the alternative (reimplementing propose's gate-table/event-
// emission logic here) would duplicate real behavior instead of reusing
// it, which is the actual risk to avoid.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BaselineBundle, CompiledConfig } from '../../engine/types';
import type { ExclusionWindow } from '../../engine/recalibration/compare';
import type { CreationReason } from '../../engine/types/recalibration';
import type { LifecycleEventEmitter } from '../../engine/o0/lifecycle-events';
import { loadBundle } from '../calibrate/_calibrate-data-prep';
import { main as calibrateMain } from '../calibrate/_calibrate-main';
import {
  resolveWindow, selectBundleWindow, type RefreshWindow, type SelectionReport,
} from './_recalibrate-refresh-select';
import { buildProposedCandidate } from './_recalibrate-candidate';
import { sweepTimeouts } from './_recalibrate-sweep';
import { runPropose, type HandlerResult } from './_recalibrate-cli';
import { RecalibrationStore } from './_recalibrate-store';

export interface RefreshArgs {
  bundleDir: string;
  window?: string;
  windowStart?: string;
  windowEnd?: string;
  fullBundle?: boolean;
  alpha?: number;
  families?: string;
  candidateId?: string;
  creationReason?: 'operator_manual' | 'calendar_safety_net';
  outDir?: string;
  dryRun?: boolean;
  now?: string;
}

const CANONICAL_FAMILY_ORDER = ['A', 'B', 'C', 'D', 'E'];

function nowOrDefault(nowIso?: string): string {
  return nowIso ?? new Date().toISOString();
}

function readCompiledConfig(filePath: string): CompiledConfig {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CompiledConfig;
}

/** `2026-07-10T00:00:00.000Z` -> `20260710T000000Z` — compact-ISO
 *  candidate-id default suffix (plan §B Task 7 example). */
function compactIso(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function defaultFamiliesCsv(activeConfig: CompiledConfig): string {
  const perFamily = activeConfig.alpha_budget.per_family;
  return CANONICAL_FAMILY_ORDER.filter((f) => (perFamily[f] ?? 0) > 0).join(',');
}

function runTickCount(run: BaselineBundle['runs'][number]): number {
  return run.hour_of_day?.length ?? Object.values(run.signal_series)[0]?.length ?? 0;
}

function totalTicks(bundle: BaselineBundle): number {
  return bundle.runs.reduce((sum, r) => sum + runTickCount(r), 0);
}

function isBundleTimestamped(bundle: BaselineBundle): boolean {
  return bundle.tick_seconds !== undefined && bundle.runs.every((r) => r.start_iso !== undefined);
}

/** Timestamped `--full-bundle` with no declared start/end: derive the
 *  window from the min tick-0 instant and the max (last-tick + 1 tick)
 *  instant across every run — the tightest half-open window covering
 *  every tick the bundle actually has. */
function deriveFullBundleWindow(bundle: BaselineBundle): RefreshWindow {
  const tickSeconds = bundle.tick_seconds as number;
  let minStart: string | null = null;
  let maxEnd: string | null = null;
  for (const run of bundle.runs) {
    const startIso = run.start_iso as string;
    const nTicks = runTickCount(run);
    const runEnd = new Date(new Date(startIso).getTime() + nTicks * tickSeconds * 1000).toISOString();
    if (minStart === null || startIso < minStart) minStart = startIso;
    if (maxEnd === null || runEnd > maxEnd) maxEnd = runEnd;
  }
  if (minStart === null || maxEnd === null) {
    throw new Error('refresh: --full-bundle on an empty bundle (no runs) has no derivable window');
  }
  return { start: minStart, end: maxEnd };
}

function resolveFullBundleWindow(bundle: BaselineBundle, args: RefreshArgs, timestamped: boolean): RefreshWindow {
  if (args.windowStart !== undefined && args.windowEnd !== undefined) {
    return { start: args.windowStart, end: args.windowEnd };
  }
  if (args.windowStart !== undefined || args.windowEnd !== undefined) {
    throw new Error('refresh: --full-bundle declared metadata requires both --window-start and --window-end');
  }
  if (timestamped) return deriveFullBundleWindow(bundle);
  throw new Error(
    'refresh: --full-bundle on a non-timestamped bundle requires --window-start and --window-end '
    + 'as declared metadata (bundle has no tick_seconds/start_iso to derive a window from)',
  );
}

function resolveFullBundleSelection(
  bundle: BaselineBundle, args: RefreshArgs,
): { selected: BaselineBundle; report: SelectionReport } {
  if (args.window !== undefined) {
    throw new Error('refresh: --full-bundle cannot be combined with --window (trailing window)');
  }
  const timestamped = isBundleTimestamped(bundle);
  const window = resolveFullBundleWindow(bundle, args, timestamped);
  const nTicks = totalTicks(bundle);
  return {
    selected: bundle,
    report: {
      window,
      window_mode: 'full_bundle',
      timestamped,
      n_runs_in: bundle.runs.length,
      n_ticks_in: nTicks,
      n_segments_out: bundle.runs.length,
      n_ticks_selected: nTicks,
      n_ticks_out_of_window: 0,
      n_ticks_excluded: 0,
      n_ticks_dropped_short_segment: 0,
      excluded_spans: [],
      exclusions_applied_at_selection: false,
      source_bundle_version: bundle.version,
    },
  };
}

function resolveWindowedSelection(
  bundle: BaselineBundle, args: RefreshArgs, exclusions: ExclusionWindow[], nowIso: string,
): { selected: BaselineBundle; report: SelectionReport } {
  const hasWindowFlag = args.window !== undefined;
  const hasExplicitFlags = args.windowStart !== undefined || args.windowEnd !== undefined;
  if (hasWindowFlag && hasExplicitFlags) {
    throw new Error('refresh: specify exactly one of --window, --window-start/--window-end, or --full-bundle');
  }
  if (!hasWindowFlag && !hasExplicitFlags) {
    throw new Error('refresh: exactly one of --window, --window-start/--window-end, or --full-bundle is required');
  }
  const windowMode: 'trailing' | 'explicit' = hasWindowFlag ? 'trailing' : 'explicit';
  const window = resolveWindow(
    { window: args.window, windowStart: args.windowStart, windowEnd: args.windowEnd }, nowIso,
  );
  return selectBundleWindow(bundle, window, exclusions, { windowMode });
}

/** Window resolution dispatch (plan §B Task 7 step 3): exactly one of
 *  `--window` | (`--window-start`+`--window-end`) | `--full-bundle`. */
function resolveSelection(
  bundle: BaselineBundle, args: RefreshArgs, exclusions: ExclusionWindow[], nowIso: string,
): { selected: BaselineBundle; report: SelectionReport } {
  return args.fullBundle
    ? resolveFullBundleSelection(bundle, args)
    : resolveWindowedSelection(bundle, args, exclusions, nowIso);
}

function ensureNoCandidateCollision(store: RecalibrationStore, candidateId: string): void {
  try {
    store.readCandidate(candidateId);
  } catch (_err) {
    return; // no such candidate -- no collision.
  }
  throw new Error(`refresh: candidate '${candidateId}' already exists — choose a different --candidate-id`);
}

/** Write `outDir/selected-bundle/{bundle.jsonl,manifest.json}` +
 *  `outDir/selection-report.json`. Deterministic given `bundle`/
 *  `selected`/`report`/`candidateId`/`nowIso`. */
function materializeSelectedBundle(
  outDir: string, bundle: BaselineBundle, selected: BaselineBundle, report: SelectionReport,
  candidateId: string, nowIso: string,
): { selectedDir: string } {
  const selectedDir = path.join(outDir, 'selected-bundle');
  fs.mkdirSync(selectedDir, { recursive: true });
  const jsonl = selected.runs.map((r) => JSON.stringify(r)).join('\n') + (selected.runs.length > 0 ? '\n' : '');
  fs.writeFileSync(path.join(selectedDir, 'bundle.jsonl'), jsonl);

  const manifest: Record<string, unknown> = {
    version: `${bundle.version}-refresh-${candidateId}`,
    generated_at: nowIso,
    seed: bundle.seed,
    n_runs: selected.runs.length,
    refresh_selection: report,
  };
  if (bundle.cell_dim !== undefined) manifest.cell_dim = bundle.cell_dim;
  if (selected.tick_seconds !== undefined) manifest.tick_seconds = selected.tick_seconds;
  if (bundle.baseline_provenance !== undefined) manifest.baseline_provenance = bundle.baseline_provenance;
  fs.writeFileSync(path.join(selectedDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  fs.writeFileSync(path.join(outDir, 'selection-report.json'), JSON.stringify(report, null, 2) + '\n');
  return { selectedDir };
}

function selectionReportLines(report: SelectionReport, candidateConfigPath: string): string[] {
  return [
    `resolved window: ${report.window.start} .. ${report.window.end} `
      + `(mode=${report.window_mode}, timestamped=${report.timestamped})`,
    `ticks: in=${report.n_ticks_in} selected=${report.n_ticks_selected} `
      + `out_of_window=${report.n_ticks_out_of_window} excluded=${report.n_ticks_excluded} `
      + `dropped_short_segment=${report.n_ticks_dropped_short_segment}`,
    ...report.excluded_spans.map((s) => `  exclusion [${s.window.start}, ${s.window.end}): `
      + `dropped ${s.n_ticks_dropped} tick(s) across ${s.n_runs_affected} run(s)`),
    `compiled candidate config: ${candidateConfigPath}`,
  ];
}

/** `--dry-run`: evaluate readiness gates read-only (`buildProposedCandidate`
 *  does no store writes) and print the would-be gate table + classification.
 *  No candidate write, no events, no sweep (see module header). Always
 *  exit 0 — this is a preview, not a decision. */
function runDryRunPreview(
  store: RecalibrationStore, candidateId: string, candidateConfigPath: string,
  creationReason: CreationReason, sourceWindow: { start: string; end: string; n_samples: number },
  nowIso: string, selectionAppliedExclusions: ExclusionWindow[] | undefined, lines: string[],
): HandlerResult {
  const outcome = buildProposedCandidate({
    store, candidateId, candidateConfigPath, creationReason, sourceWindow, nowIso, selectionAppliedExclusions,
  });
  const gateLines = Object.entries(outcome.readiness)
    .filter(([k]) => k !== 'all_passed')
    .map(([gate, passed]) => `  ${gate}: ${passed ? 'PASS' : 'FAIL'}`);
  return {
    exitCode: 0,
    lines: [
      ...lines,
      `[dry-run] candidate '${candidateId}' would be proposed (${outcome.record.direction_classification}); `
        + `readiness gates (all_passed=${outcome.accepted}):`,
      ...gateLines,
    ],
  };
}

export async function runRefresh(
  store: RecalibrationStore, emitter: LifecycleEventEmitter, args: RefreshArgs,
): Promise<HandlerResult> {
  const nowIso = nowOrDefault(args.now);
  const preLines: string[] = [];

  if (!args.dryRun) {
    await sweepTimeouts(store, emitter, nowIso);
  } else {
    preLines.push(
      '[dry-run] skipping sweepTimeouts — dry-run performs zero store mutation, which '
      + 'trumps D1 sweep-first discipline (deliberate deviation; see module header)',
    );
  }

  const meta = store.readMeta();
  const active = store.readActive();
  if (!active) {
    throw new Error(
      `refresh: service '${meta.service_id}' has no active baseline yet — bootstrap active.json before proposing candidates`,
    );
  }

  const bundle = loadBundle(args.bundleDir);
  const declaredExclusions = store.readExclusionWindows();
  const { selected, report } = resolveSelection(bundle, args, declaredExclusions, nowIso);

  const candidateId = args.candidateId ?? `refresh-${compactIso(report.window.end)}`;
  ensureNoCandidateCollision(store, candidateId);

  const outDir = args.outDir ?? path.join(store.dir, 'refresh', candidateId);
  const { selectedDir } = materializeSelectedBundle(outDir, bundle, selected, report, candidateId, nowIso);

  const activeConfig = readCompiledConfig(active.compiled_config_path);
  const alpha = args.alpha ?? activeConfig.alpha_budget.total;
  const families = args.families ?? defaultFamiliesCsv(activeConfig);
  const candidateConfigPath = path.join(outDir, 'candidate-config.json');
  await calibrateMain([
    '--baseline', selectedDir,
    '--alpha', String(alpha),
    '--out', candidateConfigPath,
    '--families', families,
    '--version_suffix', `refresh-${candidateId}`,
  ]);

  const lines = [...preLines, ...selectionReportLines(report, candidateConfigPath)];
  const creationReason: CreationReason = args.creationReason ?? 'operator_manual';
  const selectionAppliedExclusions = report.exclusions_applied_at_selection ? declaredExclusions : undefined;
  const sourceWindow = { start: report.window.start, end: report.window.end, n_samples: report.n_ticks_selected };

  if (args.dryRun) {
    return runDryRunPreview(
      store, candidateId, candidateConfigPath, creationReason, sourceWindow, nowIso,
      selectionAppliedExclusions, lines,
    );
  }

  const proposeResult = await runPropose(store, emitter, {
    candidateId, candidateConfigPath, creationReason, sourceWindow, now: nowIso, selectionAppliedExclusions,
  });
  return {
    exitCode: proposeResult.exitCode,
    lines: [...lines, `candidate id: ${candidateId}`, ...proposeResult.lines],
  };
}
