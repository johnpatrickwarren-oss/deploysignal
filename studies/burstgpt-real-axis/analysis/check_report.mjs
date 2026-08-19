// Machine-check: every number in REPORT.md is pinned to the decisive run's
// results.json. Exit 1 on any drift. Read-only.

import { readFileSync } from 'node:fs';

const RUN = 'studies/burstgpt-real-axis/results/run-20260819T020827Z';
const report = readFileSync('studies/burstgpt-real-axis/REPORT.md', 'utf8');
const r = JSON.parse(readFileSync(`${RUN}/results.json`, 'utf8'));
const e = r.endpoints;

let failures = 0;
function expect(label, cond) {
  if (!cond) {
    failures += 1;
    console.error(`DRIFT: ${label}`);
  }
}
// Prose wraps and uses U+2212 for negative numbers; normalise both sides so
// a check pins the number, not the line break.
const norm = (s) => s.replace(/−/g, '-').replace(/\s+/g, ' ');
const normReport = norm(report);
function has(label, s) {
  expect(`${label} — report lacks "${s}"`, normReport.includes(norm(s)));
}
const f = (x, d) => x.toFixed(d);

// Run identity and supersession chain
has('run id', 'results/run-20260819T020827Z/');
expect('run is executable', r.executable === true);
expect('catch count zero', r.harnessCatchCount === 0);
has('catch count', 'catch count: 0');

// Endpoint S
expect('S executable', e.S.executable === true);
expect('S nonZero', e.S.nonZero === true);
expect('S inadequate', e.S.ar1Adequate === false);
has('S phi', `φ̂ = ${f(e.S.phiHat, 4)}, 95% CI [${f(e.S.ci95.lo, 4)}, ${f(e.S.ci95.hi, 4)}]`);
has('S gap', `0.1145 > 0.05`);
expect('S gap value', f(e.S.adequacyGap, 4) === '0.1145');
has('S cv', `cv: ${f(e.S.withinCellCv, 4)}`);
has('S frame', `${e.S.frame.nUsable.toLocaleString('en-US')} usable ticks in ${e.S.frame.includedCells} included`);
has('S excluded', `${e.S.frame.excludedCells} cells under`);
for (const a of e.S.acf) {
  has(`S acf lag ${a.lag}`, `| ${a.lag} | ${f(a.rho, 4)} | ${a.pairs.toLocaleString('en-US')} | ${f(a.ar1Prediction, 4)} |`);
  expect(`S lag ${a.lag} pair floor`, a.sufficientPairs === true);
}
has('S rho2 vs phi2', `ρ̂₂ = ${f(e.S.acf[1].rho, 4)} against φ̂² = ${f(e.S.phiHat ** 2, 4)}`);
has('S secondary', `φ̂ = ${f(e.S_secondary.phiHat, 4)}, CI [${f(e.S_secondary.ci95.lo, 4)}, ${f(e.S_secondary.ci95.hi, 4)}]`);
has('S secondary cv', `cv ${f(e.S_secondary.withinCellCv, 4)}`);
expect('S secondary inadequate', e.S_secondary.ar1Adequate === false);

// Endpoint D
expect('D published', e.D.sharePublished === true);
expect('D components positive', e.D.componentsPositive === true);
has('D intercept', `| σ̂²_B (between-bucket, intercept) | ${e.D.intercept.toExponential(4)} |`);
has('D slope', `| σ̂²_W (per-request, slope) | ${e.D.slope.toExponential(4)} |`);
has('D mean inv n', `| mean(1/n_t) | ${f(e.D.meanInvN, 4)} |`);
has('D total var', `| total within-cell variance | ${e.D.totalWithinCellVar.toExponential(4)} |`);
has('D share', `**averaging-noise share ŝ** | **${f(e.D.share, 4)}**`);
has('D between share', `**between-bucket share** | **${f(1 - e.D.share, 4)}**`);
has('D between cv', `**${f(e.D.betweenCv, 4)}**`);
has('D total cv', `| total cv in this frame | ${f(e.D.totalCvThisFrame, 4)} |`);
has('D mean cost', `| mean observed cost | ${f(e.D.meanObservedCost, 5)} USD/request |`);
has('D adequacy', `Pearson ${f(e.D.adequacyPearson, 4)} across all ${e.D.survivingBins} occupancy bins`);
expect('D adequacy pass', e.D.adequacyPass === true);
has('D spearman', `${f(e.D.spearmanCostOccupancy, 4)}`);
has('D headline share pct', `69.0% of the`);
expect('D share is 69.0%', (e.D.share * 100).toFixed(1) === '69.0');

// Endpoint R
expect('R nonZero', e.R.serial.nonZero === true);
expect('R adequate', e.R.serial.ar1Adequate === true);
has('R phi', `φ̂ = ${f(e.R.serial.phiHat, 4)}, CI [${f(e.R.serial.ci95.lo, 4)}, ${f(e.R.serial.ci95.hi, 4)}]`);
has('R gap', `${f(e.R.serial.adequacyGap, 4)} ≤ 0.05`);
has('R cv', `within-cell cv ${f(e.R.serial.withinCellCv, 4)}`);
has('R frame', `${e.R.serial.frame.nUsable.toLocaleString('en-US')} usable ticks in ${e.R.serial.frame.includedCells} cells`);
expect('R zero-mean cells', e.R.serial.frame.zeroMeanCells === 6);
has('R zero-mean cells named', 'the 6\nall-idle');
expect('R periodic not present', e.R.periodic.present === false);
has('R amplitude', `amplitude ${f(e.R.periodic.amplitude, 4)}`);
has('R split-half', `**${f(e.R.periodic.splitHalfPearson, 4)} < 0.5**`);

// Instruments and gate
for (const c of r.instruments) expect(`instrument ${c.id} pass`, c.pass === true);
const byId = Object.fromEntries(r.instruments.map((c) => [c.id, c]));
has('I1 recovery', `recovered φ = 0.25 as ${f(byId.I1.phiHat, 4)}`);
has('I2 value', `φ̂ = ${f(byId.I2.phiHat, 4)}`);
has('I3 naive', `${f(byId.I3.naiveLag1, 3)} vs ${f(byId.I3.awarePhiHat, 3)}`);
has('I4 recovery', `0.2/0.8 as ${f(byId.I4a.share, 4)}/${f(byId.I4b.share, 4)}`);
has('I5 value', `${f(byId.I5.share, 4)} ≤ 0.05`);
expect('gate G1', r.gate.G1_sha256.pass === true);
expect('gate G2', r.gate.G2_structure.pass === true);
expect('gate G3', r.gate.G3_instruments.pass === true);

// Verdict table rows
has('S-V1 verdict', '**NON-ZERO** (CI excludes 0) |');
has('S-V2 verdict', '| **INADEQUATE** |');
has('D-V1 verdict', '**PUBLISHED** (all gates passed) |');
has('R-V2 verdict', '| **ADEQUATE** |');
has('R-V3 verdict', '**NOT PRESENT** (replication bar failed) |');

if (failures > 0) {
  console.error(`check_report: ${failures} drift(s)`);
  process.exit(1);
}
console.log('check_report: all report numbers match the run artifacts');
