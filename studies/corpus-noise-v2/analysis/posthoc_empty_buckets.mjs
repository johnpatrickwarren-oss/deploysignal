// posthoc_empty_buckets.mjs — POST-HOC. No verdict attaches to anything here.
//
// PREREGISTRATION.md did not anticipate that 1,503 of 34,202 BurstGPT ticks (4.39%)
// carry cost_req = 0. This script re-computes the marginal scale and the ACF with
// those ticks dropped, to establish whether the pre-registered AR(1)-inadequacy
// verdict is driven by them or survives. It changes no verdict.
//
// CORRECTED 2026-08-06 — what the zeros are. This file originally asserted they were
// empty 5 s buckets zero-filled by the ingest (`costs.length > 0 ? mean : 0`). That is
// wrong and the mapper cannot do it: mapBurstGPTRows iterates the bucket map's own
// keys, and every key was created by pushing a row, so the `: 0` branch is unreachable
// (tools/_ingest-real-trace-burstgpt.ts:93-112). They are requests that cost nothing —
// rows with 0 request and 0 response tokens, which parseBurstGPTCsv does not filter.
// zeroRunStats() below corroborates: scattered singletons, not clustered idle periods.
//
// The real artifact runs the other way: empty buckets are DROPPED from the series, so
// array adjacency is not time adjacency, and the bundle keeps no record of the skips.
// See REPORT.md §4. The numbers here are unaffected; the interpretation was not.
//
// Usage: node studies/corpus-noise-v2/analysis/posthoc_empty_buckets.mjs

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const ROOT = join(STUDY, '..', '..');

const run = JSON.parse(readFileSync(join(ROOT, 'runs/baselines/real-burstgpt-v1/bundle.jsonl'), 'utf8')
  .trim().split('\n')[0]);
const values = run.signal_series.cost_req, hours = run.hour_of_day, dows = run.day_of_week;

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

/** Within-cell residuals + ACF, over a subset of tick indices. */
function analyse(idx) {
  const key = (t) => `${hours[t]}-${dows[t]}`;
  const sums = new Map(), counts = new Map();
  for (const t of idx) { sums.set(key(t), (sums.get(key(t)) ?? 0) + values[t]); counts.set(key(t), (counts.get(key(t)) ?? 0) + 1); }
  const r = new Map();
  for (const t of idx) { const m = sums.get(key(t)) / counts.get(key(t)); r.set(t, m === 0 ? null : values[t] / m); }
  const rv = idx.map((t) => r.get(t)).filter((x) => x != null);
  const cv = sd(rv);
  // ACF over pairs that are adjacent IN THE RETAINED INDEX and in the same cell
  const acf = [];
  let den = 0;
  for (const t of idx) if (r.get(t) != null) den += (r.get(t) - 1) ** 2;
  for (let k = 1; k <= 8; k++) {
    let num = 0, pairs = 0;
    for (let i = k; i < idx.length; i++) {
      const t = idx[i], u = idx[i - k];
      if (key(t) !== key(u) || r.get(t) == null || r.get(u) == null) continue;
      num += (r.get(t) - 1) * (r.get(u) - 1); pairs++;
    }
    acf.push({ lag: k, rho: den === 0 ? null : num / den, pairs });
  }
  return { n: rv.length, cv, acf, phi: acf[0].rho };
}

const all = Array.from({ length: values.length }, (_, t) => t);
const nonEmpty = all.filter((t) => values[t] !== 0);

/** Are the zeros clustered (idle periods) or scattered (individual zero-cost requests)?
 *  Added 2026-08-06 with the corrected attribution — the original reading called them
 *  empty-bucket zero-fill, which the mapper cannot produce. */
function zeroRunStats() {
  const z = all.filter((t) => values[t] === 0);
  let runs = z.length > 0 ? 1 : 0, longest = z.length > 0 ? 1 : 0, cur = 1;
  for (let i = 1; i < z.length; i++) {
    if (z[i] === z[i - 1] + 1) { cur++; if (cur > longest) longest = cur; } else { runs++; cur = 1; }
  }
  return { zeros: z.length, maximal_runs: runs, longest_run: longest };
}

