// C56 decisive run: instrument checks, then the executability gate, then the
// endpoints, in one invocation (PREREGISTRATION.md §8 rule 7). The UTC stamp
// is supplied by the shell (--stamp); this file never reads the clock.
// No catch blocks anywhere: any exception aborts the run loudly.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  mulberry32, gaussian, sha256File, loadBundle, mean,
  buildFrame, pairwiseAcf, phiHat, bootstrapPhiCI, decompose,
  hourProfile, naiveAcf,
} from './lib.mjs';

const BUNDLE = 'runs/baselines/real-burstgpt-v2/bundle.jsonl';
const PINNED_SHA = '1b7b8ec46bbdac4edf4590c885950801d6236826f6ead406c59d3bc8b2241d90';
const MIN_CELL_TICKS = 30;
const MAX_LAG = 8;
const BOOT = { blockLen: 720, nBoot: 1000, seed: 42 };
const ADEQUACY_BAR = 0.05;
const MIN_PAIRS = 2000;

const stampIdx = process.argv.indexOf('--stamp');
if (stampIdx < 0 || !process.argv[stampIdx + 1]) {
  console.error('usage: node run_study.mjs --stamp <UTC-stamp>');
  process.exit(1);
}
const stamp = process.argv[stampIdx + 1];
const outDir = `studies/burstgpt-real-axis/results/run-${stamp}`;
if (existsSync(outDir)) {
  console.error(`refusing to overwrite existing run dir: ${outDir}`);
  process.exit(1);
}

const bundle = loadBundle(BUNDLE);
const N = bundle.cost.length;
const observed = bundle.counts.map((c) => c > 0);

// ---------------------------------------------------------------- instruments
// Synthetic truths use the real observation pattern (counts/hod/dow only);
// no statistic of cost_req is computed before the gate.

function syntheticFrame(values) {
  return buildFrame({ values, observed, hod: bundle.hod, dow: bundle.dow, minCellTicks: MIN_CELL_TICKS, centre: true });
}

