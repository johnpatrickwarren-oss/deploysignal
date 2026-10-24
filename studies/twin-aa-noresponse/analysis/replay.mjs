// analysis/replay.mjs — the registered replay (PREREGISTRATION.md §2, report-only; committed BEFORE run 0).
// It carries no endpoint. For every executable run it steps the 60 stored scored tick bodies through the engine's
// twin gate (the installed pin) twice: with the three registered metrics (as run; it must reproduce the runs' own
// verdicts or the script exits 1) and without no_response (two metrics, threshold 40), to show what declaring
// the third metric costs.
//
//   node studies/twin-aa-noresponse/analysis/replay.mjs <analysis dir name under results/>
//
// Writes results/<analysis dir>/replay.json, refusing an existing file.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const gate = require('@johnpatrickwarren-oss/deploysignal-engine/per-shard/twin-gate');
const enginePkg = require('@johnpatrickwarren-oss/deploysignal-engine/package.json');
const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, '..', 'results');
const dir = process.argv[2];
if (!dir) { console.error('usage: replay.mjs <analysis dir>'); process.exit(2); }
const out = join(RES, dir, 'replay.json');
if (existsSync(out)) { console.error(`${out} exists`); process.exit(3); }
const runs = JSON.parse(readFileSync(join(RES, dir, 'runs.json'), 'utf8')).filter((r) => r.executable);
const REG = { alphaRollback: 0.05, alphaProceed: 1e-12, alphaSrm: 0.001, canaryWeight: 0.5, maxTicks: 60 };
const BASE = [
  { id: 'http_5xx', kind: 'rate', worse: 'higher', tolerance: 0.2 },
  { id: 'p99_latency', kind: 'sign', worse: 'higher', tolerance: 0.15, margin: { relative: 0.10 } },
];
const CONFIGS = {
  as_run: [...BASE, { id: 'no_response', kind: 'rate', worse: 'higher', tolerance: 0.2 }],
  without_no_response: BASE,
};
const rate = (o) => ({ canaryEvents: o.canary_events, canaryTotal: o.canary_total, controlEvents: o.control_events, controlTotal: o.control_total });
const result = { registered_report_only: true, engine: enginePkg.version, runs: runs.length, configs: {} };
for (const [name, metrics] of Object.entries(CONFIGS)) {
  const cfg = { ...REG, metrics };
  const rows = [];
  for (const r of runs) {
    const scored = readFileSync(join(RES, 'runs', r.file.replace('.summary.json', '.jsonl')), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((l) => l.type === 'window' && l.scored_tick);
    let state = gate.initTwinGate(cfg); let decision = null;
    for (const w of scored) {
      const b = w.body;
      const observations = { http_5xx: rate(b.observations.http_5xx), p99_latency: b.observations.p99_latency };
      if (metrics.some((m) => m.id === 'no_response')) observations.no_response = rate(b.observations.no_response);
      ({ state, decision } = gate.stepTwinGate(cfg, state, { canaryRequests: b.canary_requests, controlRequests: b.control_requests, observations }));
      if (['rollback', 'proceed', 'invalid_experiment'].includes(decision.verdict)) break;
    }
    rows.push({ run: r.run, lane: r.lane, stratum: r.stratum, verdict: decision.verdict, tick: decision.tick, as_run: r.scored.verdict,
      fired: decision.metrics.filter((x) => x.rollbackE >= x.rollbackThreshold).map((x) => x.id) });
  }
  const rb = rows.filter((x) => x.verdict === 'rollback');
  result.configs[name] = { metrics: metrics.map((m) => m.id), rollbacks: rb.length, of: rows.length, rollback_runs: rb,
    mismatches: rows.filter((x) => x.verdict !== x.as_run).map((x) => ({ run: x.run, replay: x.verdict, as_run: x.as_run })) };
  console.log(`replay ${name}: ${rb.length}/${rows.length} rollbacks`);
}
result.reproduces_as_run = result.configs.as_run.mismatches.length === 0;
if (!result.reproduces_as_run) { console.error(`replay with the registered metrics does not reproduce ${result.configs.as_run.mismatches.length} run(s)`); process.exit(1); }
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(`written: ${out}`);
