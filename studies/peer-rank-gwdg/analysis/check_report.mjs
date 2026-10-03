import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url)); const STUDY = join(HERE, '..');
const RUN = 'run-20261003T132332Z';
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
const E = JSON.parse(readFileSync(join(STUDY, 'results', RUN, 'endpoints.json'), 'utf8'));
const W = JSON.parse(readFileSync(join(STUDY, 'results', RUN, 'windows.json'), 'utf8'));
const M = JSON.parse(readFileSync(join(STUDY, 'results', RUN, 'manifest.json'), 'utf8'));
const PH = JSON.parse(readFileSync(join(STUDY, 'results', RUN, 'posthoc-margins.json'), 'utf8'));
let failed = 0; const check = (n, ok) => { if (!ok) { console.error(`FAIL ${n}`); failed++; } };
check('run pinned', report.includes(RUN) && M.peer_rank_js_sha256.startsWith('b7901965efb8') && M.repo_sha.startsWith('5aaed4f') && report.includes('`b7901965efb8'));
check('void run preserved', existsSync(join(STUDY, 'results', 'void-20261003T131943Z-instrument-defect', 'endpoints.json')) && report.includes('void-20261003T131943Z-instrument-defect'));
check('instrument', E.counters.exceptions === 0 && E.counters.hash_mismatches === 0 && E.voided === 0 && E.not_executable === false && E.threshold === 280 && E.n_tests === 14);
check('E1 26/44 FAIL', E.E1.windows === 44 && E.E1.rollbacks === 26 && E.E1.verdict === 'FAIL' && Math.abs(E.E1.upper95 - 0.716) < 1e-3 && Math.abs(E.E1.per_1000_ticks - 2.05) < 0.01 && E.E1.temporal_rollbacks_same_windows === 40 && report.includes('26 / 44 = 0.591'));
check('E2 28/40', E.E2.windows === 40 && E.E2.rollbacks === 28 && E.E2.verdict === 'PASS' && Math.abs(E.E2.lead_hours_vs_I_median + 17.83) < 0.01 && E.E2.with_disappearance === 0 && E.E2.temporal_rollbacks_same_windows === 34 && report.includes('28 / 40 = 0.700'));
check('E2 early 27 of 28', Math.round(E.E2.early_fraction * 28) === 27);
check('M5 32/44, 33/40', E.E4_M5.null.rollbacks === 32 && E.E4_M5.detection.rollbacks === 33 && report.includes('null 32 / 44; detection 33 / 40'));
const nullRb = W.filter((w) => w.arm === 'M10' && w.kind === 'null' && w.outcome === 'rollback');
check('nine fire at tick 14', nullRb.filter((w) => w.fire_tick === 14).length === 9 && report.includes('Nine of the 26 null rollbacks fire at tick 14'));
const byFile = {}; for (const w of W.filter((x) => x.arm === 'M10' && x.kind === 'null')) { (byFile[w.file] ??= []).push(w); }
check('five files 4/4', Object.values(byFile).filter((ws) => ws.length === 4 && ws.every((w) => w.outcome === 'rollback')).length === 5 && Object.keys(byFile).length === 11);
const det = W.filter((w) => w.arm === 'M10' && w.kind === 'detection');
check('detection cross-tab 23/5/11', det.filter((w) => w.outcome === 'rollback' && w.temporal_outcome === 'rollback').length === 23 && det.filter((w) => w.outcome === 'rollback' && w.temporal_outcome !== 'rollback').length === 5 && det.filter((w) => w.outcome === 'hold' && w.temporal_outcome === 'rollback').length === 11);
check('post-hoc margins', PH.posthoc === true && PH.results.map((r) => r.null_rollbacks).join() === '26/44,22/44,21/44,20/44,9/44' && PH.results.map((r) => r.detection_rollbacks).join() === '28/40,19/40,19/40,17/40,8/40' && report.includes('22, 21, 20 and 9 of 44') && report.includes('19, 19, 17 and 8 of 40'));
for (const q of ['Wrong by a factor of four to eight', 'fires at tick 141', 'not a null', 'supports no detection claim']) check(`quotes ${q}`, report.includes(q));
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('check_report: all checks passed');
