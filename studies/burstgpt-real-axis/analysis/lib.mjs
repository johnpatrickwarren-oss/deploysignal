// Shared estimators for the burstgpt-real-axis study (C56).
// Everything here is deterministic; the only randomness is mulberry32-seeded.
// No Date, no Math.random, no catch blocks — any exception aborts the run.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box–Muller over a seeded uniform stream.
export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function loadBundle(path) {
  const firstLine = readFileSync(path, 'utf8').split('\n')[0];
  const run = JSON.parse(firstLine);
  return {
    cost: run.signal_series.cost_req,
    counts: run.auxiliary_series.requests_per_tick,
    hod: run.hour_of_day,
    dow: run.day_of_week,
  };
}

export function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// §3 frame: within-cell residuals over observed ticks, cells = (hod, dow),
// cells with < minCellTicks observed ticks excluded. When `centre` is false
// (the frozen secondary), m_cell is replaced by the global observed mean.
export function buildFrame({ values, observed, hod, dow, minCellTicks, centre }) {
  const N = values.length;
  const cellId = new Int32Array(N);
  for (let t = 0; t < N; t++) cellId[t] = hod[t] * 7 + dow[t];

  const cellSum = new Map();
  for (let t = 0; t < N; t++) {
    if (!observed[t]) continue;
    const c = cellId[t];
    const e = cellSum.get(c) ?? { sum: 0, n: 0 };
    e.sum += values[t];
    e.n += 1;
    cellSum.set(c, e);
  }

  let globalSum = 0;
  let globalN = 0;
  for (const e of cellSum.values()) {
    globalSum += e.sum;
    globalN += e.n;
  }
  const globalMean = globalSum / globalN;

  // A zero-mean cell cannot support the multiplicative residual v/m − 1 (and
  // carries zero variance); it is excluded like an under-populated cell.
  // Defect fix 2026-08-19 (run-20260819T020655Z): six all-idle (hod,dow)
  // cells in requests_per_tick made m_cell = 0 and poisoned endpoint R with
  // NaN. Reported via zeroMeanCells.
  const included = new Set();
  let excludedCells = 0;
  let excludedTicks = 0;
  let zeroMeanCells = 0;
  for (const [c, e] of cellSum) {
    if (e.n >= minCellTicks && e.sum > 0) included.add(c);
    else {
      excludedCells += 1;
      excludedTicks += e.n;
      if (e.sum === 0) zeroMeanCells += 1;
    }
  }

  // d_t = v_t/m_cell − 1 at usable ticks; NaN elsewhere. usable[] marks them.
  const d = new Float64Array(N).fill(NaN);
  const mcell = new Float64Array(N).fill(NaN);
  const usable = new Uint8Array(N);
  let nUsable = 0;
  for (let t = 0; t < N; t++) {
    if (!observed[t] || !included.has(cellId[t])) continue;
    const m = centre ? cellSum.get(cellId[t]).sum / cellSum.get(cellId[t]).n : globalMean;
    mcell[t] = m;
    d[t] = values[t] / m - 1;
    usable[t] = 1;
    nUsable += 1;
  }

  return {
    d, mcell, usable, cellId, nUsable,
    includedCells: included.size, excludedCells, excludedTicks, zeroMeanCells, globalMean,
  };
}

// §4-S: pairwise-complete ACF at true lags, pairs within the same cell.
export function pairwiseAcf(frame, maxLag) {
  const { d, usable, cellId } = frame;
  const N = d.length;
  let s2 = 0;
  let n0 = 0;
  for (let t = 0; t < N; t++) {
    if (usable[t]) { s2 += d[t] * d[t]; n0 += 1; }
  }
  const sigma2 = s2 / n0;
  const rho = [];
  for (let k = 1; k <= maxLag; k++) {
    let num = 0;
    let n = 0;
    for (let t = 0; t + k < N; t++) {
      if (usable[t] && usable[t + k] && cellId[t] === cellId[t + k]) {
        num += d[t] * d[t + k];
        n += 1;
      }
    }
    rho.push({ lag: k, rho: n > 0 ? num / n / sigma2 : NaN, pairs: n });
  }
  return { rho, sigma2, nObs: n0 };
}

// §4-S step 3: OLS slope of d_{t+1} on d_t through the origin over P_1.
export function phiHat(frame) {
  const { d, usable, cellId } = frame;
  const N = d.length;
  let num = 0;
  let den = 0;
  let n = 0;
  for (let t = 0; t + 1 < N; t++) {
    if (usable[t] && usable[t + 1] && cellId[t] === cellId[t + 1]) {
      num += d[t] * d[t + 1];
      den += d[t] * d[t];
      n += 1;
    }
  }
  return { phi: num / den, pairs: n };
}

