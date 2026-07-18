// tools/recalibrate/_recalibrate-refresh-select.ts — R2 Task 6. Pure
// selection over an in-memory BaselineBundle: given a caller-supplied
// [start, end) window and a set of declared exclusion windows, produce
// the subset of ticks that should feed a refresh compile, plus a
// machine-readable SelectionReport documenting exactly what was
// dropped and why.
//
// I/O-free (no fs reads/writes here — `tools/recalibrate/
// _recalibrate-refresh.ts`, Task 7, owns loading the source bundle and
// materializing the selected one to disk) so this module stays pure and
// keeps the arch-invariants fan-in/complexity ratchets happy.
//
// Timestamp semantics (mirrors engine/types/_config-baseline-bundle.ts's
// BaselineBundle doc comment, R2 Task 2): a bundle is "timestamped" iff
// `tick_seconds` is present on the bundle AND every run carries
// `start_iso`. Tick `t` of a run occupies the half-open instant
// `start_iso + t * tick_seconds`; membership against both the requested
// window and every declared exclusion window uses half-open [start, end)
// lexicographic ISO-8601 comparison — the same convention
// engine/recalibration/compare.ts's `windowsOverlap` uses, so a tick
// sitting exactly on a window's `end` (or an exclusion's `end`) is NOT
// inside it.
//
// Per-run algorithm: classify every tick as out-of-window, excluded (by
// at least one declared exclusion), or kept; split the kept ticks into
// maximal contiguous segments (contiguous in the run's own original
// tick-index space); drop any segment shorter than `minSegmentTicks`
// (plan §C OQ2 default 2 — 1-tick segments contribute nothing to
// AR(1)/ACF estimation); emit every surviving segment as its own run
// (sliced `signal_series`/`hour_of_day`/`day_of_week`, preserved
// `tenant_id`, a freshly computed `start_iso` for the segment's first
// tick). Deterministic: preserves run order, performs no wall-clock
// reads, and never mutates its inputs.

import type { BaselineBundle } from '../../engine/types';
import type { ExclusionWindow } from '../../engine/recalibration/compare';

export interface RefreshWindow {
  start: string;
  end: string;
}

export interface ExcludedSpanReport {
  window: ExclusionWindow;
  n_ticks_dropped: number;
  n_runs_affected: number;
}

export interface SelectionReport {
  window: RefreshWindow;
  window_mode: 'trailing' | 'explicit' | 'full_bundle';
  timestamped: boolean;
  n_runs_in: number;
  n_ticks_in: number;
  n_segments_out: number;
  n_ticks_selected: number;
  n_ticks_out_of_window: number;
  n_ticks_excluded: number;
  n_ticks_dropped_short_segment: number;
  /** One entry per declared exclusion window (input array order
   *  preserved), regardless of whether it actually overlapped anything
   *  selected — a non-overlapping exclusion reports zero drops. */
  excluded_spans: ExcludedSpanReport[];
  /** False only for the full-bundle/non-timestamped orchestrator path
   *  (Task 7), which never calls this module at all; always true on any
   *  report this function returns (it throws rather than produce a
   *  false one). */
  exclusions_applied_at_selection: boolean;
  source_bundle_version: string;
}

/** OQ-2 default — override via `selectBundleWindow`'s opts only, no CLI
 *  flag (plan §C OQ2). */
const MIN_SEGMENT_TICKS = 2;

const TRAILING_WINDOW_RE = /^trailing-(\d+)d$/;

/** Resolve a refresh window from CLI-shaped flags. Exactly one of
 *  `window` (a `trailing-<Nd>` token, end anchored at `nowIso`) or the
 *  pair `windowStart`+`windowEnd` (passed through verbatim) must be
 *  supplied — anything else (both, or neither) throws. Does not
 *  validate against a bundle; `--full-bundle` mode (Task 7) never calls
 *  this. */
