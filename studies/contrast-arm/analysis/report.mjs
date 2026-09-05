// report.mjs — renders REPORT.md from a run directory's JSON, byte-stable; check_report.mjs re-renders and diffs.
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const f = (x, d = 4) => (x === null || x === undefined ? '—' : typeof x === 'number' ? x.toFixed(d) : String(x));

export function render(runDir) {
  const J = (n) => JSON.parse(readFileSync(join(runDir, n), 'utf8'));
  const M = J('manifest.json'), E = J('endpoints.json'), cells = J('cells.json');
  const K = M.constants;
  const L = [];
  L.push(`# 2026-09-contrast-arm — report (${basename(runDir)})`, '');
  L.push(`Repo \`${M.repo_sha}\`; engine ${M.engine.installed} (pin \`${M.engine.pin}\`); scenarios ${M.n_scenarios} (sha \`${M.scenario_sha.slice(0, 12)}…\`); node ${M.node}; ${M.runtime_ms} ms; exceptions ${M.exceptions}; voided cells ${M.voided_cells.length}.`);
  L.push(`Fit ${K.FIT}, canary ${K.T_TOTAL}, injection at ${K.T_INJECT}, steps ${K.DELTA}σ̂ / ${K.DELTA_3}σ̂; q = ${K.Q}; α primary ${K.ALPHAS[0].toExponential(3)}, secondary ${K.ALPHAS[1]}; monitor α_cal ${K.MONITOR_ALPHA}; fit-ratio floor ${K.FIT_RATIO_FLOOR}.`);
  L.push(`Smoke: ${JSON.stringify(M.smoke)}.`, '');
  L.push('## Endpoints', '');
  L.push('| endpoint | measured | bar | verdict |', '|---|---|---|---|');
  L.push(`| E1 false would-be rollback under the null, contrast at q (primary α card) | ${f(E.E1.contrast_null)} (temporal ${f(E.E1.temporal_null.primary)} primary / ${f(E.E1.temporal_null.secondary)} at 0.05) | ≤ ${f(E.E1.bar)} | ${E.E1.pass ? 'HELD' : 'FAILED'} |`);
  L.push(`| E2 detection on the canary-only 1.5σ̂ step, contrast | ${f(E.E2.contrast.rate)} (TTD ${f(E.E2.contrast.ttd, 0)}) vs temporal ${f(E.E2.temporal.rate)} (TTD ${f(E.E2.temporal.ttd, 0)}) | ≥ ${E.E2.floor} | ${E.E2.pass ? 'HELD' : 'FAILED'} |`);
  L.push(`| E2 (reported) the 3σ̂ row | contrast ${f(E.E2.contrast_3.rate)} (TTD ${f(E.E2.contrast_3.ttd, 0)}) vs temporal ${f(E.E2.temporal_3.rate)} (TTD ${f(E.E2.temporal_3.ttd, 0)}) | — | reported |`);
  L.push(`| E3 a shared outage, contrast | ${f(E.E3.contrast_shared)} (null ${f(E.E3.contrast_null)}); temporal shared ${f(E.E3.temporal_shared)} vs its canary ${f(E.E3.temporal_canary)} | ≤ ${f(E.E3.bar)} | ${E.E3.pass ? 'HELD' : 'FAILED'} |`);
  L.push(`| E4 cohort-monitor revocation on a contaminated control by t = 100 | ${Object.entries(E.E4.per_signal).map(([s, v]) => `${s} ${f(v.fraction, 3)} (med ${f(v.median_tick, 0)}; null ${f(v.null_fraction, 3)})`).join('; ')}; contrast would-be rollback ${f(E.E4.contrast_contaminated)} | ≥ 0.5 on p99_latency, ttft | ${E.E4.pass ? 'HELD' : 'FAILED'} |`);
  L.push(`| E5 the shipped gate's reading | fit ratio ${E.E5.fit_ratio} vs floor ${E.E5.floor}: ${JSON.stringify(E.E5.shipped_gate_counts)}; authority ${E.E5.authority} | — | reported |`);
  L.push('', '## Cells', '', '| arm | variant | α | trials | would-be rollbacks | rate | median TTD | exceptions |', '|---|---|---|---|---|---|---|---|');
  for (const c of cells) L.push(`| ${c.arm} | ${c.variant} | ${c.alpha} | ${c.trials} | ${c.rollbacks} | ${f(c.rate)} | ${f(c.median_ttd, 0)} | ${c.exceptions} |`);
  L.push('', '## Interpretation decisions made in code (registered as open)', '');
  L.push('- The contrast arm\'s e-BH reads the mixture card\'s running wealth at the PRIMARY α card; the card\'s α sets only its own threshold.');
  L.push('- A scenario\'s would-be rollback tick is the first canary tick with a non-empty selected set among pairs whose cohort monitor is passing, under the study flag `asserted_by_study_flag` (the shipped gate reads `refused_fit_ratio` at m/T = 5).');
  L.push('- The temporal arm is C64 (d)\'s mixture arm verbatim (plug-in μ̂/σ̂² from the canary\'s 500-tick calibration, ar1_phi 0), first crossing across the four signals.');
  L.push('- The cohort monitor\'s revocation tick is the first canary tick `passing` is false; its fit is on the cohort pair\'s own 500-tick baseline.');
  return L.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPathSafe(import.meta.url) === process.argv[1]) process.stdout.write(render(process.argv[2]));
function fileURLToPathSafe(u) { try { return new URL(u).pathname; } catch { return ''; } }
