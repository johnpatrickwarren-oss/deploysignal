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
export const QUOTES = ['13/87', '0.1494', '0.2270', '2.49 per 1,000', '5,230', '5/58', '0.0862', '8/29', '0.2759', '0.061', '0.341',
  'median fire tick is 33', '14,519', '4,970', '0.342', '3,522', '561', 'Bonferroni factor 3', '42 carry', 'E1: FAIL', 'E2: PASS', 'P2 held', 'P3 held', 'P1 half held'];
check('median fire tick', E.E1.median_fire_tick === 33);
check('missing shares', Math.abs(E.E1.missing_share_fired - 0.0608) < 5e-4 && Math.abs(E.E1.missing_share_unfired - 0.3408) < 5e-4);
check('cp upper and per-1000', Math.abs(E.E1.cp_upper95 - 0.2270) < 5e-4 && Math.abs(E.E1.per_1000_present_ticks - 2.49) < 5e-3 && E.E1.present_ticks === 5230);
check('substrate counts', M.substrate.study_ticks === 14519 && M.substrate.missing_ticks === 4970 && M.calibration.present === 3522 && M.calibration.runs === 561 && M.calibration.bonferroni_factor === 3 && M.calibration.cells_with_family_A === 42);
check('shadow non-empty on present ticks', E.E1.shadow_empty_present_total === 0);
check('last-day fire ticks', W.filter((w) => w.k >= 80 && w.k <= 85).map((w) => w.fire_tick).join(',') === '29,2,1,2,15,66' && report.includes('29, 2, 1, 2, 15 and 66'));
for (const s of QUOTES) check(`report quotes ${s}`, report.includes(s));
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log(`check_report: all checks passed (${runs[0]})`);
