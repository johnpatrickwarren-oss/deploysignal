// analysis/check_report.mjs — machine-checks REPORT.md against the run artifacts. Exit 1 on drift.
// Recomputes E1–E4 from windows.json (not from endpoints.json), compares to endpoints.json, checks
// that the two runs' scored artifacts are identical, and pins every number REPORT.md quotes.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
const runs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('run-')).sort();
let failed = 0;
const check = (name, ok) => { if (!ok) { console.error(`FAIL ${name}`); failed++; } };
check('two runs recorded', runs.length === 2 && runs[0] === 'run-20260929T012317Z' && runs[1] === 'run-20260929T012741Z');
const [R1, R2] = runs.map((r) => join(STUDY, 'results', r));
for (const f of ['units.json', 'windows.json', 'endpoints.json', 'bundles.SHA256SUMS']) {
  check(`${f} identical across runs`, readFileSync(join(R1, f), 'utf8') === readFileSync(join(R2, f), 'utf8'));
}
const E = JSON.parse(readFileSync(join(R1, 'endpoints.json'), 'utf8'));
const W = JSON.parse(readFileSync(join(R1, 'windows.json'), 'utf8'));
const U = JSON.parse(readFileSync(join(R1, 'units.json'), 'utf8'));
const M1 = JSON.parse(readFileSync(join(R1, 'manifest.json'), 'utf8'));
const M2 = JSON.parse(readFileSync(join(R2, 'manifest.json'), 'utf8'));

check('report names both runs', report.includes(runs[0]) && report.includes(runs[1]));
check('report names the harness sha', report.includes(M1.repo_head.slice(0, 7)) && M1.repo_head === M2.repo_head);
check('engine 0.12.2-pre', M1.engine_installed === '0.12.2-pre' && report.includes('installed 0.12.2-pre'));
check('hashes verified', M1.dataset.hash_checks.length === 18 && M1.dataset.hash_checks.every((h) => h.ok));
check('zero exceptions', M1.counters.exceptions === 0 && M1.counters.compile_failures === 0 && report.includes('Exceptions: 0'));
check('wall seconds', M1.wall_seconds === 225 && M2.wall_seconds === 289 && report.includes('225 s') && report.includes('289 s'));
check('executable', E.executable === true && E.not_executable.length === 0);
check('unit counts', E.unit_counts.units_total === 64 && E.unit_counts.candidates === 44 && E.unit_counts.null_units === 44 && E.unit_counts.detection_units === 40 && E.unit_counts.excluded === 20
  && report.includes('64 units') && report.includes('44 candidate') && report.includes('40 detection units'));

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const recompute = (arm) => {
  const nul = W.filter((w) => w.arm === arm && w.kind === 'null' && !w.voided);
  const det = W.filter((w) => w.arm === arm && w.kind === 'detection' && !w.voided);
  const nrb = nul.filter((w) => w.outcome === 'rollback'), drb = det.filter((w) => w.outcome === 'rollback');
  const leads = drb.map((w) => w.lead_hours_vs_I);
  return { nul: nul.length, nrb: nrb.length, det: det.length, drb: drb.length, early: leads.filter((h) => h < 0).length,
    medLead: med(leads), nullTicks: nul.reduce((a, w) => a + (w.fire_tick !== null ? w.fire_tick + 1 : w.ticks), 0),
    medNullFire: med(nrb.map((w) => w.fire_tick)), medDetFire: med(drb.map((w) => w.fire_tick)),
    xidAfter: det.filter((w) => w.xid_first_tick !== null && w.fire_tick !== null && w.fire_tick >= w.xid_first_tick).length,
    xidBefore: det.filter((w) => w.xid_first_tick !== null && w.fire_tick !== null && w.fire_tick < w.xid_first_tick).length,
    cFirstNull: nrb.filter((w) => w.first_signal === 'family_C').length, cFirstDet: drb.filter((w) => w.first_signal === 'family_C').length,
    missingProceed: det.filter((w) => w.missing_ticks > 0).map((w) => `${w.missing_ticks}:${w.outcome}`).sort().join(','),
    nrb40: nul.filter((w) => !w.unit.startsWith('ggpu142_2025-03-15') && w.outcome === 'rollback').length };
};
const a = recompute('A'), ac = recompute('AC');
check('A E1 recomputed', a.nul === 44 && a.nrb === 40 && E.arms.A.E1.rollbacks === 40 && Math.abs(E.arms.A.E1.rate - 40 / 44) < 1e-12 && E.arms.A.E1.pass === false
  && Math.abs(E.arms.A.E1.cp_upper95 - 0.9683) < 5e-4 && Math.abs(E.arms.A.E1.per_1000_ticks - 12.92) < 5e-3 && a.nullTicks === 3096);
