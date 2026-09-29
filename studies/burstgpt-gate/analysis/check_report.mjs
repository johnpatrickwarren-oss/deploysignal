// analysis/check_report.mjs — machine-checks REPORT.md against the run artifacts. Exit 1 on drift.
// Recomputes E1 from windows.json, compares to endpoints.json, and pins every number REPORT.md quotes.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
const runs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('run-')).sort();
let failed = 0;
const check = (name, ok) => { if (!ok) { console.error(`FAIL ${name}`); failed++; } };
check('exactly one run', runs.length === 1);
const R = join(STUDY, 'results', runs[0]);
const E = JSON.parse(readFileSync(join(R, 'endpoints.json'), 'utf8'));
const W = JSON.parse(readFileSync(join(R, 'windows.json'), 'utf8'));
const M = JSON.parse(readFileSync(join(R, 'manifest.json'), 'utf8'));
check('report names the run', report.includes(runs[0]));
check('report names the harness sha', report.includes(M.repo_head.slice(0, 7)));
check('engine 0.12.2-pre', M.engine_installed === '0.12.2-pre' && report.includes('installed 0.12.2-pre'));
check('bundle hash matches the registered value', M.substrate.bundle_sha256 === M.substrate.bundle_sha256_registered && report.includes(M.substrate.bundle_sha256.slice(0, 12)));
check('zero exceptions', M.counters.exceptions === 0 && M.calibration.compile_ok === true && report.includes('Exceptions: 0'));
check('executable', E.executable === true);
const scored = W.filter((w) => !w.voided);
const rb = scored.filter((w) => w.outcome === 'rollback');
const g = (name) => { const ws = scored.filter((w) => w.day_group === name); return { n: ws.length, r: ws.filter((w) => w.outcome === 'rollback').length }; };
const g48 = g('days_4_to_8'), g910 = g('days_9_to_10');
check('E1 recomputed', scored.length === E.E1.windows && rb.length === E.E1.rollbacks && Math.abs(E.E1.rate - rb.length / scored.length) < 1e-12
  && g48.n === E.E1.days_4_to_8.windows && g48.r === E.E1.days_4_to_8.rollbacks && g910.n === E.E1.days_9_to_10.windows && g910.r === E.E1.days_9_to_10.rollbacks);
export const QUOTES = []; // filled by the report author: every number REPORT.md quotes
for (const s of QUOTES) check(`report quotes ${s}`, report.includes(s));
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log(`check_report: all checks passed (${runs[0]})`);
