// analysis/check_report.mjs — machine-checks REPORT.md against the run artifacts. Exit 1 on drift.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
const runs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('run-')).sort();
let failed = 0; const check = (n, ok) => { if (!ok) { console.error(`FAIL ${n}`); failed++; } };
check('exactly one run', runs.length === 1 && runs[0] === 'run-20260929T022254Z' && report.includes(runs[0]));
const R = join(STUDY, 'results', runs[0]);
const E = JSON.parse(readFileSync(join(R, 'endpoints.json'), 'utf8'));
const W = JSON.parse(readFileSync(join(R, 'windows.json'), 'utf8'));
const M = JSON.parse(readFileSync(join(R, 'manifest.json'), 'utf8'));
check('harness sha', report.includes(M.repo_head.slice(0, 7)) && M.tracked_changes.length === 0);
check('engine', M.engine_installed === '0.12.2-pre' && report.includes('installed 0.12.2-pre'));
check('hashes + exceptions', M.substrate.hash_checks.every((h) => h.ok) && M.counters.exceptions === 0 && report.includes('Exceptions: 0'));
check('substrate counts', M.substrate.raw_lines === 650840 && M.substrate.ticks === 74987 && M.substrate.ticks_present === 74987 && M.design.windows_total === 208 && M.design.scorable === 208 && report.includes('650,840') && report.includes('74,987'));
check('executable', E.executable === true && E.E4.pass === true && E.E4.layout_contradicted.length === 0);
const scored = W.filter((w) => !w.voided);
const S = scored.filter((w) => w.arm === 'S'); const rbS = S.filter((w) => w.outcome === 'rollback');
check('E1 recomputed', S.length === 1248 && rbS.length === 594 && E.E1.rollbacks === 594 && E.E1.windows === 1248 && E.E1.pass === false && Math.abs(E.E1.cp_upper95 - 0.4996) < 5e-4);
const per = (id) => { const ws = scored.filter((w) => w.pair === id); return { n: ws.length, rb: ws.filter((w) => w.outcome === 'rollback').length, pr: ws.filter((w) => w.outcome === 'proceed').length, inc: ws.filter((w) => w.outcome === 'inconclusive').length }; };
const expect = { 'c0-c1': [208, 0, 0], 'c2-c3': [208, 0, 0], 'c4-c5': [4, 1, 203], 'c6-c7': [1, 9, 198], 'c9-c10': [88, 120, 0], 'c11-c12': [85, 123, 0], 'c0-c9': [208, 0, 0] };
for (const [id, [rb, pr, inc]] of Object.entries(expect)) { const p = per(id); check(`pair ${id}`, p.n === 208 && p.rb === rb && p.pr === pr && p.inc === inc && E.per_pair[id].rollbacks === rb && report.includes(`${rb}/208`)); }
check('tie shares', Math.abs(E.per_pair['c4-c5'].tie_share - 0.986) < 5e-4 && Math.abs(E.per_pair['c6-c7'].tie_share - 0.986) < 5e-4 && Math.abs(E.E1.tie_share - 0.889) < 5e-4 && report.includes('0.986') && report.includes('0.889'));
check('median ticks', E.per_pair['c0-c1'].median_rollback_tick === 8 && E.per_pair['c9-c10'].median_rollback_tick === 8 && E.per_pair['c4-c5'].median_rollback_tick === 29 && E.per_pair['c6-c7'].median_rollback_tick === 317 && E.E3.median_rollback_tick === 8);
const x = scored.filter((w) => w.pair === 'c0-c9').map((w) => w.verdict_tick).sort((a, b) => a - b);
check('arm X p90 and max', x[Math.floor(x.length * 0.9)] === 8 && Math.max(...x) === 34 && report.includes('maximum 34'));
check('P0 inconclusive 401 of 416', E.per_pair['c4-c5'].inconclusive + E.per_pair['c6-c7'].inconclusive === 401 && report.includes('401 of 416'));
for (const s of ['594/1248', '0.4760', '0.4996', '1.0000', '0.0192', '0.0048', '0.4231', '0.4087', 'E1: FAIL', 'E4: PASS', 'P1 held', 'P2 held', 'P3 held', 'P4 held']) check(`quotes ${s}`, report.includes(s));
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log(`check_report: all checks passed (${runs[0]})`);
