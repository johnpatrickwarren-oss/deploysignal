// check_report.mjs — machine-checks REPORT.md against the run's endpoints.json and cells.json.
// Exit 1 on any drift between prose and data.
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
const M = JSON.parse(readFileSync(join(STUDY, 'results', run, 'manifest.json')));
const A = M.alpha_primary, A2 = 0.05;
const cell = (arm, cls, sev, a = A) => C[`${arm}|${cls}|${sev}|${a}`];
const rate = (arm, cls, sev, a = A) => cell(arm, cls, sev, a).detection_rate;

let failed = 0;
const check = (name, ok) => { if (!ok) { console.error(`FAIL ${name}`); failed++; } };

check('report names the run dir', report.includes(run));
check('report names the deploysignal sha', report.includes(M.deploysignal_sha));
check('engine installed 0.6.9-pre', M.engine_installed_version === '0.6.9-pre' && report.includes('installed 0.6.9-pre'));
check('zero exceptions', M.exceptions_total === 0 && report.includes('Exceptions: 0'));
check('runtime 18.4 s', Math.abs(M.runtime_ms / 1000 - 18.4) < 0.1 && report.includes('18.4 s'));

// E1
check('E1 PASS', E.E1.pass === true && E.E1.d_valid_k1_canonical.arm === 'safe_t' && E.E1.d_valid_k1_canonical.rate === 1
  && E.E1.delta_star_valid === 1 && report.includes('E1: D_valid(K1,1.5sigma)=1.0000 arm=safe_t floor=0.50 delta*_valid=1sigma verdict=PASS'));
// E2
const tx = E.E2.taxes;
check('E2 PASS', E.E2.pass === true && tx.K1.tax === 0 && tx.K2.tax === 0.2214 && tx.K5.tax === 0.0057 && tx.K3.tax === 0 && tx.K4.tax === 0.0019 && tx.K6.tax === 0
  && report.includes('E2: tax K1=0.0000 K2(K=4)=0.2214 K5=0.0057 | K3=0.0000 K4=0.0019 K6=0.0000 verdict=PASS'));
// E3
check('E3 PASS', E.E3.pass === true && E.E3.rows[0].betting_shipped === 0.7099 && E.E3.rows[1].valid.rate === 0.0095 && E.E3.rows[1].betting_shipped === 0
  && report.includes('E3: 1.5sigma valid=1.0000 shipped=0.7099 | 0.5sigma valid=0.0095 shipped=0.0000 verdict=PASS'));
// E4
const e4 = E.E4.arms;
check('E4 valid arms 0 crossings', ['safe_t', 'universal_inference', 'sequential_ui'].every((a) => e4[a].crossings === 0 && e4[a].pass === true)
  && report.includes('E4: safe_t=0.0000 universal_inference=0.0000 sequential_ui=0.0000 passing=safe_t,universal_inference,sequential_ui'));
check('E4 plug-in rates', e4.mixture.crossings === 9 && e4.betting.crossings === 20 && e4.betting_shipped.crossings === 0
  && e4.mixture.rate === 0.0172 && e4.betting.rate === 0.0382 && e4.safe_t.bound === 0.069
  && report.includes('| mixture | 9 | 0.0172 |') && report.includes('| betting | 20 | 0.0382 |'));
// ship rule
check('ship rule routes safe_t', E.ship_rule.a_routes === true && E.ship_rule.routed_arm === 'safe_t' && E.ship_rule.voided_cells.length === 0
  && report.includes('ship_rule: a_routes=true routed_arm=safe_t'));

