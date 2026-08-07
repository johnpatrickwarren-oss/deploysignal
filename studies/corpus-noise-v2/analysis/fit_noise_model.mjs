// fit_noise_model.mjs — C30 corpus noise model v2.
//
// Applies PREREGISTRATION.md §4 (method) and §5 (admissibility bars A1–A6) to the
// real baseline bundles in runs/baselines/, for the six Family A signals.
//
// Deterministic: seeded mulberry32(42) for the bootstrap. No Math.random.
// Read-only on the bundles; writes results/run-<UTC>/ and the artifact.
//
// Usage: node studies/corpus-noise-v2/analysis/fit_noise_model.mjs
// (run from the repo root)

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSource, barsFailedBy, SYNTHETIC_TIMESTAMP_BUNDLES } from './_source_selection.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const ROOT = join(STUDY, '..', '..');

// ── frozen constants (PREREGISTRATION.md) ─────────────────────────────────
const FAMILY_A_SIGNALS = [
  'p99_latency', 'ttft', 'eval_score', 'tool_success_rate', 'downstream_err', 'cost_req',
];
const KS_BAR = 0.05;          // §4 M.4 — fixed effect-size bar, not a significance test
const MIN_TICKS_FOR_PHI = 2000;   // §5 A4
const MIN_DIURNAL_CYCLES = 3;     // §5 A5
const MIN_DAYS_FOR_DOW = 14;      // §5 A5
const SEASONAL_AMPLITUDE_BAR = 0.05;  // §4 P.3
const SEASONAL_SPLIT_RHO_BAR = 0.5;   // §4 P.3
const BLOCK_LEN = 100;        // §4 S.2
const N_BOOT = 1000;          // §4 S.2
const SEED = 42;              // §4

// ── seeded RNG (mulberry32, the calibrators' own primitive) ───────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── small stats helpers ───────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function sd(a) {                      // sample sd (n−1)
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function skewness(a) {                // sample skewness (moment estimator)
  const m = mean(a), n = a.length;
  const m2 = a.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  const m3 = a.reduce((s, x) => s + (x - m) ** 3, 0) / n;
  return m3 / m2 ** 1.5;
}
function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] * (hi - i) + sorted[hi] * (i - lo);
}
function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}

// Kolmogorov–Smirnov distance between a sample and a CDF.
function ksDistance(sample, cdf) {
  const s = [...sample].sort((a, b) => a - b);
  const n = s.length;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const F = cdf(s[i]);
    d = Math.max(d, Math.abs((i + 1) / n - F), Math.abs(F - i / n));
  }
  return d;
}

// ── candidate marginal families, standardized to mean 0 / var 1 ───────────
// Erf via Abramowitz–Stegun 7.1.26 (|eps| < 1.5e-7), enough for a KS distance.
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

// Lower regularized incomplete gamma P(k, x), series + continued fraction.
function lnGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function gammaP(k, x) {
  if (x <= 0) return 0;
  if (x < k + 1) {                      // series
    let ap = k, sum = 1 / k, del = sum;
    for (let n = 0; n < 500; n++) {
      ap++; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return sum * Math.exp(-x + k * Math.log(x) - lnGamma(k));
  }
  let b = x + 1 - k, c = 1e300, d = 1 / b, h = d;   // continued fraction
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - k);
    b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + k * Math.log(x) - lnGamma(k)) * h;
}

/** Fit the three parametric candidates to standardized z (mean 0, var 1) by
 *  method of moments, per §4 M.3. Returns {family: {ks, params}}. */
