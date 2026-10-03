import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url)); const STUDY = join(HERE, '..');
const RUN = 'run-20261003T150053Z';
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
const E = JSON.parse(readFileSync(join(STUDY, 'results', RUN, 'endpoints.json'), 'utf8'));
const R = JSON.parse(readFileSync(join(STUDY, 'results', RUN, 'runs.json'), 'utf8'));
const M = JSON.parse(readFileSync(join(STUDY, 'results', RUN, 'manifest.json'), 'utf8'));
let failed = 0; const check = (n, ok) => { if (!ok) { console.error(`FAIL ${n}`); failed++; } };
const row = (s, c, a) => E.rows.find((r) => r.study === s && r.cell === c && r.arm === a);
check('run pinned', report.includes(RUN) && M.module_sha256.startsWith('01afa96cbe0f') && M.repo_sha.startsWith('6ccfbab') && M.engine_sha.startsWith('b78c152') && report.includes('`01afa96cbe0f'));
check('void preserved', existsSync(join(STUDY, 'results', 'void-20261003T145930Z-prefix-collision', 'endpoints.json')));
check('no exceptions', E.counters.exceptions === 0);
const X = [['twin-aa-real', 'AA', 'TS-m', 44, 7, 31, 'FAIL', 12], ['twin-aa-real', 'AA', 'TS-0', 44, 9, 34, 'FAIL', 12], ['twin-aa-real-2', 'AA', 'TS-m', 100, 12, 50, 'FAIL', 0], ['twin-aa-real-2', 'AA', 'TS-0', 100, 0, null, 'PASS', 0], ['twin-aa-onebox', 'AA', 'TS-m', 32, 0, null, 'PASS', 0], ['twin-aa-onebox', 'AA', 'TS-0', 32, 0, null, 'PASS', 0],
  ['twin-fault-shapes', 'AB-lat30', 'TS-m', 20, 0, null, 'reported', 20], ['twin-fault-shapes', 'AB-5xx-1.5', 'TS-m', 20, 20, 30, 'reported', 20], ['twin-fault-shapes', 'AB-5xx-1.5', 'TS-0', 20, 17, 31, 'reported', 20], ['twin-fault-shapes', 'AB-reset', 'TS-m', 20, 1, 46, 'reported', 0], ['twin-fault-shapes', 'AB-reset', 'TS-0', 20, 0, null, 'reported', 0], ['twin-fault-shapes', 'AB-reset-nr', 'TS-m', 21, 0, null, 'reported', 21]];
for (const [s, c, a, n, rb, med, v, pm] of X) { const r = row(s, c, a); check(`${s}/${c}/${a}`, r && r.runs === n && r.rollbacks === rb && r.median_tick === med && r.verdict === v && r.permetric_rollbacks_same_runs === pm); }
check('upper bounds', Math.abs(row('twin-aa-real', 'AA', 'TS-m').upper95 - 0.278) < 1e-3 && Math.abs(row('twin-aa-real-2', 'AA', 'TS-m').upper95 - 0.187) < 1e-3 && Math.abs(row('twin-aa-onebox', 'AA', 'TS-m').upper95 - 0.089) < 1e-3);
check('ticks available', row('twin-fault-shapes', 'AB-lat30', 'TS-m').scored_ticks_median === 11 && row('twin-fault-shapes', 'AB-reset-nr', 'TS-m').scored_ticks_median === 12 && row('twin-fault-shapes', 'AB-5xx-1.5', 'TS-m').scored_ticks_median === 40);
const firstFires = R.filter((r) => r.study === 'twin-aa-real' && r.arm === 'TS-m' && r.outcome === 'rollback');
check('first A/A: the 7 TS-m fires are on runs the sign kind held', firstFires.length === 7 && firstFires.every((r) => r.permetric_verdict === 'hold'));
const secondTicks = R.filter((r) => r.study === 'twin-aa-real-2' && r.arm === 'TS-m' && r.outcome === 'rollback').map((r) => r.fire_tick).sort((a, b) => a - b);
check('second A/A fire ticks 30–55', secondTicks.length === 12 && secondTicks[0] === 30 && secondTicks[11] === 55 && report.includes('ticks 30–55'));
check('no missing', E.rows.every((r) => r.mean_missing === 0));
for (const q of ['12 / 100 with its margin and\n7 / 100 without', 'has, at the end of this programme, no real-data support at any point', 'observed 7', 'observed earlier, 30']) check(`quotes ${q.slice(0, 25)}`, report.includes(q));
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('check_report: all checks passed');