// §4-S step 4: circular moving-block bootstrap CI on φ̂. Blocks carry
// (d, usable, cell) jointly; pairs form only inside a block and only where
// the lattice index does not wrap, so every pair is a real 5 s adjacency.
export function bootstrapPhiCI(frame, { blockLen, nBoot, seed }) {
  const { d, usable, cellId } = frame;
  const N = d.length;
  const nBlocks = Math.ceil(N / blockLen);
  const rng = mulberry32(seed);
  const phis = new Float64Array(nBoot);
  for (let b = 0; b < nBoot; b++) {
    let num = 0;
    let den = 0;
    for (let j = 0; j < nBlocks; j++) {
      const start = Math.floor(rng() * N);
      const end = Math.min(start + blockLen, N); // no wrap: a wrapped pair is not a real adjacency
      for (let t = start; t + 1 < end; t++) {
        if (usable[t] && usable[t + 1] && cellId[t] === cellId[t + 1]) {
          num += d[t] * d[t + 1];
          den += d[t] * d[t];
        }
      }
    }
    phis[b] = den > 0 ? num / den : NaN;
  }
  const sorted = Array.from(phis).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { lo: q(0.025), hi: q(0.975), nEffective: sorted.length };
}

// §4-D: OLS of e² on 1/n; shares; binned adequacy; Spearman diagnostic.
export function decompose({ values, counts, usable, mcell }) {
  const N = values.length;
  const y = [];
  const invN = [];
  const ns = [];
  const xs = [];
  for (let t = 0; t < N; t++) {
    if (!usable[t]) continue;
    const e = values[t] - mcell[t];
    y.push(e * e);
    invN.push(1 / counts[t]);
    ns.push(counts[t]);
    xs.push(values[t]);
  }
  const n = y.length;
  const mInv = mean(invN);
  const mY = mean(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (invN[i] - mInv) ** 2;
    sxy += (invN[i] - mInv) * (y[i] - mY);
  }
  const slope = sxy / sxx; // b̂ → σ²_W
  const intercept = mY - slope * mInv; // â → σ²_B
  const share = (slope * mInv) / (intercept + slope * mInv); // ŝ

  // Frozen bins: 1,2,3,4,5,6–10,≥11; floor 200 ticks; Pearson(binned mean y, â+b̂/n̄_bin) ≥ 0.5.
  const binOf = (c) => (c <= 5 ? String(c) : c <= 10 ? '6-10' : '11+');
  const bins = new Map();
  for (let i = 0; i < n; i++) {
    const key = binOf(ns[i]);
    const e = bins.get(key) ?? { sumY: 0, sumN: 0, count: 0 };
    e.sumY += y[i];
    e.sumN += ns[i];
    e.count += 1;
    bins.set(key, e);
  }
  const surviving = [];
  for (const [key, e] of bins) {
    if (e.count >= 200) {
      const nBar = e.sumN / e.count;
      surviving.push({ bin: key, count: e.count, meanY: e.sumY / e.count, fitted: intercept + slope / nBar, nBar });
    }
  }
  const adequacy = surviving.length >= 3 ? pearson(surviving.map((b) => b.meanY), surviving.map((b) => b.fitted)) : NaN;

  return {
    intercept, slope, share, meanInvN: mInv, nTicks: n,
    totalWithinCellVar: mY,
    bins: surviving, survivingBins: surviving.length, adequacyPearson: adequacy,
    spearmanCostOccupancy: spearman(xs, ns),
  };
}

export function pearson(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
  const r = new Float64Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return Array.from(r);
}

export function spearman(a, b) {
  return pearson(ranks(a), ranks(b));
}

// §4-R step 2: hour-of-day profile of a fully observed series; amplitude and
// split-half replication. Rotation-invariant statistics only.
export function hourProfile(values, hod) {
  const N = values.length;
  const profileOf = (from, to) => {
    const sum = new Float64Array(24);
    const n = new Float64Array(24);
    for (let t = from; t < to; t++) {
      sum[hod[t]] += values[t];
      n[hod[t]] += 1;
    }
    const cellMeans = [];
    for (let h = 0; h < 24; h++) cellMeans.push(sum[h] / n[h]);
    const grand = mean(cellMeans);
    return cellMeans.map((m) => m / grand);
  };
  const full = profileOf(0, N);
  const amplitude = (Math.max(...full) - Math.min(...full)) / mean(full);
  const half = Math.floor(N / 2);
  const splitCorr = pearson(profileOf(0, half), profileOf(half, N));
  return { profile: full, amplitude, splitHalfPearson: splitCorr };
}

// I3's naive estimator: standard mean-centred full-series ACF, zero-fills and all.
export function naiveAcf(series, maxLag) {
  const m = mean(series);
  const N = series.length;
  let v = 0;
  for (let t = 0; t < N; t++) v += (series[t] - m) ** 2;
  const out = [];
  for (let k = 1; k <= maxLag; k++) {
    let num = 0;
    for (let t = 0; t + k < N; t++) num += (series[t] - m) * (series[t + k] - m);
    out.push(num / v);
  }
  return out;
}