function fitMarginalFamilies(z) {
  const out = {};
  const g1 = skewness(z);

  // uniform on [−√3, √3] — mean 0, var 1. The incumbent model's family.
  const a = -Math.sqrt(3), b = Math.sqrt(3);
  out.uniform = {
    params: { lo: a, hi: b },
    ks: ksDistance(z, (x) => Math.min(1, Math.max(0, (x - a) / (b - a)))),
    note: 'the incumbent corpus family',
  };

  // gamma(k) standardized: skew = 2/√k  →  k = 4/skew²
  if (g1 > 1e-6) {
    const k = 4 / g1 ** 2;
    // X ~ Gamma(k, 1) has mean k, sd √k; z = (X − k)/√k  →  X = z√k + k
    out.gamma = {
      params: { shape_k: k },
      ks: ksDistance(z, (x) => gammaP(k, Math.max(0, x * Math.sqrt(k) + k))),
    };
  } else {
    out.gamma = { params: null, ks: null, note: `not fittable: sample skew ${g1.toFixed(4)} <= 0` };
  }

  // lognormal standardized: skew = (e^{s²}+2)·√(e^{s²}−1); solve for s² by bisection.
  if (g1 > 1e-6) {
    const f = (w) => (w + 2) * Math.sqrt(w - 1) - g1;   // w = e^{s²}
    let lo = 1 + 1e-12, hi = 1 + 1e-12;
    while (f(hi) < 0 && hi < 1e6) hi = 1 + (hi - 1) * 2 + 1e-9;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) < 0) lo = mid; else hi = mid;
    }
    const w = (lo + hi) / 2, s2 = Math.log(w), s = Math.sqrt(s2);
    // X = e^{sN}: mean = e^{s²/2}, var = (e^{s²}−1)e^{s²}; z = (X − m)/sdev
    const m = Math.exp(s2 / 2), sdev = Math.sqrt((w - 1) * w);
    out.lognormal = {
      params: { sigma: s },
      ks: ksDistance(z, (x) => {
        const X = x * sdev + m;
        return X <= 0 ? 0 : normalCdf(Math.log(X) / s);
      }),
    };
  } else {
    out.lognormal = { params: null, ks: null, note: `not fittable: sample skew ${g1.toFixed(4)} <= 0` };
  }

  return { candidates: out, sample_skewness: g1 };
}