export function resolveWindow(
  flags: { window?: string; windowStart?: string; windowEnd?: string },
  nowIso: string,
): RefreshWindow {
  const hasTrailing = flags.window !== undefined;
  const hasExplicit = flags.windowStart !== undefined || flags.windowEnd !== undefined;
  if (hasTrailing && hasExplicit) {
    throw new Error(
      'resolveWindow: specify exactly one of --window trailing-<Nd> or '
      + '--window-start/--window-end, not both',
    );
  }
  if (hasTrailing) {
    const m = TRAILING_WINDOW_RE.exec(flags.window as string);
    if (!m) {
      throw new Error(
        `resolveWindow: --window must match trailing-<Nd> (e.g. 'trailing-14d'); got '${flags.window}'`,
      );
    }
    const days = parseInt(m[1], 10);
    const end = nowIso;
    const start = new Date(new Date(nowIso).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    return { start, end };
  }
  if (flags.windowStart !== undefined && flags.windowEnd !== undefined) {
    return { start: flags.windowStart, end: flags.windowEnd };
  }
  throw new Error(
    'resolveWindow: requires either --window trailing-<Nd> or both --window-start and --window-end',
  );
}

function tickInstant(startIso: string, tick: number, tickSeconds: number): string {
  return new Date(new Date(startIso).getTime() + tick * tickSeconds * 1000).toISOString();
}

function inHalfOpenWindow(instant: string, w: { start: string; end: string }): boolean {
  return instant >= w.start && instant < w.end;
}

/** Bundle-level timestamp-eligibility check (module header semantics).
 *  Distinguishes "fully absent" from "mixed presence" purely for a more
 *  actionable error message — both are equally "not timestamped". */
function checkTimestamped(bundle: BaselineBundle): { ok: true } | { ok: false; reason: string } {
  const hasTickSeconds = bundle.tick_seconds !== undefined;
  const runsWithStartIso = bundle.runs.filter((r) => r.start_iso !== undefined).length;
  const allHaveStartIso = runsWithStartIso === bundle.runs.length;
  const noneHaveStartIso = runsWithStartIso === 0;
  if (hasTickSeconds && allHaveStartIso) return { ok: true };
  if (!hasTickSeconds && noneHaveStartIso) {
    return {
      ok: false,
      reason: "bundle carries neither manifest.tick_seconds nor any run's start_iso "
        + '— not timestamped; pass --full-bundle to select the entire bundle without window filtering',
    };
  }
  if (!hasTickSeconds) {
    return {
      ok: false,
      reason: "bundle is missing manifest.tick_seconds (runs do carry start_iso) "
        + '— not timestamped; pass --full-bundle to select the entire bundle without window filtering',
    };
  }
  return {
    ok: false,
    reason: `bundle carries manifest.tick_seconds but ${bundle.runs.length - runsWithStartIso} of `
      + `${bundle.runs.length} run(s) are missing start_iso — mixed timestamp presence is an error; `
      + 'pass --full-bundle to select the entire bundle without window filtering',
  };
}

function runTickCount(run: BaselineBundle['runs'][number]): number {
  return run.hour_of_day?.length ?? Object.values(run.signal_series)[0]?.length ?? 0;
}

function sliceOptionalArray(arr: number[] | undefined, start: number, end: number): number[] | undefined {
  return arr ? arr.slice(start, end) : undefined;
}

/** Slice one run down to `[start, end)` (original tick-index space),
 *  recomputing `start_iso` for the segment's own tick 0. */
function sliceRunSegment(
  run: BaselineBundle['runs'][number], start: number, end: number, tickSeconds: number,
): BaselineBundle['runs'][number] {
  const signal_series: Record<string, number[]> = {};
  for (const [signal, values] of Object.entries(run.signal_series)) {
    signal_series[signal] = values.slice(start, end);
  }
  const out: BaselineBundle['runs'][number] = {
    signal_series,
    start_iso: tickInstant(run.start_iso as string, start, tickSeconds),
  };
  if (run.tenant_id !== undefined) out.tenant_id = run.tenant_id;
  const hod = sliceOptionalArray(run.hour_of_day, start, end);
  if (hod !== undefined) out.hour_of_day = hod;
  const dow = sliceOptionalArray(run.day_of_week, start, end);
  if (dow !== undefined) out.day_of_week = dow;
  return out;
}

/** Per-run tick classification + contiguous-segment emission. Mutates
 *  none of its inputs; accumulates onto the caller's counters via the
 *  returned per-run tallies. */
function processRun(
  run: BaselineBundle['runs'][number],
  window: RefreshWindow,
  exclusions: ExclusionWindow[],
  tickSeconds: number,
  minSegmentTicks: number,
  perExclusionTicks: number[],
  perExclusionRuns: Array<Set<number>>,
  runIdx: number,
): {
  outRuns: Array<BaselineBundle['runs'][number]>;
  n_ticks_out_of_window: number;
  n_ticks_excluded: number;
  n_ticks_dropped_short_segment: number;
} {
  const nTicks = runTickCount(run);
  const startIso = run.start_iso as string;
  const keepFlags: boolean[] = new Array(nTicks);
  let outOfWindow = 0;
  let excludedCount = 0;

  for (let t = 0; t < nTicks; t++) {
    const instant = tickInstant(startIso, t, tickSeconds);
    if (!inHalfOpenWindow(instant, window)) {
      outOfWindow += 1;
      keepFlags[t] = false;
      continue;
    }
    let excludedByAny = false;
    exclusions.forEach((w, wi) => {
      if (inHalfOpenWindow(instant, w)) {
        excludedByAny = true;
        perExclusionTicks[wi] += 1;
        perExclusionRuns[wi].add(runIdx);
      }
    });
    if (excludedByAny) {
      excludedCount += 1;
      keepFlags[t] = false;
    } else {
      keepFlags[t] = true;
    }
  }

  const outRuns: Array<BaselineBundle['runs'][number]> = [];
  let droppedShort = 0;
  let segStart: number | null = null;
  for (let t = 0; t <= nTicks; t++) {
    const keep = t < nTicks && keepFlags[t];
    if (keep && segStart === null) segStart = t;
    if (!keep && segStart !== null) {
      const segEnd = t;
      const segLen = segEnd - segStart;
      if (segLen < minSegmentTicks) {
        droppedShort += segLen;
      } else {
        outRuns.push(sliceRunSegment(run, segStart, segEnd, tickSeconds));
      }
      segStart = null;
    }
  }

  return {
    outRuns,
    n_ticks_out_of_window: outOfWindow,
    n_ticks_excluded: excludedCount,
    n_ticks_dropped_short_segment: droppedShort,
  };
}

/** Select the subset of `bundle` inside `window`, with any tick
 *  overlapping a declared `exclusions` window dropped — see module
 *  header for the full window/exclusion/segment-split semantics.
 *  Throws when `bundle` isn't timestamped (module header definition);
 *  the thrown message names the missing field(s) and the `--full-bundle`
 *  remedy. */
export function selectBundleWindow(
  bundle: BaselineBundle,
  window: RefreshWindow,
  exclusions: ExclusionWindow[],
  opts: { minSegmentTicks?: number; windowMode?: 'trailing' | 'explicit' } = {},
): { selected: BaselineBundle; report: SelectionReport } {
  const tsCheck = checkTimestamped(bundle);
  if (!tsCheck.ok) {
    throw new Error(`selectBundleWindow: ${tsCheck.reason}`);
  }
  const tickSeconds = bundle.tick_seconds as number;
  const minSegmentTicks = opts.minSegmentTicks ?? MIN_SEGMENT_TICKS;

  let n_ticks_in = 0;
  let n_ticks_out_of_window = 0;
  let n_ticks_excluded = 0;
  let n_ticks_dropped_short_segment = 0;
  const outRuns: Array<BaselineBundle['runs'][number]> = [];
  const perExclusionTicks = exclusions.map(() => 0);
  const perExclusionRuns: Array<Set<number>> = exclusions.map(() => new Set<number>());

  bundle.runs.forEach((run, runIdx) => {
    n_ticks_in += runTickCount(run);
    const result = processRun(
      run, window, exclusions, tickSeconds, minSegmentTicks, perExclusionTicks, perExclusionRuns, runIdx,
    );
    outRuns.push(...result.outRuns);
    n_ticks_out_of_window += result.n_ticks_out_of_window;
    n_ticks_excluded += result.n_ticks_excluded;
    n_ticks_dropped_short_segment += result.n_ticks_dropped_short_segment;
  });

  const excluded_spans: ExcludedSpanReport[] = exclusions.map((w, wi) => ({
    window: w,
    n_ticks_dropped: perExclusionTicks[wi],
    n_runs_affected: perExclusionRuns[wi].size,
  }));

  const n_ticks_selected = outRuns.reduce((sum, r) => sum + runTickCount(r), 0);

  const selected: BaselineBundle = {
    version: bundle.version,
    generated_at: bundle.generated_at,
    seed: bundle.seed,
    tick_seconds: tickSeconds,
    runs: outRuns,
  };
  if (bundle.cell_dim !== undefined) selected.cell_dim = bundle.cell_dim;
  if (bundle.baseline_provenance !== undefined) selected.baseline_provenance = bundle.baseline_provenance;

  const report: SelectionReport = {
    window,
    window_mode: opts.windowMode ?? 'explicit',
    timestamped: true,
    n_runs_in: bundle.runs.length,
    n_ticks_in,
    n_segments_out: outRuns.length,
    n_ticks_selected,
    n_ticks_out_of_window,
    n_ticks_excluded,
    n_ticks_dropped_short_segment,
    excluded_spans,
    exclusions_applied_at_selection: true,
    source_bundle_version: bundle.version,
  };

  return { selected, report };
}
