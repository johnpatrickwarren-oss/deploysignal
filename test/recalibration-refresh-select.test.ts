// test/recalibration-refresh-select.test.ts — R2 Task 6.
//
// Pure unit tests for tools/recalibrate/_recalibrate-refresh-select.ts's
// `resolveWindow` + `selectBundleWindow` — no fs, no store, no compile.
// Fixture bundles are hand-built timestamped BaselineBundles (tick_seconds
// + per-run start_iso).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveWindow, selectBundleWindow,
} from '../tools/recalibrate/_recalibrate-refresh-select';
import type { BaselineBundle } from '../engine/types';
import type { ExclusionWindow } from '../engine/recalibration/compare';

const HOUR = 3600;

function tickSeries(n: number, base = 100): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function makeRun(
  startIso: string, nTicks: number, overrides: Partial<BaselineBundle['runs'][number]> = {},
): BaselineBundle['runs'][number] {
  return {
    tenant_id: 'aggregate',
    start_iso: startIso,
    signal_series: { p99_latency: tickSeries(nTicks) },
    ...overrides,
  };
}

function makeBundle(overrides: Partial<BaselineBundle> = {}): BaselineBundle {
  return {
    version: 'fixture-refresh-v1',
    generated_at: '2026-07-01T00:00:00.000Z',
    seed: 7,
    tick_seconds: HOUR,
    runs: [],
    ...overrides,
  };
}

// ── resolveWindow ────────────────────────────────────────────────────

test('resolveWindow: trailing-<Nd> resolves end=now, start=now-Nd', () => {
  const w = resolveWindow({ window: 'trailing-14d' }, '2026-07-15T00:00:00.000Z');
  assert.deepEqual(w, { start: '2026-07-01T00:00:00.000Z', end: '2026-07-15T00:00:00.000Z' });
});

test('resolveWindow: explicit window-start/window-end passes through verbatim', () => {
  const w = resolveWindow(
    { windowStart: '2026-06-01T00:00:00.000Z', windowEnd: '2026-06-08T00:00:00.000Z' },
    '2026-07-15T00:00:00.000Z',
  );
  assert.deepEqual(w, { start: '2026-06-01T00:00:00.000Z', end: '2026-06-08T00:00:00.000Z' });
});

test('resolveWindow: malformed --window value throws', () => {
  assert.throws(() => resolveWindow({ window: '2weeks' }, '2026-07-15T00:00:00.000Z'), /trailing-<Nd>/);
});

test('resolveWindow: both trailing and explicit given throws', () => {
  assert.throws(() => resolveWindow({
    window: 'trailing-14d', windowStart: '2026-06-01T00:00:00.000Z', windowEnd: '2026-06-08T00:00:00.000Z',
  }, '2026-07-15T00:00:00.000Z'), /not both/);
});

test('resolveWindow: neither trailing nor explicit given throws', () => {
  assert.throws(() => resolveWindow({}, '2026-07-15T00:00:00.000Z'), /requires either/);
});

// ── selectBundleWindow: boundary semantics ──────────────────────────

test('selectBundleWindow: tick at window.end is excluded (half-open), tick at exclusion.end is retained', () => {
  // 4 half-hour ticks: 00:00, 00:30, 01:00, 01:30.
  const bundle = makeBundle({
    tick_seconds: 1800,
    runs: [makeRun('2026-07-01T00:00:00.000Z', 4, { signal_series: { p99_latency: tickSeries(4) } })],
  });
  const window = { start: '2026-07-01T00:00:00.000Z', end: '2026-07-01T01:30:00.000Z' }; // excludes tick 3 (01:30)
  const exclusions: ExclusionWindow[] = [
    { start: '2026-07-01T00:30:00.000Z', end: '2026-07-01T01:00:00.000Z' }, // drops tick 1 (00:30) only
  ];
  const { selected, report } = selectBundleWindow(bundle, window, exclusions);

  assert.equal(report.n_ticks_in, 4);
  assert.equal(report.n_ticks_out_of_window, 1); // tick at 01:30
  assert.equal(report.n_ticks_excluded, 1); // tick at 00:30
  assert.equal(report.excluded_spans[0].n_ticks_dropped, 1);
  assert.equal(report.excluded_spans[0].n_runs_affected, 1);
  // Surviving ticks: 00:00 (segment of 1, dropped as short since default
  // MIN_SEGMENT_TICKS=2) and 01:00 (segment of 1, also dropped short).
  assert.equal(report.n_ticks_dropped_short_segment, 2);
  assert.equal(report.n_segments_out, 0);
  assert.equal(selected.runs.length, 0);
});