// ── within-cell residuals ─────────────────────────────────────────────────
/** r_t = v_t / m_{cell(t)}, plus a mask marking pairs (t−1,t) inside one cell. */
function withinCellResiduals(values, hours, dows) {
  const cellOf = (t) => `${hours[t]}-${dows[t]}`;
  const sums = new Map(), counts = new Map();
  for (let t = 0; t < values.length; t++) {
    const k = cellOf(t);
    sums.set(k, (sums.get(k) ?? 0) + values[t]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const r = new Array(values.length), sameCellAsPrev = new Array(values.length).fill(false);
  const degenerateCells = [];
  for (const [k, c] of counts) if (sums.get(k) / c === 0) degenerateCells.push(k);
  for (let t = 0; t < values.length; t++) {
    const k = cellOf(t), m = sums.get(k) / counts.get(k);
    r[t] = m === 0 ? null : values[t] / m;
    if (t > 0 && cellOf(t - 1) === k) sameCellAsPrev[t] = true;
  }
  return { r, sameCellAsPrev, cells: counts.size, degenerateCells };
}

/** AR(1) φ̂ over within-cell pairs only; OLS through the origin on (r−1). §4 S.1 */
function fitPhi(r, sameCellAsPrev) {
  let num = 0, den = 0, n = 0;
  for (let t = 1; t < r.length; t++) {
    if (!sameCellAsPrev[t] || r[t] == null || r[t - 1] == null) continue;
    num += (r[t] - 1) * (r[t - 1] - 1); den += (r[t - 1] - 1) ** 2; n++;
  }
  return { phi: den === 0 ? null : num / den, pairs: n };
}

/** Sample ACF at lag k over within-cell pairs. §4 S.3 */
function acfAtLag(r, hours, dows, k) {
  const cellOf = (t) => `${hours[t]}-${dows[t]}`;
  let num = 0, den = 0, n = 0;
  for (let t = 0; t < r.length; t++) {
    if (r[t] == null) continue;
    den += (r[t] - 1) ** 2;
    if (t >= k && r[t - k] != null && cellOf(t - k) === cellOf(t)) {
      num += (r[t] - 1) * (r[t - k] - 1); n++;
    }
  }
  return { lag: k, rho: den === 0 ? null : num / den, pairs: n };
}

/** Moving-block bootstrap CI for φ̂. Blocks are contiguous within-cell runs of
 *  length BLOCK_LEN; φ̂ is accumulated over the pairs inside each block only. §4 S.2 */
function bootstrapPhiCI(r, sameCellAsPrev) {
  // enumerate valid block start positions: BLOCK_LEN consecutive same-cell ticks
  const starts = [];
  for (let s = 0; s + BLOCK_LEN <= r.length; s++) {
    let ok = r[s] != null;
    for (let j = s + 1; ok && j < s + BLOCK_LEN; j++) ok = sameCellAsPrev[j] && r[j] != null;
    if (ok) starts.push(s);
  }
  if (starts.length === 0) return { ci: null, n_blocks_available: 0 };
  const nBlocks = Math.max(1, Math.floor(r.length / BLOCK_LEN));
  const rng = mulberry32(SEED);
  const phis = [];
  for (let b = 0; b < N_BOOT; b++) {
    let num = 0, den = 0;
    for (let k = 0; k < nBlocks; k++) {
      const s = starts[Math.floor(rng() * starts.length)];
      for (let j = s + 1; j < s + BLOCK_LEN; j++) {
        num += (r[j] - 1) * (r[j - 1] - 1); den += (r[j - 1] - 1) ** 2;
      }
    }
    if (den > 0) phis.push(num / den);
  }
  phis.sort((a, b) => a - b);
  return {
    ci: [quantile(phis, 0.025), quantile(phis, 0.975)],
    n_blocks_available: starts.length, n_blocks_per_resample: nBlocks, n_resamples: phis.length,
  };
}

/** Hour-of-day / day-of-week multiplicative profiles + the §4 P.3 gates. */
function periodicProfile(values, keys, nLevels) {
  const sums = new Array(nLevels).fill(0), counts = new Array(nLevels).fill(0);
  for (let t = 0; t < values.length; t++) { sums[keys[t]] += values[t]; counts[keys[t]]++; }
  const grand = mean(values);
  const profile = sums.map((s, i) => (counts[i] > 0 ? s / counts[i] / grand : null));
  const present = profile.filter((x) => x != null);
  if (present.length < 2) return { profile, amplitude: null, levels_populated: present.length };
  const amplitude = (Math.max(...present) - Math.min(...present)) / mean(present);
  // held-out split: first half vs second half, over levels populated in both
  const half = Math.floor(values.length / 2);
  const halfProfile = (lo, hi) => {
    const s = new Array(nLevels).fill(0), c = new Array(nLevels).fill(0);
    for (let t = lo; t < hi; t++) { s[keys[t]] += values[t]; c[keys[t]]++; }
    const g = mean(values.slice(lo, hi));
    return s.map((x, i) => (c[i] > 0 ? x / c[i] / g : null));
  };
  const p1 = halfProfile(0, half), p2 = halfProfile(half, values.length);
  const both = [];
  for (let i = 0; i < nLevels; i++) if (p1[i] != null && p2[i] != null) both.push(i);
  const rho = both.length >= 3 ? pearson(both.map((i) => p1[i]), both.map((i) => p2[i])) : null;
  return { profile, amplitude, levels_populated: present.length, split_rho: rho, split_levels: both.length };
}

// ── source inventory ──────────────────────────────────────────────────────
const BUNDLES = ['real-burstgpt-v1', 'real-huggingface-lmsys-arena-v1',
  'real-azure-llm-inference-v1', 'real-mooncake-v1'];

function loadBundle(name) {
  const dir = join(ROOT, 'runs/baselines', name);
  const raw = readFileSync(join(dir, 'bundle.jsonl'), 'utf8');
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const runs = raw.trim().split('\n').map((l) => JSON.parse(l));
  return {
    name, runs, manifest, readme,
    sha256: createHash('sha256').update(raw).digest('hex'),
    caveat_filters_applied: manifest.caveat_filters_applied ?? [],
  };
}

/** Which bundles carry per-tick data for a signal, and how much. */
function inventory(bundles) {
  const inv = {};
  for (const sig of FAMILY_A_SIGNALS) inv[sig] = [];
  for (const b of bundles) {
    for (const run of b.runs) {
      for (const sig of FAMILY_A_SIGNALS) {
        const series = run.signal_series?.[sig];
        if (!Array.isArray(series) || series.length === 0) continue;
        const hours = run.hour_of_day, dows = run.day_of_week;
        const cells = new Set();
        for (let t = 0; t < series.length; t++) cells.add(`${hours[t]}-${dows[t]}`);
        inv[sig].push({
          bundle: b.name, ticks: series.length, cells: cells.size,
          distinct_hours: new Set(hours).size, distinct_dows: new Set(dows).size,
          distinct_values: new Set(series).size,
          caveat_filters_applied: b.caveat_filters_applied,
        });
      }
    }
  }
  return inv;
}

// ── the bars, A1–A6 (§5) ──────────────────────────────────────────────────
// Two facts below are read off the ingest code, not the data, and are declared
// as such in the report: A3 (synthetic timestamps, in _source_selection.mjs) and
// A6 (derived signal).
const DERIVED_SIGNALS = {
  'real-burstgpt-v1|cost_req': 'tokens × per-model pricing overlay (tools/_ingest-real-trace-burstgpt.ts:65)',
  'real-huggingface-lmsys-arena-v1|cost_req': 'tokens × per-model pricing overlay; tokens from chars/4 heuristic',
};
// Corpus signal definitions, from the scenario baselines, for the A2 check.
const CORPUS_CONSTRUCT = {
  eval_score: { kind: 'continuous quality benchmark on [0,1]', example_baseline: 0.87,
    source: 'engine/scenarios/slow_burn.ts:38' },
};

/** Pull the per-tick series for one inventory entry. */
function seriesFor(bundles, entry, sig) {
  const bundle = bundles.find((b) => b.name === entry.bundle);
  const run = bundle.runs.find((r) => Array.isArray(r.signal_series?.[sig]));
  return { bundle, values: run.signal_series[sig], hours: run.hour_of_day, dows: run.day_of_week };
}

/** Provenance block for one source. */
function provenanceFor(bundle, entry, sig) {
  const derivedKey = `${entry.bundle}|${sig}`;
  return {
    bundle: entry.bundle, bundle_sha256: bundle.sha256, ticks: entry.ticks, cells: entry.cells,
    caveat_filters_applied: bundle.caveat_filters_applied,
    derived_from: DERIVED_SIGNALS[derivedKey] ?? null,     // A6 disclosure
    a6_disclosed: Boolean(DERIVED_SIGNALS[derivedKey]),
    real_timestamps: !SYNTHETIC_TIMESTAMP_BUNDLES.has(entry.bundle),
    bars_failed: barsFailedBy(entry),
    tick_seconds: 5,
  };
}

/** Marginal fit for one series — shared by the primary source and the cross-checks. */
function marginalFor(values, hours, dows, sig) {
  const { r } = withinCellResiduals(values, hours, dows);
  const rClean = r.filter((x) => x != null);
  const cv = sd(rClean);
  const z = rClean.map((x) => (x - 1) / cv);
  const fit = fitMarginalFamilies(z);
  // §4 M.4 — argmin over the PARAMETRIC candidates; empirical is the fallback.
  // (Read as such because a four-way argmin including the empirical CDF is
  //  degenerate: its KS distance is 0 by construction. Disclosed in the report.)
  const parametric = Object.entries(fit.candidates).filter(([, v]) => v.ks != null)
    .sort((a, b) => a[1].ks - b[1].ks);
  const [bestName, best] = parametric[0];
  const useEmpirical = best.ks > KS_BAR;
  const sortedZ = [...z].sort((a, b) => a - b);
  return {
    status: 'sourced', cv,
    family: useEmpirical ? 'empirical' : bestName,
    family_params: useEmpirical ? null : best.params,
    empirical_quantiles_z: useEmpirical
      ? Array.from({ length: 101 }, (_, i) => quantile(sortedZ, i / 100)) : null,
    ks_distances: Object.fromEntries(Object.entries(fit.candidates).map(([k, v]) => [k, v.ks])),
    ks_bar: KS_BAR,
    best_parametric: bestName, best_parametric_ks: best.ks,
    sample_skewness: fit.sample_skewness,
    n: rClean.length,
    incumbent_cv: { p99_latency: 0.008 / Math.sqrt(12), ttft: 0.008 / Math.sqrt(12),
      cost_req: 0.006 / Math.sqrt(12), downstream_err: 0.03 / Math.sqrt(12) }[sig] ?? null,
  };
}

// ── main ──────────────────────────────────────────────────────────────────
const bundles = BUNDLES.map(loadBundle);
const inv = inventory(bundles);
const results = { signals: {}, inventory: inv };

for (const sig of FAMILY_A_SIGNALS) {
  const entries = inv[sig];
  const rec = {
    signal: sig,
    sources_found: entries,
    marginal: null, serial: null, periodic: null, provenance: null,
  };
  const sel = selectSource(entries);
  rec.source_selection = {
    primary: sel.primary?.bundle ?? null,
    per_group: Object.fromEntries(Object.entries(sel.per_group)
      .map(([g, e]) => [g, e?.bundle ?? null])),
    cross_checks: sel.cross_checks.map((e) => e.bundle),
  };

  // ── A1: no source at all ────────────────────────────────────────────────
  if (sel.primary === null) {
    const cbs = { status: 'cannot_be_sourced', criterion: 'A1',
      reason: `no bundle in runs/baselines/ carries per-tick data for ${sig}`,
      what_would_be_needed: `a baseline bundle in runs/baselines/ carrying per-tick ${sig}` };
    rec.marginal = cbs; rec.serial = cbs; rec.periodic = cbs;
    results.signals[sig] = rec;
    continue;
  }

  const src = sel.primary;
  const { bundle, values, hours, dows } = seriesFor(bundles, src, sig);
  rec.provenance = provenanceFor(bundle, src, sig);

  // ── A2: construct mismatch. Checked with evidence from the data. ────────
  let a2 = null;
  if (sig === 'eval_score') {
    const distinct = [...new Set(values)].sort((a, b) => a - b);
    if (distinct.length <= 2) {
      a2 = {
        criterion: 'A2',
        reason: `the trace's ${sig} takes ${distinct.length} distinct value(s) `
          + `(${JSON.stringify(distinct)}) — a binary pairwise arena outcome `
          + `(winner_model_a ? 1 : 0, tools/_ingest-real-trace-huggingface.ts:20). `
          + `The corpus's ${sig} is a ${CORPUS_CONSTRUCT[sig].kind} `
          + `(baseline ${CORPUS_CONSTRUCT[sig].example_baseline}, ${CORPUS_CONSTRUCT[sig].source}). `
          + `A Bernoulli win-indicator and a continuous quality score do not measure the same thing, `
          + `so its dispersion is not this signal's jitter.`,
        evidence: { distinct_values: distinct, n_distinct: distinct.length },
        what_would_be_needed:
          'a per-tick continuous eval/benchmark score series from a served model — '
          + 'e.g. a rolling automated-eval harness logged alongside serving telemetry',
      };
    }
  }
  if (a2) {
    const cbs = { status: 'cannot_be_sourced', ...a2 };
    rec.marginal = cbs;
    rec.serial = { status: 'cannot_be_sourced', criterion: 'A2+A3',
      reason: a2.reason + ' Additionally A3: this bundle has no real timestamps '
        + '(synthetic_timestamp_derivation:row_index_x_tick_seconds; void tickSeconds, '
        + 'tools/_ingest-real-trace-huggingface.ts:158), so row order is not time order '
        + 'and any lag-1 correlation measured on it is an artifact of CSV ordering.',
      what_would_be_needed: a2.what_would_be_needed + ', with real timestamps' };
    rec.periodic = { ...rec.serial, criterion: 'A2+A3' };
    results.signals[sig] = rec;
    continue;
  }

  // ── primary analysis: within-cell residuals (§3) ────────────────────────
  const { r, sameCellAsPrev, degenerateCells } = withinCellResiduals(values, hours, dows);

  // ── marginal (§4 M) ─────────────────────────────────────────────────────
  rec.marginal = marginalFor(values, hours, dows, sig);
  rec.marginal.source = src.bundle;

  // Non-primary sources, fitted the same way and reported as cross-checks only.
  rec.marginal_cross_checks = sel.cross_checks.map((e) => {
    const s = seriesFor(bundles, e, sig);
    const m = marginalFor(s.values, s.hours, s.dows, sig);
    return { source: e.bundle, bars_failed: barsFailedBy(e), ticks: e.ticks,
      cv: m.cv, family: m.family, best_parametric: m.best_parametric,
      best_parametric_ks: m.best_parametric_ks, sample_skewness: m.sample_skewness,
      derived_from: DERIVED_SIGNALS[`${e.bundle}|${sig}`] ?? null };
  });

  // ── serial (§4 S) ───────────────────────────────────────────────────────
  if (sel.per_group.serial === null) {
    rec.serial = { status: 'cannot_be_sourced', criterion: 'A3',
      reason: `the only bundle carrying ${sig} has no real timestamps `
        + '(synthetic_timestamp_derivation:row_index_x_tick_seconds), so row order is not '
        + 'time order and any lag-1 correlation measured on it is an artifact of CSV ordering',
      what_would_be_needed: `a real-timestamp trace carrying per-tick ${sig}` };
  } else {
  const phiFit = fitPhi(r, sameCellAsPrev);
  if (phiFit.pairs < MIN_TICKS_FOR_PHI) {
    rec.serial = { status: 'cannot_be_sourced', criterion: 'A4',
      reason: `${phiFit.pairs} within-cell pairs < ${MIN_TICKS_FOR_PHI} required`,
      what_would_be_needed: `a bundle with at least ${MIN_TICKS_FOR_PHI} within-cell consecutive ticks` };
  } else {
    const boot = bootstrapPhiCI(r, sameCellAsPrev);
    const acf = [2, 3, 4, 5].map((k) => acfAtLag(r, hours, dows, k));
    const rho2 = acf[0].rho;
    const ar1Adequate = rho2 != null && Math.abs(rho2 - phiFit.phi ** 2) <= 0.05;
    const nonZero = boot.ci && (boot.ci[0] > 0 || boot.ci[1] < 0);
    rec.serial = ar1Adequate
      ? { status: 'sourced', phi: phiFit.phi, ci95: boot.ci, phi_nonzero: nonZero,
          pairs: phiFit.pairs, acf_lags_2_5: acf, ar1_adequate: true,
          ar1_check: { rho2: rho2, phi_squared: phiFit.phi ** 2, abs_diff: Math.abs(rho2 - phiFit.phi ** 2), bar: 0.05 },
          bootstrap: { block_len: BLOCK_LEN, n_resamples: boot.n_resamples, seed: SEED,
            n_blocks_available: boot.n_blocks_available } }
      : { status: 'ar1_inadequate', criterion: '§4 S.3',
          reason: `|rho2 − phi²| = ${Math.abs(rho2 - phiFit.phi ** 2).toFixed(4)} > 0.05; `
            + 'AR(1) does not describe this series, so no phi is published',
          phi_not_published: phiFit.phi, acf_lags_2_5: acf,
          ar1_check: { rho2, phi_squared: phiFit.phi ** 2, abs_diff: Math.abs(rho2 - phiFit.phi ** 2), bar: 0.05 },
          ci95_not_published: boot.ci };
  }
  if (rec.serial.status === 'sourced' || rec.serial.status === 'ar1_inadequate') {
    rec.serial.source = sel.per_group.serial.bundle;
  }
  }

  // ── periodic (§4 P, §5 A5) ──────────────────────────────────────────────
  if (sel.per_group.periodic === null) {
    rec.periodic = { status: 'cannot_be_sourced', criterion: 'A3',
      reason: `the only bundle carrying ${sig} has no real timestamps, so its hour_of_day is `
        + 'manufactured from row order and any periodic profile fitted on it is an artifact',
      what_would_be_needed: `a real-timestamp trace carrying per-tick ${sig}` };
  } else {
  const nHours = new Set(hours).size, nDows = new Set(dows).size;
  const diurnalCycles = src.cells / 24;         // contiguous hour-cells / 24
  const hourProf = periodicProfile(values, hours, 24);
  const dowProf = periodicProfile(values, dows, 7);
  const hodBlocked = diurnalCycles < MIN_DIURNAL_CYCLES;
  const dowBlocked = nDows < MIN_DAYS_FOR_DOW;
  rec.periodic = {
    status: (hodBlocked && dowBlocked) ? 'cannot_be_sourced' : 'sourced',
    criterion: (hodBlocked && dowBlocked) ? 'A5' : null,
    reason: (hodBlocked && dowBlocked)
      ? `${diurnalCycles.toFixed(2)} complete diurnal cycles < ${MIN_DIURNAL_CYCLES} required for `
        + `hour-of-day; ${nDows} distinct day-of-week values < ${MIN_DAYS_FOR_DOW} days required for `
        + 'day-of-week. Two cycles cannot separate a diurnal profile from a single event or a slow trend.'
      : null,
    what_would_be_needed: (hodBlocked && dowBlocked)
      ? `a trace spanning at least ${MIN_DIURNAL_CYCLES} full days for hour-of-day and `
        + `${MIN_DAYS_FOR_DOW} days for day-of-week` : null,
    // reported as non-qualifying descriptive evidence, per §5
    non_qualifying_hour_of_day: {
      diurnal_cycles: diurnalCycles, distinct_hours: nHours,
      amplitude: hourProf.amplitude, split_rho: hourProf.split_rho,
      would_pass_amplitude_bar: hourProf.amplitude != null && hourProf.amplitude >= SEASONAL_AMPLITUDE_BAR,
      would_pass_split_bar: hourProf.split_rho != null && hourProf.split_rho >= SEASONAL_SPLIT_RHO_BAR,
      profile: hourProf.profile,
    },
    non_qualifying_day_of_week: {
      distinct_dows: nDows, amplitude: dowProf.amplitude, profile: dowProf.profile,
    },
    source: sel.per_group.periodic.bundle,
  };
  }

  // ── secondary analysis: no cell centring (§3) ───────────────────────────
  const grand = mean(values);
  const rRaw = values.map((v) => v / grand);
  let num = 0, den = 0;
  for (let t = 1; t < rRaw.length; t++) { num += (rRaw[t] - 1) * (rRaw[t - 1] - 1); den += (rRaw[t - 1] - 1) ** 2; }
  rec.secondary_no_cell_centring = { cv: sd(rRaw), phi: den === 0 ? null : num / den };
  rec.degenerate_cells = degenerateCells;

  results.signals[sig] = rec;
}

// ── emit ──────────────────────────────────────────────────────────────────
const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const runDir = join(STUDY, 'results', `run-${now}`);
mkdirSync(runDir, { recursive: true });

const manifest = {
  study_id: '2026-08-corpus-noise-v2',
  run: `run-${now}`,
  repo_sha: execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(),
  repo_dirty: execSync('git status --porcelain', { cwd: ROOT }).toString().trim().length > 0,
  node: process.version,
  command: 'node studies/corpus-noise-v2/analysis/fit_noise_model.mjs',
  seed: SEED,
  bundles: bundles.map((b) => ({ name: b.name, sha256: b.sha256,
    caveat_filters_applied: b.caveat_filters_applied })),
  frozen_constants: { KS_BAR, MIN_TICKS_FOR_PHI, MIN_DIURNAL_CYCLES, MIN_DAYS_FOR_DOW,
    SEASONAL_AMPLITUDE_BAR, SEASONAL_SPLIT_RHO_BAR, BLOCK_LEN, N_BOOT },
  preregistration: 'studies/corpus-noise-v2/PREREGISTRATION.md',
  // PREREGISTRATION.md §7.3 — a rerun is permitted only for a code defect, fixed
  // test-first, with the superseding run's manifest naming the defect.
  supersedes: {
    run: 'run-20260805T231835Z',
    defect: 'source selection ranked candidate bundles by series length alone, so cost_req '
      + 'was fitted from real-huggingface-lmsys-arena-v1 (39,712 ticks) rather than '
      + 'real-burstgpt-v1 (34,202 ticks). LMSYS fails bar A3 (synthetic timestamps), which '
      + 'kills the serial and periodic groups; the superseded run published phi = -0.00139 '
      + 'fitted on the row order of a shuffled CSV.',
    fixed_by: 'analysis/_source_selection.mjs (a bundle failing a bar cannot supply the groups '
      + 'that bar kills), guarded by analysis/test_source_selection.mjs',
    prior_run_retained: true,
  },
};
writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(runDir, 'fit.json'), JSON.stringify(results, null, 2) + '\n');

// ── the consumable artifact ───────────────────────────────────────────────
const artifact = {
  $schema_version: 1,
  name: 'corpus-noise-model',
  version: 2,
  derived_by: 'studies/corpus-noise-v2 (C30)',
  preregistration: 'studies/corpus-noise-v2/PREREGISTRATION.md',
  run: `run-${now}`,
  tick_seconds: 5,
  frame: 'within-cell (hour_of_day × day_of_week); see PREREGISTRATION.md §3',
  incumbent_model: {
    note: 'the invented model this supersedes; left in place in engine/scenarios/slow_burn.ts:43-55',
    form: 'v = mean × (1 + c·U[0,1])',
    c: { p99_latency: 0.008, ttft: 0.008, cost_req: 0.006, downstream_err: 0.03 },
    provenance: 'none — no derivation exists in the repo',
  },
  signals: {},
};
for (const sig of FAMILY_A_SIGNALS) {
  const rec = results.signals[sig];
  artifact.signals[sig] = {
    marginal: rec.marginal, serial: rec.serial, periodic: rec.periodic,
    provenance: rec.provenance,
  };
}
writeFileSync(join(runDir, 'corpus-noise-model.json'), JSON.stringify(artifact, null, 2) + '\n');
writeFileSync(join(ROOT, 'engine/scenarios/corpus-noise-model.json'), JSON.stringify(artifact, null, 2) + '\n');

// ── console summary ───────────────────────────────────────────────────────
console.log(`run ${runDir}`);
for (const sig of FAMILY_A_SIGNALS) {
  const r = results.signals[sig];
  const f = (g) => (g.status === 'sourced' ? 'SOURCED' : (g.criterion ?? g.status));
  console.log(`  ${sig.padEnd(19)} M=${f(r.marginal).padEnd(16)} S=${f(r.serial).padEnd(16)} P=${f(r.periodic)}`);
}
