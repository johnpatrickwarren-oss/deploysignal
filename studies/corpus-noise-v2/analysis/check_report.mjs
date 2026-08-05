// check_report.mjs — machine-checks REPORT.md against the run's fit.json, the
// posthoc JSON, and the shipped artifact. Exit 1 on any drift between prose and data.
//
// Usage: node studies/corpus-noise-v2/analysis/check_report.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const ROOT = join(STUDY, '..', '..');
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');

// Two runs exist by design: the superseded one is retained per PREREGISTRATION.md §7.3.
const runs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('run-')).sort();
if (runs.length !== 2) { console.error(`expected 2 run dirs (1 superseded, 1 current), found ${runs.length}`); process.exit(1); }
const [superseded, current] = runs;
const F = JSON.parse(readFileSync(join(STUDY, 'results', current, 'fit.json')));
const M = JSON.parse(readFileSync(join(STUDY, 'results', current, 'manifest.json')));
const P = JSON.parse(readFileSync(join(STUDY, 'results', current, 'posthoc_empty_buckets.json')));
const SUP = JSON.parse(readFileSync(join(STUDY, 'results', superseded, 'fit.json')));
const A = JSON.parse(readFileSync(join(ROOT, 'engine/scenarios/corpus-noise-model.json')));

let failed = 0;
const check = (name, ok) => { if (!ok) { console.error(`FAIL ${name}`); failed++; } };
const near = (a, b, tol = 5e-5) => Math.abs(a - b) < tol;
const cr = F.signals.cost_req;

// ── provenance ────────────────────────────────────────────────────────────
check('report names the current run dir', report.includes(current));
check('report names the superseded run dir', report.includes(superseded));
check('manifest names the superseded run', M.supersedes?.run === superseded);
check('manifest retains the prior run', M.supersedes?.prior_run_retained === true);
check('superseded run is the one that used LMSYS for cost_req',
  SUP.signals.cost_req.provenance.bundle === 'real-huggingface-lmsys-arena-v1');
check('current run sources cost_req from a real-timestamp bundle',
  cr.provenance.bundle === 'real-burstgpt-v1' && cr.provenance.real_timestamps === true);
check('A6 disclosed for cost_req', cr.provenance.a6_disclosed === true);

// ── §0 verdict table: exactly one signal sourced, and it is cost_req ───────
const sourcedM = Object.entries(F.signals).filter(([, r]) => r.marginal.status === 'sourced').map(([s]) => s);
check('exactly one signal has a sourced marginal', sourcedM.length === 1 && sourcedM[0] === 'cost_req');
check('report says one of six', report.includes('one has a real source in this repo'));
for (const s of ['p99_latency', 'ttft', 'downstream_err', 'tool_success_rate']) {
  check(`${s} is A1 in all three groups`,
    F.signals[s].marginal.criterion === 'A1' && F.signals[s].serial.criterion === 'A1'
    && F.signals[s].periodic.criterion === 'A1');
}
check('eval_score marginal is A2', F.signals.eval_score.marginal.criterion === 'A2');
check('eval_score serial/periodic are A2+A3',
  F.signals.eval_score.serial.criterion === 'A2+A3' && F.signals.eval_score.periodic.criterion === 'A2+A3');
check('eval_score A2 rests on 2 distinct values',
  F.signals.eval_score.marginal.evidence.n_distinct === 2
  && report.includes('exactly 2 distinct values'));

// ── §1 marginal ───────────────────────────────────────────────────────────
check('cv 0.7603', near(cr.marginal.cv, 0.7603, 5e-5) && report.includes('0.7603'));
check('incumbent cv 0.001732', near(cr.marginal.incumbent_cv, 0.001732, 5e-6) && report.includes('0.001732'));
check('ratio 439x', Math.round(cr.marginal.cv / cr.marginal.incumbent_cv) === 439 && report.includes('439×'));
check('skewness 2.946', near(cr.marginal.sample_skewness, 2.946, 5e-4) && report.includes('2.946'));
check('n 34,202', cr.marginal.n === 34202 && report.includes('34,202'));
check('KS lognormal 0.1073', near(cr.marginal.ks_distances.lognormal, 0.1073, 5e-5) && report.includes('0.1073'));
check('KS uniform 0.1352', near(cr.marginal.ks_distances.uniform, 0.1352, 5e-5) && report.includes('0.1352'));
check('KS gamma 0.2394', near(cr.marginal.ks_distances.gamma, 0.2394, 5e-5) && report.includes('0.2394'));
check('no parametric family clears the bar', cr.marginal.best_parametric_ks > cr.marginal.ks_bar);
check('family is empirical', cr.marginal.family === 'empirical' && cr.marginal.empirical_quantiles_z.length === 101);
check('uniform is 2nd of 3 candidates',
  cr.marginal.ks_distances.lognormal < cr.marginal.ks_distances.uniform
  && cr.marginal.ks_distances.uniform < cr.marginal.ks_distances.gamma
  && report.includes('second-worst of the three'));

// ── §1 serial: AR(1) fitted then rejected ─────────────────────────────────
check('serial verdict is ar1_inadequate', cr.serial.status === 'ar1_inadequate');
check('phi 0.2488 not published', near(cr.serial.phi_not_published, 0.2488, 5e-5) && report.includes('0.2488'));
check('CI [0.1325, 0.3494] excludes zero',
  near(cr.serial.ci95_not_published[0], 0.1325, 5e-5) && near(cr.serial.ci95_not_published[1], 0.3494, 5e-5)
  && cr.serial.ci95_not_published[0] > 0 && report.includes('[0.1325, 0.3494]'));