const instruments = [];
function check(id, pass, detail) {
  instruments.push({ id, pass, ...detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}`, JSON.stringify(detail));
}

// I1: AR(1) φ=0.25 masked by the real pattern; estimator must recover it and
// the adequacy check must pass.
{
  const rng = mulberry32(101);
  const phi = 0.25;
  const x = new Array(N);
  let prev = gaussian(rng) / Math.sqrt(1 - phi * phi);
  for (let t = 0; t < N; t++) {
    prev = phi * prev + gaussian(rng) * 1;
    x[t] = 10 + prev;
  }
  const f = syntheticFrame(x);
  const { phi: est } = phiHat(f);
  const { rho } = pairwiseAcf(f, 2);
  const adequate = Math.abs(rho[1].rho - est * est) <= ADEQUACY_BAR;
  check('I1', Math.abs(est - phi) <= 0.03 && adequate, { phiHat: est, rho2: rho[1].rho, adequate });
}

// I2 + I3: white noise masked by the real pattern; the registered estimator
// must stay flat while the naive zero-filled ACF manufactures dependence.
{
  const rng = mulberry32(102);
  const x = new Array(N);
  for (let t = 0; t < N; t++) x[t] = 10 + gaussian(rng);
  const f = syntheticFrame(x);
  const { phi: est } = phiHat(f);
  const { rho } = pairwiseAcf(f, MAX_LAG);
  const maxAbsRho = Math.max(...rho.map((r) => Math.abs(r.rho)));
  check('I2', Math.abs(est) <= 0.02 && maxAbsRho <= 0.03, { phiHat: est, maxAbsRho });

  const zeroFilled = x.map((v, t) => (observed[t] ? v : 0));
  const naive1 = naiveAcf(zeroFilled, 1)[0];
  check('I3', naive1 >= 0.1 && Math.abs(est) <= 0.02, { naiveLag1: naive1, awarePhiHat: est });
}

// I4a/I4b/I5: decomposition recovery at known averaging shares, real n_t.
function decompositionInstrument(id, seed, targetShare) {
  const rng = mulberry32(seed);
  const invMean = mean(bundle.counts.filter((c) => c > 0).map((c) => 1 / c));
  const sigmaW2 = targetShare > 0 ? 0.25 : 0;
  const sigmaB2 = targetShare > 0 ? (sigmaW2 * invMean * (1 - targetShare)) / targetShare : 0.25;
  const x = new Array(N).fill(0);
  for (let t = 0; t < N; t++) {
    if (!observed[t]) continue;
    const mu = 10 + Math.sqrt(sigmaB2) * gaussian(rng);
    x[t] = mu + (sigmaW2 > 0 ? Math.sqrt(sigmaW2 / bundle.counts[t]) * gaussian(rng) : 0);
  }
  const f = syntheticFrame(x);
  const dec = decompose({ values: x, counts: bundle.counts, usable: f.usable, mcell: f.mcell });
  const pass = targetShare > 0 ? Math.abs(dec.share - targetShare) <= 0.1 : dec.share <= 0.05;
  check(id, pass, { share: dec.share, targetShare });
}
decompositionInstrument('I4a', 104, 0.2);
decompositionInstrument('I4b', 105, 0.8);
decompositionInstrument('I5', 106, 0);

const instrumentsPass = instruments.every((c) => c.pass);

// ----------------------------------------------------------------------- gate
const bundleSha = sha256File(BUNDLE);
const countZeroTicks = bundle.counts.filter((c) => c === 0).length;
const zeroCostObserved = bundle.cost.filter((c, t) => observed[t] && c === 0).length;
const gate = {
  G1_sha256: { got: bundleSha, want: PINNED_SHA, pass: bundleSha === PINNED_SHA },
  G2_structure: {
    ticks: N,
    lengthsMatch: [bundle.counts, bundle.hod, bundle.dow].every((a) => a.length === N),
    sumCounts: bundle.counts.reduce((a, b) => a + b, 0),
    countZeroTicks,
    zeroCostObserved,
    pass:
      N === 174234 &&
      [bundle.counts, bundle.hod, bundle.dow].every((a) => a.length === N) &&
      bundle.counts.reduce((a, b) => a + b, 0) === 200000 &&
      countZeroTicks === 140032 &&
      zeroCostObserved === 1503,
  },
  G3_instruments: { pass: instrumentsPass },
};
const executable = gate.G1_sha256.pass && gate.G2_structure.pass && gate.G3_instruments.pass;
console.log(executable ? 'study is EXECUTABLE' : 'study is NOT-EXECUTABLE');

let endpoints = null;
if (executable) {
  // ------------------------------------------------------------- endpoint S
  function serialEndpoint(values, obs, centre) {
    const f = buildFrame({ values, observed: obs, hod: bundle.hod, dow: bundle.dow, minCellTicks: MIN_CELL_TICKS, centre });
    const acf = pairwiseAcf(f, MAX_LAG);
    const { phi, pairs } = phiHat(f);
    const ci = bootstrapPhiCI(f, BOOT);
    const rho2 = acf.rho[1].rho;
    return {
      frame: {
        nUsable: f.nUsable, includedCells: f.includedCells,
        excludedCells: f.excludedCells, excludedTicks: f.excludedTicks,
      },
      withinCellCv: Math.sqrt(acf.sigma2),
      acf: acf.rho.map((r) => ({ lag: r.lag, rho: r.rho, pairs: r.pairs, ar1Prediction: phi ** r.lag, sufficientPairs: r.pairs >= MIN_PAIRS })),
      phiHat: phi, lag1Pairs: pairs,
      ci95: { lo: ci.lo, hi: ci.hi },
      adequacyGap: Math.abs(rho2 - phi * phi),
      ar1Adequate: Math.abs(rho2 - phi * phi) <= ADEQUACY_BAR,
      nonZero: ci.lo > 0 || ci.hi < 0,
      executable: acf.rho[0].pairs >= MIN_PAIRS && acf.rho[1].pairs >= MIN_PAIRS,
    };
  }

  const S = serialEndpoint(bundle.cost, observed, true);
  const S_secondary = serialEndpoint(bundle.cost, observed, false);

  // ------------------------------------------------------------- endpoint D
  const costFrame = buildFrame({ values: bundle.cost, observed, hod: bundle.hod, dow: bundle.dow, minCellTicks: MIN_CELL_TICKS, centre: true });
  const dec = decompose({ values: bundle.cost, counts: bundle.counts, usable: costFrame.usable, mcell: costFrame.mcell });
  const meanObservedCost = mean(bundle.cost.filter((c, t) => costFrame.usable[t]));
  const D = {
    ...dec,
    betweenCv: dec.intercept > 0 ? Math.sqrt(dec.intercept) / meanObservedCost : NaN,
    totalCvThisFrame: Math.sqrt(dec.totalWithinCellVar) / meanObservedCost,
    meanObservedCost,
    componentsPositive: dec.intercept > 0 && dec.slope > 0,
    adequacyPass: dec.survivingBins >= 3 && dec.adequacyPearson >= 0.5,
  };
  D.sharePublished = D.componentsPositive && D.adequacyPass;

  // ------------------------------------------------------------- endpoint R
  const allObserved = new Array(N).fill(true);
  const R_serial = serialEndpoint(bundle.counts, allObserved, true);
  const R_periodic = hourProfile(bundle.counts, bundle.hod);
  const R = {
    serial: R_serial,
    periodic: {
      ...R_periodic,
      present: R_periodic.amplitude >= 0.05 && R_periodic.splitHalfPearson >= 0.5,
    },
  };

  endpoints = { S, S_secondary, D, R };
}

// --------------------------------------------------------------------- write
mkdirSync(outDir, { recursive: true });
const results = { studyId: '2026-08-burstgpt-real-axis', executable, instruments, gate, endpoints, harnessCatchCount: 0 };
writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 2));
const manifest = {
  stamp,
  repoSha: execSync('git rev-parse HEAD').toString().trim(),
  bundle: BUNDLE,
  bundleSha256: bundleSha,
  node: process.version,
  command: process.argv.slice(1).join(' '),
  seeds: { bootstrap: BOOT.seed, instruments: { I1: 101, I2: 102, I4a: 104, I4b: 105, I5: 106 } },
  bootstrap: BOOT,
  model_calls: 'none',
  network: 'none',
};
writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`written: ${outDir}`);