check('AC E1 recomputed', ac.nul === 44 && ac.nrb === 42 && E.arms.AC.E1.rollbacks === 42 && E.arms.AC.E1.pass === false
  && Math.abs(E.arms.AC.E1.cp_upper95 - 0.9919) < 5e-4 && Math.abs(E.arms.AC.E1.per_1000_ticks - 18.62) < 5e-3 && ac.nullTicks === 2256);
check('A E2 recomputed', a.det === 40 && a.drb === 34 && E.arms.A.E2.rollbacks === 34 && E.arms.A.E2.pass === true);
check('AC E2 recomputed', ac.det === 40 && ac.drb === 35 && E.arms.AC.E2.rollbacks === 35 && E.arms.AC.E2.pass === true);
check('A E3', a.early === 31 && Math.abs(a.medLead + 22.1667) < 1e-3 && a.xidAfter === 18 && a.xidBefore === 0 && E.arms.A.E3.median_fire_minus_xid_ticks === 17.5 && a.medNullFire === 47 && a.medDetFire === 11);
check('AC E3', ac.early === 34 && Math.abs(ac.medLead + 22.1667) < 1e-3 && ac.xidAfter === 15 && ac.xidBefore === 0 && E.arms.AC.E3.median_fire_minus_xid_ticks === 12 && ac.medNullFire === 25.5 && ac.medDetFire === 11);
check('C first', a.cFirstNull === 0 && ac.cFirstNull === 9 && ac.cFirstDet === 7);
check('E4', E.E4.detections_AC_not_A.length === 1 && E.E4.detections_A_not_AC.length === 0 && E.E4.false_rollbacks_AC_not_A.length === 2 && E.E4.false_rollbacks_A_not_AC.length === 0);
check('missing-tick windows proceed', a.missingProceed === '23:proceed,88:proceed,88:proceed,88:proceed' && ac.missingProceed === '88:proceed,88:proceed,88:proceed');
check('E1 on the 40 enumerated units', a.nrb40 === 36 && ac.nrb40 === 38);
check('thresholds are ville', U.filter((u) => u.compile?.A).every((u) => Object.values(u.compile.A.per_signal).every((p) => p === null || p.threshold_kind === 'ville')));
check('family A cells', U.filter((u) => u.compile?.A).every((u) => u.compile.A.cells_with_family_A === 48));
check('sigma floor only MEM_CLOCK', U.filter((u) => u.compile?.A).every((u) => u.compile.A.sigma_floor_signals.join() === 'DCGM_FI_DEV_MEM_CLOCK'));
check('excluded reasons', U.filter((u) => u.gpu !== null && !u.eligible).every((u) => u.reason.startsWith('calibration_ends_after_E_first_minus_24h')));

// the numbers REPORT.md quotes
for (const s of ['40/44', '0.9091', '0.9683', '12.9 per 1,000', '42/44', '0.9545', '0.9919', '18.6 per 1,000', '34/40', '0.8500', '35/40', '0.8750',
  '31 of 34', '34 of 35', '−22.2 h', '17.5 ticks', '12 ticks', '0 of 18', '0 of 15', '36/40', '38/40', '33 units', '35 units',
  'E1: FAIL', 'E2: PASS', 'E5: PASS', 'P1 held', 'P3 held', 'P4 held']) {
  check(`report quotes ${s}`, report.includes(s));
}
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log(`check_report: all checks passed (${runs.join(', ')})`);