// ── mid-window exclusion split ───────────────────────────────────────

test('selectBundleWindow: mid-window exclusion splits one run into two segments with exact drop counts', () => {
  const bundle = makeBundle({
    runs: [makeRun('2026-07-01T00:00:00.000Z', 10, { signal_series: { p99_latency: tickSeries(10) } })],
  });
  const window = { start: '2026-07-01T00:00:00.000Z', end: '2026-07-01T10:00:00.000Z' }; // all 10 ticks in-window
  const exclusions: ExclusionWindow[] = [
    { start: '2026-07-01T04:00:00.000Z', end: '2026-07-01T06:00:00.000Z' }, // ticks 4, 5
  ];
  const { selected, report } = selectBundleWindow(bundle, window, exclusions);

  assert.equal(report.n_ticks_in, 10);
  assert.equal(report.n_ticks_out_of_window, 0);
  assert.equal(report.n_ticks_excluded, 2);
  assert.equal(report.excluded_spans.length, 1);
  assert.equal(report.excluded_spans[0].n_ticks_dropped, 2);
  assert.equal(report.excluded_spans[0].n_runs_affected, 1);
  assert.equal(report.n_segments_out, 2);
  assert.equal(report.n_ticks_selected, 8);
  assert.equal(report.n_ticks_dropped_short_segment, 0);

  assert.equal(selected.runs.length, 2);
  assert.equal(selected.runs[0].signal_series.p99_latency.length, 4);
  assert.deepEqual(selected.runs[0].signal_series.p99_latency, [100, 101, 102, 103]);
  assert.equal(selected.runs[0].start_iso, '2026-07-01T00:00:00.000Z');
  assert.equal(selected.runs[1].signal_series.p99_latency.length, 4);
  assert.deepEqual(selected.runs[1].signal_series.p99_latency, [106, 107, 108, 109]);
  assert.equal(selected.runs[1].start_iso, '2026-07-01T06:00:00.000Z');
});

// ── run fully excluded ───────────────────────────────────────────────

test('selectBundleWindow: a run fully covered by an exclusion contributes zero segments', () => {
  const bundle = makeBundle({
    runs: [
      makeRun('2026-07-01T00:00:00.000Z', 4, { tenant_id: 'excluded-run', signal_series: { p99_latency: tickSeries(4) } }),
      makeRun('2026-07-02T00:00:00.000Z', 4, { tenant_id: 'surviving-run', signal_series: { p99_latency: tickSeries(4, 200) } }),
    ],
  });
  const window = { start: '2026-07-01T00:00:00.000Z', end: '2026-07-03T00:00:00.000Z' };
  const exclusions: ExclusionWindow[] = [
    { start: '2026-07-01T00:00:00.000Z', end: '2026-07-01T04:00:00.000Z' }, // covers all 4 ticks of run 1
  ];
  const { selected, report } = selectBundleWindow(bundle, window, exclusions);

  assert.equal(report.n_ticks_excluded, 4);
  assert.equal(report.excluded_spans[0].n_ticks_dropped, 4);
  assert.equal(report.excluded_spans[0].n_runs_affected, 1);
  assert.equal(selected.runs.length, 1);
  assert.equal(selected.runs[0].tenant_id, 'surviving-run');
  assert.equal(report.n_segments_out, 1);
  assert.equal(report.n_ticks_selected, 4);
});

// ── short-segment drop accounting ────────────────────────────────────