check('|rho2 - phi^2| = 0.1761 > 0.05',
  near(cr.serial.ar1_check.abs_diff, 0.1761, 5e-5) && cr.serial.ar1_check.abs_diff > 0.05
  && report.includes('0.1761'));
const acf = Object.fromEntries(cr.serial.acf_lags_2_5.map((a) => [a.lag, a.rho]));
check('ACF lag2 0.2380', near(acf[2], 0.2380, 5e-5) && report.includes('0.2380'));
check('ACF lag3 0.2239', near(acf[3], 0.2239, 5e-5) && report.includes('0.2239'));
check('ACF lag4 0.2028', near(acf[4], 0.2028, 5e-5) && report.includes('0.2028'));
check('ACF lag5 0.1921', near(acf[5], 0.1921, 5e-5) && report.includes('0.1921'));
check('phi^2 = 0.0619', near(cr.serial.ar1_check.phi_squared, 0.0619, 5e-5) && report.includes('0.0619'));

// ── §1 secondary + periodic ───────────────────────────────────────────────
check('secondary cv 0.8116 / phi 0.4478',
  near(cr.secondary_no_cell_centring.cv, 0.8116, 5e-5)
  && near(cr.secondary_no_cell_centring.phi, 0.4478, 5e-5)
  && report.includes('0.8116') && report.includes('0.4478'));
check('primary phi < secondary phi (the harder reading, as declared)',
  cr.serial.phi_not_published < cr.secondary_no_cell_centring.phi);
check('periodic is A5', cr.periodic.criterion === 'A5' && cr.periodic.status === 'cannot_be_sourced');
const hod = cr.periodic.non_qualifying_hour_of_day;
check('2 diurnal cycles', hod.diurnal_cycles === 2 && report.includes('exactly 2 complete diurnal cycles'));
check('hod amplitude 1.339 passes its bar', near(hod.amplitude, 1.339, 5e-4) && hod.would_pass_amplitude_bar === true
  && report.includes('1.339'));
check('hod split rho 0.371 fails its bar', near(hod.split_rho, 0.371, 5e-4) && hod.would_pass_split_bar === false
  && report.includes('0.371'));
check('dow amplitude 0.131', near(cr.periodic.non_qualifying_day_of_week.amplitude, 0.131, 5e-4)
  && report.includes('0.131'));

// ── §3.3 the defect, and the cross-check ──────────────────────────────────
check('superseded run published a near-zero phi it called adequate',
  SUP.signals.cost_req.serial.status === 'sourced'
  && near(SUP.signals.cost_req.serial.phi, -0.0014, 5e-5) && report.includes('−0.0014'));
const xc = cr.marginal_cross_checks[0];
check('cross-check is LMSYS, failing A3', xc.source === 'real-huggingface-lmsys-arena-v1'
  && xc.bars_failed.includes('A3'));
check('cross-check cv 1.022 / skew 5.60', near(xc.cv, 1.022, 5e-4) && near(xc.sample_skewness, 5.60, 5e-3)
  && report.includes('1.022') && report.includes('5.60'));

// ── §4 post-hoc ───────────────────────────────────────────────────────────
check('1,503 of 34,202 empty buckets (4.39%)',
  P.artifact.empty_buckets === 1503 && P.artifact.total_ticks === 34202
  && near(P.artifact.fraction * 100, 4.39, 5e-3)
  && report.includes('1,503 of 34,202') && report.includes('4.39%'));
check('post-hoc cv drops to 0.7125', near(P.empty_buckets_dropped.cv, 0.7125, 5e-5) && report.includes('0.7125'));
check('post-hoc lag-1 rises to 0.2924', near(P.empty_buckets_dropped.acf[0].rho, 0.2924, 5e-5) && report.includes('0.2924'));
check('post-hoc lag-2 0.2781', near(P.empty_buckets_dropped.acf[1].rho, 0.2781, 5e-5) && report.includes('0.2781'));
check('post-hoc lag-8 0.1821', near(P.empty_buckets_dropped.acf[7].rho, 0.1821, 5e-5) && report.includes('0.1821'));
check('as-preregistered lag-8 0.1551', near(P.primary_as_preregistered.acf[7].rho, 0.1551, 5e-5) && report.includes('0.1551'));
check('AR(1) inadequate both with and without zeros',
  P.primary_as_preregistered.ar1.ar1_adequate === false
  && P.empty_buckets_dropped.ar1.ar1_adequate === false
  && report.includes('verdict survives'));
check('dropping zeros strengthens serial dependence',
  P.empty_buckets_dropped.acf[0].rho > P.primary_as_preregistered.acf[0].rho);

// ── §5 the artifact ───────────────────────────────────────────────────────
check('artifact is version 2 and names the current run', A.version === 2 && A.run === current);
check('artifact carries all six Family A signals', Object.keys(A.signals).length === 6);
check('artifact marks exactly one marginal sourced',
  Object.values(A.signals).filter((s) => s.marginal.status === 'sourced').length === 1);
check('artifact preserves the incumbent constants for the record',
  A.incumbent_model.c.cost_req === 0.006 && A.incumbent_model.provenance.includes('no derivation'));
check('incumbent jitter block still in slow_burn.ts, untouched',
  readFileSync(join(ROOT, 'engine/scenarios/slow_burn.ts'), 'utf8').includes('p99_latency: 1 + 0.008 * Math.random()'));

if (failed) { console.error(`\n${failed} inconsistencies`); process.exit(1); }
console.log(`report consistent with ${current} (${47 - failed} checks)`);
