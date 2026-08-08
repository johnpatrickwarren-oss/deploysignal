// check_report.mjs — the report's endpoint lines must match the run JSON. Exit 1 on drift.
// The anti-drift device gate-value-study lacked when it shipped two reports with opposite verdicts.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const runs = readdirSync(join(STUDY, 'results')).sort();
const run = runs[runs.length - 1];
const ep = JSON.parse(readFileSync(join(STUDY, 'results', run, 'endpoints.json')));
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
const want = [
  `E1: monotone=${ep.E1.monotone_nonincreasing} span=${ep.E1.gap_first_minus_last} verdict=${ep.E1.pass ? 'PASS' : 'FAIL'}`,
  `E2: max_abs_diff=${ep.E2.max_abs_diff} verdict=${ep.E2.pass ? 'PASS' : 'FAIL'}`,
  `E3: delta_star=${ep.E3.delta_star} verdict=${ep.E3.pass ? 'PASS' : 'FAIL'}`,
];
let ok = true;
for (const line of want) {
  if (!report.includes(line)) { console.error('MISSING/DRIFTED:', line); ok = false; }
}
if (!report.includes(`results/${run}/`)) { console.error('report does not cite the latest run', run); ok = false; }
console.log(ok ? `report consistent with ${run}` : 'REPORT INCONSISTENT');
process.exit(ok ? 0 : 1);