test('selectBundleWindow: segments shorter than minSegmentTicks are dropped and counted, not emitted', () => {
  const bundle = makeBundle({
    runs: [makeRun('2026-07-01T00:00:00.000Z', 6, { signal_series: { p99_latency: tickSeries(6) } })],
  });
  const window = { start: '2026-07-01T00:00:00.000Z', end: '2026-07-01T06:00:00.000Z' };
  // Excludes tick 2 only, leaving segments [0,1] (len 2) and [3,4,5] (len 3)
  // -- both >= default minSegmentTicks=2. Use opts.minSegmentTicks:3 to
  // force the [0,1] segment to be dropped as short.
  const exclusions: ExclusionWindow[] = [
    { start: '2026-07-01T02:00:00.000Z', end: '2026-07-01T03:00:00.000Z' },
  ];
  const { selected, report } = selectBundleWindow(bundle, window, exclusions, { minSegmentTicks: 3 });

  assert.equal(report.n_ticks_dropped_short_segment, 2); // [0,1] dropped
  assert.equal(report.n_segments_out, 1); // only [3,4,5] survives
  assert.equal(report.n_ticks_selected, 3);
  assert.equal(selected.runs.length, 1);
  assert.deepEqual(selected.runs[0].signal_series.p99_latency, [103, 104, 105]);
});

// ── non-timestamped / mixed presence errors ──────────────────────────

test('selectBundleWindow: bundle without tick_seconds throws naming both missing fields + --full-bundle', () => {
  const bundle: BaselineBundle = {
    version: 'synthetic-v1', generated_at: '2026-07-01T00:00:00.000Z', seed: 1,
    runs: [{ signal_series: { p99_latency: [1, 2, 3] } }],
  };
  assert.throws(
    () => selectBundleWindow(bundle, { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' }, []),
    /tick_seconds/,
  );
  assert.throws(
    () => selectBundleWindow(bundle, { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' }, []),
    /--full-bundle/,
  );
});

test('selectBundleWindow: mixed start_iso presence (some runs missing it) throws', () => {
  const bundle = makeBundle({
    runs: [
      makeRun('2026-07-01T00:00:00.000Z', 3, { signal_series: { p99_latency: tickSeries(3) } }),
      { signal_series: { p99_latency: tickSeries(3) } }, // no start_iso
    ],
  });
  assert.throws(
    () => selectBundleWindow(bundle, { start: '2026-01-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' }, []),
    /start_iso/,
  );
});

// ── determinism ───────────────────────────────────────────────────────

test('selectBundleWindow: two invocations on the same inputs produce byte-identical selected bundle + report', () => {
  const bundle = makeBundle({
    runs: [
      makeRun('2026-07-01T00:00:00.000Z', 10, { signal_series: { p99_latency: tickSeries(10) } }),
      makeRun('2026-07-02T00:00:00.000Z', 10, { signal_series: { p99_latency: tickSeries(10, 500) } }),
    ],
  });
  const window = { start: '2026-07-01T00:00:00.000Z', end: '2026-07-03T00:00:00.000Z' };
  const exclusions: ExclusionWindow[] = [
    { start: '2026-07-01T04:00:00.000Z', end: '2026-07-01T06:00:00.000Z' },
  ];
  const run1 = selectBundleWindow(bundle, window, exclusions);
  const run2 = selectBundleWindow(bundle, window, exclusions);
  assert.deepEqual(run1.selected, run2.selected);
  assert.deepEqual(run1.report, run2.report);
});

// ── window_mode passthrough ──────────────────────────────────────────

test('selectBundleWindow: window_mode defaults to explicit, overridable via opts', () => {
  const bundle = makeBundle({
    runs: [makeRun('2026-07-01T00:00:00.000Z', 2, { signal_series: { p99_latency: tickSeries(2) } })],
  });
  const window = { start: '2026-07-01T00:00:00.000Z', end: '2026-07-01T02:00:00.000Z' };
  const { report: defaultReport } = selectBundleWindow(bundle, window, []);
  assert.equal(defaultReport.window_mode, 'explicit');
  assert.equal(defaultReport.timestamped, true);
  assert.equal(defaultReport.exclusions_applied_at_selection, true);
  assert.equal(defaultReport.source_bundle_version, 'fixture-refresh-v1');

  const { report: trailingReport } = selectBundleWindow(bundle, window, [], { windowMode: 'trailing' });
  assert.equal(trailingReport.window_mode, 'trailing');
});
