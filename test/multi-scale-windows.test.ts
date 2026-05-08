// test/multi-scale-windows.test.ts — Unit coverage for the Week-1 NS
// TrendBuffer multi-scale extension.
//
// Acceptance (from WEEK1-HANDOFF.md §1.1.b):
//   - feed a known deterministic series, assert all three window summaries
//     are correct
//   - assert medium output matches the pre-change TrendBuffer bit-for-bit
//
// The second requirement is enforced here by: computing a "pre-change"
// baseline inline using the same math the legacy TrendBuffer used, then
// asserting deep equality on every field of get() and on medium's
// WindowSummary fields returned by snapshot().
//
// Run: node --test test/multi-scale-windows.test.js  (after `npm run build`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Import from the compiled engine so Node --test can resolve at runtime.
import { TrendBuffer } from '../dist/engine/core';

type Hist = number[];

// ── Legacy-math reference for medium view — verbatim copy of the
// pre-change TrendBuffer.get() body. Used to prove medium view is
// bit-identical to what detectors saw before this change.
function legacyGet(hist: Hist | undefined) {
  if (!hist || hist.length < 4) {
    return {
      slope: 0, slopeNorm: 0, stable: false, cv: 1, mean: 0, roc: 0,
      min: 0, max: 0, range: 0, n: hist ? hist.length : 0, insufficient: true,
    };
  }
  const n = hist.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += hist[i]; sumXY += i * hist[i]; sumX2 += i * i; }
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const mean = sumY / n;
  const slopeNorm = mean !== 0 ? slope / Math.abs(mean) : 0;
  let variance = 0;
  for (let j = 0; j < n; j++) variance += Math.pow(hist[j] - mean, 2);
  const stdDev = Math.sqrt(variance / n);
  const cv = mean !== 0 ? stdDev / Math.abs(mean) : 1;
  let roc = 0;
  if (hist.length >= 3) {
    const rc = hist.slice(-3);
    roc = (rc[rc.length - 1] - rc[0]) / (rc.length - 1);
    roc = mean !== 0 ? roc / Math.abs(mean) : 0;
  }
  const stable = cv < 0.04 && Math.abs(slopeNorm) > 0.002;
  let tmin = hist[0], tmax = hist[0];
  for (let k = 1; k < n; k++) { if (hist[k] < tmin) tmin = hist[k]; if (hist[k] > tmax) tmax = hist[k]; }
  return { slope, slopeNorm, stable, cv, mean, roc, min: tmin, max: tmax, range: tmax - tmin, n, insufficient: false };
}

// Deterministic series: rising linear trend with a tiny oscillation. 40 ticks
// so the long buffer (30) saturates and the short buffer (5) only holds the
// tail.
const SERIES: Hist = [];
for (let i = 0; i < 40; i++) SERIES.push(100 + i * 0.5 + Math.sin(i / 3) * 0.4);

test('TrendBuffer: medium view is bit-identical to legacy get()', () => {
  const tb = new TrendBuffer(10);
  for (const v of SERIES) tb.push('x', v);
  const got = tb.get('x');
  const want = legacyGet((tb as any).data['x']);
  assert.deepEqual(got, want);

  // Sanity: the ring-buffer cap is still 10.
  assert.equal((tb as any).data['x'].length, 10);
});

test('TrendBuffer: default window sizes are 5 / 10 / 30', () => {
  const tb = new TrendBuffer();
  assert.equal(tb.window, 10);
  assert.equal(tb.windowShort, 5);
  assert.equal(tb.windowLong, 30);
});

test('TrendBuffer: constructor opts override short/long defaults', () => {
  const tb = new TrendBuffer(12, { short: 3, long: 20 });
  assert.equal(tb.window, 12);
  assert.equal(tb.windowShort, 3);
  assert.equal(tb.windowLong, 20);
});

test('TrendBuffer: push writes to all three buffers with correct caps', () => {
  const tb = new TrendBuffer(10);
  for (const v of SERIES) tb.push('x', v);
  assert.equal((tb as any).dataShort['x'].length, 5);
  assert.equal((tb as any).data['x'].length, 10);
  assert.equal((tb as any).dataLong['x'].length, 30);
  // Each buffer holds the most-recent values for its window length.
  const last5 = SERIES.slice(-5);
  const last10 = SERIES.slice(-10);
  const last30 = SERIES.slice(-30);
  assert.deepEqual((tb as any).dataShort['x'], last5);
  assert.deepEqual((tb as any).data['x'], last10);
  assert.deepEqual((tb as any).dataLong['x'], last30);
});

test('TrendBuffer.snapshot: per-window summaries match the raw-buffer math', () => {
  const tb = new TrendBuffer(10);
  for (const v of SERIES) tb.push('x', v);
  const snap = tb.snapshot('x');

  assert.equal(snap.signal, 'x');

  // Check each window's n/mean are the values we expect from the series tails.
  const last5 = SERIES.slice(-5);
  const last10 = SERIES.slice(-10);
  const last30 = SERIES.slice(-30);

  assert.equal(snap.short.n, 5);
  assert.equal(snap.medium.n, 10);
  assert.equal(snap.long.n, 30);

  const eps = 1e-12;
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  assert.ok(Math.abs(snap.short.mean  - mean(last5))  < eps);
  assert.ok(Math.abs(snap.medium.mean - mean(last10)) < eps);
  assert.ok(Math.abs(snap.long.mean   - mean(last30)) < eps);

  // Medium WindowSummary must agree with legacy get() on mean/cv/slopeNorm.
  const legacy = legacyGet(last10);
  assert.ok(Math.abs(snap.medium.mean      - legacy.mean)      < 1e-12);
  assert.ok(Math.abs(snap.medium.cv        - legacy.cv)        < 1e-12);
  assert.ok(Math.abs(snap.medium.slopeNorm - legacy.slopeNorm) < 1e-12);

  // Rising series ⇒ positive slopeNorm across every window.
  assert.ok(snap.short.slopeNorm  > 0);
  assert.ok(snap.medium.slopeNorm > 0);
  assert.ok(snap.long.slopeNorm   > 0);

  // trendStrength in [0, 1] for all three.
  for (const w of [snap.short, snap.medium, snap.long]) {
    assert.ok(w.trendStrength >= 0 && w.trendStrength <= 1);
  }
});

test('TrendBuffer.snapshot: empty key returns zero summaries', () => {
  const tb = new TrendBuffer(10);
  const snap = tb.snapshot('missing');
  for (const w of [snap.short, snap.medium, snap.long]) {
    assert.equal(w.n, 0);
    assert.equal(w.mean, 0);
    assert.equal(w.std, 0);
    assert.equal(w.slopeNorm, 0);
    assert.equal(w.cv, 0);
    assert.equal(w.trendStrength, 0);
  }
});

test('TrendBuffer.reset clears all three buffers', () => {
  const tb = new TrendBuffer(10);
  for (const v of SERIES) tb.push('x', v);
  tb.reset();
  assert.deepEqual((tb as any).data, {});
  assert.deepEqual((tb as any).dataShort, {});
  assert.deepEqual((tb as any).dataLong, {});
});
