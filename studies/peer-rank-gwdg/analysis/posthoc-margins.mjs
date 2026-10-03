// analysis/posthoc-margins.mjs — POST-HOC, no verdict. The registered arms (M10, M5) rolled back 26 and 32 of 44 null
// windows. This sweeps larger relative margins over the same 44 null and 40 detection windows to see where the
// node-mate spread would be absorbed, as sizing information for the next step (an offset-adjusted kind). Same data,
// same engine module, same 14-test Bonferroni; nothing here changes the scored run.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SIGNALS, loadTidy, parseTs, tickMs } from '../../gwdg-gate/harness/lib.mjs';
const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url)); const STUDY = join(HERE, '..'); const REPO = join(STUDY, '..', '..');
const DATA = process.env.GWDG_DATA ?? join(REPO, '..', 'tessera', 'runs', 'gwdg-data', 'gwdg-gpu-node-telemetry-gpu-detachment-failures-2025-2026-v1.0.0');
const ENGINE = process.env.ENGINE_DIST ?? join(REPO, '..', 'deploysignal-engine', 'dist');
const pr = require(join(ENGINE, 'detectors', 'peer-rank.js'));
const RUN = process.argv[2] ?? 'run-20261003T132332Z';
const windows = JSON.parse(readFileSync(join(REPO, 'studies', 'gwdg-gate', 'results', 'run-20260929T012317Z', 'windows.json'), 'utf8')).filter((w) => w.arm === 'A' && !w.voided);
const MARGINS = [0.10, 0.20, 0.30, 0.50, 1.00];
const N = 2 * SIGNALS.length, ALPHA = 0.05;
const tally = Object.fromEntries(MARGINS.map((m) => [m, { null: { n: 0, rb: 0 }, detection: { n: 0, rb: 0, early: 0 } }]));
const files = [...new Set(windows.map((w) => w.file))].sort();
for (const file of files) {
  const tidy = await loadTidy(join(DATA, 'telemetry', file));
  for (const w of windows.filter((x) => x.file === file)) {
    const peers = tidy.gpus.filter((g) => g !== w.gpu); const s0 = parseTs(w.start), ticks = Math.round((parseTs(w.end) - s0) / tickMs);
    for (const m of MARGINS) {
      const tests = []; for (const sig of SIGNALS) for (const worse of ['higher', 'lower']) { const spec = { id: `${sig}:${worse}`, worse, tolerance: 0.1, margin: { relative: m }, alpha: ALPHA / N }; tests.push({ sig, spec, state: pr.initPeerRank(spec) }); }
      let fire = null;
      for (let k = 0; k < ticks && fire === null; k++) {
        const ms = s0 + k * tickMs;
        for (const t of tests) { const u = tidy.series[w.gpu][t.sig]?.get(ms) ?? NaN; const ps = peers.map((g) => tidy.series[g][t.sig]?.get(ms) ?? NaN); const r = pr.stepPeerRank(t.spec, t.state, { unit: u, peers: ps }); t.state = r.state; if (r.fire && fire === null) fire = k; }
      }
      const T = tally[m][w.kind]; T.n++; if (fire !== null) { T.rb++; if (w.kind === 'detection' && fire < ticks / 2) T.early++; }
    }
  }
}
const out = MARGINS.map((m) => ({ margin: m, null_rollbacks: `${tally[m].null.rb}/${tally[m].null.n}`, null_rate: tally[m].null.rb / tally[m].null.n, detection_rollbacks: `${tally[m].detection.rb}/${tally[m].detection.n}`, detection_rate: tally[m].detection.rb / tally[m].detection.n, detection_fires_before_I: tally[m].detection.early }));
for (const r of out) console.log(`m=${r.margin}  null ${r.null_rollbacks} (${r.null_rate.toFixed(3)})  detection ${r.detection_rollbacks} (${r.detection_rate.toFixed(3)}), before I: ${r.detection_fires_before_I}  [post-hoc, no verdict]`);
writeFileSync(join(STUDY, 'results', RUN, 'posthoc-margins.json'), JSON.stringify({ posthoc: true, note: 'relative-margin sweep on the same windows; no verdict', results: out }, null, 2));