const withZeros = analyse(all);
const withoutZeros = analyse(nonEmpty);

const ar1Check = (a) => ({
  phi: a.phi, rho2: a.acf[1].rho, phi_squared: a.phi ** 2,
  abs_diff: Math.abs(a.acf[1].rho - a.phi ** 2),
  ar1_adequate: Math.abs(a.acf[1].rho - a.phi ** 2) <= 0.05,
});

const out = {
  label: 'POST-HOC — not pre-registered, no verdict attaches',
  signal: 'cost_req', source: 'real-burstgpt-v1',
  artifact: {
    // CORRECTED 2026-08-06. The original description said these were empty 5 s buckets
    // zero-filled by the ingest. mapBurstGPTRows iterates the bucket map's own keys, every
    // key was created by pushing a row, so the `: 0` branch is unreachable
    // (tools/_ingest-real-trace-burstgpt.ts:93-112). These are requests that cost nothing.
    description: 'cost_req = 0 ticks are rows with 0 request + 0 response tokens; '
      + 'parseBurstGPTCsv filters no rows. The ingest DROPS empty buckets rather than '
      + 'zero-filling them, which is a separate and unquantifiable artifact — see REPORT.md §4.',
    superseded_description: 'ingest emits cost_req = 0 for a 5 s bucket with no arrivals '
      + '(`costs.length > 0 ? mean : 0`) — WRONG, that branch is unreachable',
    zero_cost_ticks: values.length - nonEmpty.length,
    total_ticks: values.length,
    fraction: (values.length - nonEmpty.length) / values.length,
    // clustered => idle periods; scattered singletons => individual zero-cost requests
    clustering: zeroRunStats(),
  },
  primary_as_preregistered: { n: withZeros.n, cv: withZeros.cv, acf: withZeros.acf, ar1: ar1Check(withZeros) },
  // key name kept for continuity with the superseded run's JSON; these are zero-COST ticks
  empty_buckets_dropped: { n: withoutZeros.n, cv: withoutZeros.cv, acf: withoutZeros.acf, ar1: ar1Check(withoutZeros) },
  reading: null,
};
out.reading = out.empty_buckets_dropped.ar1.ar1_adequate
  ? 'The AR(1)-inadequacy verdict is driven by the zero-cost ticks: with them dropped, '
    + 'AR(1) describes the series within the pre-registered bar.'
  : 'The AR(1)-inadequacy verdict survives: the ACF still decays far too slowly for AR(1) '
    + 'once zero-cost ticks are dropped, so the slow decay is not an artifact of them. '
    + 'It remains conditional on array adjacency being time adjacency, which the dropped-'
    + 'empty-bucket behaviour leaves unverifiable from this bundle.';

const runs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('run-')).sort();
const latest = runs[runs.length - 1];
writeFileSync(join(STUDY, 'results', latest, 'posthoc_empty_buckets.json'), JSON.stringify(out, null, 2) + '\n');

console.log(`zero-cost ticks: ${out.artifact.zero_cost_ticks}/${out.artifact.total_ticks} `
  + `(${(out.artifact.fraction * 100).toFixed(2)}%) in ${out.artifact.clustering.maximal_runs} runs, longest ${out.artifact.clustering.longest_run}`);
console.log(`cv  with zeros: ${withZeros.cv.toFixed(4)}   dropped: ${withoutZeros.cv.toFixed(4)}`);
console.log(`phi with zeros: ${withZeros.phi.toFixed(4)}   dropped: ${withoutZeros.phi.toFixed(4)}`);
console.log('ACF with zeros:', withZeros.acf.map((a) => a.rho.toFixed(3)).join(' '));
console.log('ACF dropped   :', withoutZeros.acf.map((a) => a.rho.toFixed(3)).join(' '));
console.log(`AR(1) adequate — with zeros: ${ar1Check(withZeros).ar1_adequate}, dropped: ${ar1Check(withoutZeros).ar1_adequate}`);
console.log(out.reading);