// headline K1 table rows vs cells
const k1 = (d) => ['safe_t', 'universal_inference', 'sequential_ui', 'mixture', 'betting', 'betting_shipped'].map((a) => rate(a, 'K1', `${d}sigma`));
check('K1 1.5sigma row', JSON.stringify(k1(1.5)) === JSON.stringify([1, 0.4752, 0.458, 1, 0.9885, 0.7099]) && report.includes('| **1.5** | **1.0000** | 0.4752 | 0.4580 (50) | **1.0000** (25) | 0.9885 (38) | **0.7099** (61) |'));
check('K1 0.75sigma row', JSON.stringify(k1(0.75)) === JSON.stringify([0.2958, 0.0172, 0.0115, 0.5954, 0.3874, 0]) && report.includes('| 0.75 | 0.2958 | 0.0172 | 0.0115 (66) | 0.5954 (51) | 0.3874 (57) | 0.0000 |'));
check('K1 1sigma row', JSON.stringify(k1(1)) === JSON.stringify([0.8073, 0.1355, 0.0992, 0.9676, 0.8359, 0.0324]) && report.includes('| 1.0 | 0.8073 | 0.1355 | 0.0992 (61) | 0.9676 (41) | 0.8359 (53) | 0.0324 (63) |'));
check('K1 3sigma plateau', rate('universal_inference', 'K1', '3sigma') === 0.6069 && rate('sequential_ui', 'K1', '3sigma') === 0.4981 && report.includes('| 3.0 | 1.0000 | 0.6069 | 0.4981 (25) | 1.0000 (10) | 1.0000 (24) | 0.9924 (41) |'));
check('K1 TTD medians', cell('mixture', 'K1', '1.5sigma').median_ttd === 25 && cell('betting', 'K1', '1.5sigma').median_ttd === 38 && cell('sequential_ui', 'K1', '1.5sigma').median_ttd === 50 && cell('betting_shipped', 'K1', '1.5sigma').median_ttd === 61);
// K2, K5
check('K2 canonical row', rate('safe_t', 'K2', 'K4-e0.5sigma') === 0.0687 && rate('mixture', 'K2', 'K4-e0.5sigma') === 0.2901 && rate('betting', 'K2', 'K4-e0.5sigma') === 0.2061 && report.includes('| **0.5** | **0.0687** | 0.0000 | 0.0000 | **0.2901** (58) | 0.2061 (60) | 0.0000 |'));
check('K2 0.75 row', rate('safe_t', 'K2', 'K4-e0.75sigma') === 0.7099 && rate('mixture', 'K2', 'K4-e0.75sigma') === 0.9847 && report.includes('| 0.75 | 0.7099 | 0.0687 | 0.0153 (68) | 0.9847 (45) | 0.8244 (55) | 0.0000 |'));
check('K5 canonical row', rate('safe_t', 'K5', 'slope0.01') === 0.0019 && rate('mixture', 'K5', 'slope0.01') === 0.0076 && rate('betting', 'K5', 'slope0.01') === 0.0057 && report.includes('| **1×10⁻²** | 0.69σ | **0.0019** | 0.0000 | 0.0000 | **0.0076** (67) | 0.0057 (67) | 0.0000 |'));
check('K5 2e-2 row', rate('safe_t', 'K5', 'slope0.02') === 0.1393 && rate('mixture', 'K5', 'slope0.02') === 0.4008 && rate('betting', 'K5', 'slope0.02') === 0.1794 && report.includes('| 2×10⁻² | 1.38σ | 0.1393 | 0.0019 | 0.0000 | 0.4008 (63) | 0.1794 (65) | 0.0000 |'));
// K3/K4/K6 valid arms all zero; plug-in K4 0.0019
const k346 = Object.keys(C).filter((k) => /\|(K3|K4|K6)\|/.test(k) && k.endsWith(`|${A}`));
check('K3/K4/K6 valid arms zero', k346.filter((k) => /^(safe_t|universal_inference|sequential_ui)\|/.test(k)).every((k) => C[k].detection_rate === 0));
check('K4 5sigma plug-in 0.0019', rate('mixture', 'K4', '5sigma-point') === 0.0019 && rate('betting', 'K4', '5sigma-point') === 0.0019 && rate('mixture', 'K4', '8sigma-point') === 0.0019);
// counts and false alarms
const prim = Object.entries(C).filter(([k]) => k.endsWith(`|${A}`));
const trials = prim.reduce((s, [, c]) => s + c.trials, 0);
check('80,958 arm-trials per alpha', trials === 80958 && report.includes('80,958 arm-trials'));
check('0 false alarms at primary alpha', prim.every(([, c]) => c.false_alarms === 0) && report.includes('False alarms at the primary α: 0'));
check('524 / 131 trials', cell('safe_t', 'K1', '1.5sigma').trials === 524 && cell('safe_t', 'K2', 'K4-e0.5sigma').trials === 131);
check('null cell all zero', ['safe_t', 'universal_inference', 'sequential_ui', 'mixture', 'betting', 'betting_shipped'].every((a) => rate(a, 'null', 'none') === 0));
// E5 table
const e5 = Object.fromEntries(E.E5.rows.map((r) => [r.severity, r]));
check('E5 rows', e5['1.5sigma'].sequential_ui.median_ttd === 50 && e5['1.5sigma'].mixture.median_ttd === 25 && e5['1.5sigma'].betting.median_ttd === 38
  && e5['3sigma'].sequential_ui.median_ttd === 25 && e5['3sigma'].mixture.median_ttd === 10 && e5['3sigma'].betting.median_ttd === 24
  && e5['1sigma'].sequential_ui.median_ttd === 61 && report.includes('| 1.0 | 61 | 41 | 53 |') && report.includes('| 3.0 | 25 | 10 | 24 |'));
check('E5 detections 240-261', e5['1.5sigma'].sequential_ui.detections === 240 && e5['3sigma'].sequential_ui.detections === 261);

if (failed) { console.error(`${failed} inconsistencies`); process.exit(1); }
console.log(`report consistent with ${run} (27 checks)`);
