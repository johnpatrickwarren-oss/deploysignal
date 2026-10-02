// analysis/replay-posthoc.mjs — POST-HOC, written after the AA cell closed and its verdict was known.
// It carries no endpoint. It replays each executable run's 60 stored scored tick bodies through the
// engine's twin gate (the installed pin) with the registered configuration and the p99 margin set to
// 0 (ADR 0036 scoring), 0.05 and 0.10 (as run), to say how much of the pass the margin accounts for
// (§0 (b) of the registration: three things changed at once and a pass does not attribute).
//
//   node studies/twin-aa-real-2/analysis/replay-posthoc.mjs <analysis dir name under results/>
//
// Writes results/<analysis dir>/replay-posthoc.json, refusing an existing file.
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
if (!dir) { console.error('usage: replay-posthoc.mjs <analysis dir>'); process.exit(2); }
const out = join(RES, dir, 'replay-posthoc.json');
if (existsSync(out)) { console.error(`${out} exists`); process.exit(3); }
const runs = JSON.parse(readFileSync(join(RES, dir, 'runs.json'), 'utf8')).filter((r) => r.executable);
const REG = { alphaRollback: 0.05, alphaProceed: 1e-12, alphaSrm: 0.001, canaryWeight: 0.5, maxTicks: 60 };
const MARGINS = [0, 0.05, 0.10];
const result = { post_hoc: true, engine: enginePkg.version, runs: runs.length, margins: {} };
for (const m of MARGINS) {
  const cfg = { ...REG, metrics: [
    { id: 'http_5xx', kind: 'rate', worse: 'higher', tolerance: 0.2 },
    { id: 'p99_latency', kind: 'sign', worse: 'higher', tolerance: 0.15, ...(m > 0 ? { margin: { relative: m } } : {}) },
  ] };
  const rows = [];
  for (const r of runs) {
    const scored = readFileSync(join(RES, 'runs', r.file.replace('.summary.json', '.jsonl')), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((l) => l.type === 'window' && l.scored_tick);
    let state = gate.initTwinGate(cfg); let decision = null;
    for (const w of scored) {
      const b = w.body; const h = b.observations.http_5xx;
      ({ state, decision } = gate.stepTwinGate(cfg, state, {
        canaryRequests: b.canary_requests, controlRequests: b.control_requests,
        observations: { http_5xx: { canaryEvents: h.canary_events, canaryTotal: h.canary_total, controlEvents: h.control_events, controlTotal: h.control_total }, p99_latency: b.observations.p99_latency },
      }));
      if (['rollback', 'proceed', 'invalid_experiment'].includes(decision.verdict)) break;
    }
    rows.push({ run: r.run, lane: r.lane, verdict: decision.verdict, tick: decision.tick, fired: decision.metrics.filter((x) => x.rollbackE >= x.rollbackThreshold).map((x) => x.id) });
  }
  const rb = rows.filter((x) => x.verdict === 'rollback');
  result.margins[String(m)] = { rollbacks: rb.length, of: rows.length, rollback_runs: rb, verdict_counts: rows.reduce((a, x) => { a[x.verdict] = (a[x.verdict] ?? 0) + 1; return a; }, {}) };
  console.log(`replay margin ${m}: ${rb.length}/${rows.length} rollback ${JSON.stringify(rb)}`);
}
// the as-run margin must reproduce the runner's verdicts exactly, or the replay is not the gate the runs saw
const asRun = result.margins['0.1'];
result.reproduces_as_run = asRun.rollbacks === runs.filter((r) => r.scored.verdict === 'rollback').length;
if (!result.reproduces_as_run) { console.error('replay at the registered margin does not reproduce the runs'); process.exit(1); }
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(`written: ${out}`);
