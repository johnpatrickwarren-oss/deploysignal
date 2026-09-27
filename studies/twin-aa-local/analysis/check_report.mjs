// studies/twin-aa-local/analysis/check_report.mjs — pins REPORT.md to the run artifacts: recomputes
// every table from the raw cell JSON and fails (exit 1) if any rendered line is missing from the
// report, or if endpoints.json differs from the recomputation.
//
//   node studies/twin-aa-local/analysis/check_report.mjs <run-dir>

import fs from 'node:fs';
import path from 'node:path';
import { compute, renderTables } from './summarize.mjs';

const dir = path.resolve(process.argv[2]);
const res = compute(dir);
const report = fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8');
const stored = fs.readFileSync(path.join(dir, 'endpoints.json'), 'utf8');
let bad = 0;
if (stored !== `${JSON.stringify(res, null, 2)}\n`) {
  process.stderr.write('endpoints.json differs from the recomputation\n');
  bad += 1;
}
for (const line of renderTables(res).split('\n')) {
  if (line.trim() && !report.includes(line)) {
    process.stderr.write(`missing from REPORT.md: ${line}\n`);
    bad += 1;
  }
}
process.stdout.write(bad ? `check_report: ${bad} drift(s)\n` : 'check_report: REPORT.md matches the run artifacts\n');
process.exit(bad ? 1 : 0);
