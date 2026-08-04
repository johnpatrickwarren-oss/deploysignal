// check_report.mjs — machine-checks REPORT.md against the run's endpoints.json and
// cells.json. Exit 1 on any drift between prose and data.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');

const runs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('run-'));
if (runs.length !== 1) { console.error(`expected exactly 1 run dir, found ${runs.length}`); process.exit(1); }
const run = runs[0];
const E = JSON.parse(readFileSync(join(STUDY, 'results', run, 'endpoints.json')));
const C = JSON.parse(readFileSync(join(STUDY, 'results', run, 'cells.json')));

let failed = 0;
const check = (name, ok) => { if (!ok) { console.error(`FAIL ${name}`); failed++; } };

check('report names the run dir', report.includes(run));
check('E1 verdict FAIL in report', report.includes('E1: window=[] verdict=FAIL') && E.E1.pass === false);
check('E1 window empty in data', E.E1.window_slopes.length === 0);
check('E2 verdict PASS in report', report.includes('E2: max_abs_gap=0.0000 verdict=PASS') && E.E2.pass === true);
check('E2 max gap 0 in data', Math.max(...E.E2.rows.map((r) => Math.abs(r.gap))) === 0);
check('E3 floor 0.001', E.E3.floor === 0.001 && report.includes('E3: floor=0.001 ceiling=0.02'));

// headline table vs cells
const rate = (arm, s) => C[`${arm}|${s}`].detection_rate;
const ttd = (arm, s) => C[`${arm}|${s}`].median_ttd;
check('slowbleed blind at 0.0002', rate('slowbleed', 0.0002) === 0);
check('slowbleed 0.8244 at 0.001', Math.abs(rate('slowbleed', 0.001) - 0.8244) < 1e-9 && report.includes('0.824'));
check('mixture 1.000 everywhere', [0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02].every((s) => rate('mixture4', s) === 1));
check('TTD 10 vs 34 at 0.001', ttd('mixture4', 0.001) === 10 && ttd('slowbleed', 0.001) === 34 && report.includes('10 / 21 / 34'));
check('betting warm-up 19-20', ttd('betting4', 0.02) === 19 && ttd('betting4', 0.002) === 20);

const totalFa = Object.values(C).reduce((s, c) => s + c.false_alarms, 0);
const totalTrials = Object.values(C).reduce((s, c) => s + c.trials, 0);
check('0 false alarms of 2751', totalFa === 0 && totalTrials === 2751 && report.includes('0 of 2,751'));

if (failed) { console.error(`${failed} inconsistencies`); process.exit(1); }
console.log(`report consistent with ${run} (12 checks)`);
