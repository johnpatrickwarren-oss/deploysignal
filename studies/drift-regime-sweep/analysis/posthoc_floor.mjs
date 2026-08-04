// posthoc_floor.mjs — POST-HOC DIAGNOSTIC, NOT PRE-REGISTERED. NO VERDICT ATTACHES.
//
// The frozen grid never found the Ville arms' drift floor: both detect 100% at every
// pre-registered slope. This locates the floor with below-grid slopes so the E1 "no
// complementarity window" verdict carries a number: the width of the band where the
// Ville arms detect and slowbleed is blind. Same seeds scheme, same adapters.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const require_ = createRequire(import.meta.url);
const ENG = join(REPO, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'dist');
const bet = require_(join(ENG, 'detectors', 'betting-e-process.js'));
const mix = require_(join(ENG, 'detectors', 'family-a-mixture-supermartingale.js'));

const SLOPES = [0.000005, 0.00001, 0.00002, 0.00005, 0.0001];  // below the frozen grid
const ALPHA = (4e-4 / 6) * 0.5;
const T_TOTAL = 100, T_INJECT = 30, CALIB = 500;
const SIGNALS = { p99_latency: 0.008, ttft: 0.008, cost_req: 0.006, downstream_err: 0.03 };
const DRIFT4 = Object.keys(SIGNALS);

function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function fnv1a(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193);}return h>>>0;}
function meanSigma(v){let s=0;for(const x of v)s+=x;const m=s/v.length;let q=0;for(const x of v){const d=x-m;q+=d*d;}return{mean:m,sigma:Math.sqrt(q/v.length)};}

function makeBetting(mu, sigma) {
  const st = bet.freshBettingState();
  const params = { derivation: { mean: mu, empirical_variance: sigma * sigma, ar1_phi: 0 },
    min_ticks_before_eligible: 0, min_observation_window: 0 };
  return (x) => bet.evaluateBettingEProcess({ signal: 's', params, state: st,
    alphaBetting: ALPHA, ticksSinceDeploy: 999, trafficPct: 100 }, x - mu).verdict === 'fire';
}
function makeMixture(mu, sigma) {
  const st = mix.freshMixtureSupermartingaleState();
  const params = { mixture_distribution: 'gaussian',
    gaussian_sigma_squared_prior: sigma * sigma, ar1_phi: 0 };
  return (x) => mix.evaluatePageCusumMixtureSupermartingale({ x_centered: x - mu, live_value: x,
    baseline_mean: mu, sigma_squared: sigma * sigma, params, state: st, alpha: ALPHA,
    ar1_phi: 0 }).fire === true;
}

const scenarios = JSON.parse(readFileSync(join(REPO, 'runs', 'adversarial-scenarios.json')));
const cells = {};
for (const arm of ['mixture4', 'betting4']) for (const s of SLOPES)
  cells[`${arm}|${s}`] = { trials: 0, det: 0, fa: 0 };

for (const sc of scenarios) {
  if (!DRIFT4.every((k) => typeof sc.baseline?.[k] === 'number' && sc.baseline[k] > 0)) continue;
  for (const slope of SLOPES) {
    const traj = {}, mus = {}, sigmas = {};
    for (const [sig, c] of Object.entries(SIGNALS)) {
      const base = sc.baseline[sig];
      const rng = mulberry32(fnv1a(`${sc.id}|${sig}|${slope}`));
      const healthy = () => base * (1 + c * rng());
      const calib = Array.from({ length: CALIB }, healthy);
      const { mean, sigma } = meanSigma(calib);
      mus[sig] = mean; sigmas[sig] = sigma;
      traj[sig] = Array.from({ length: T_TOTAL }, (_, t) =>
        healthy() * (t >= T_INJECT ? (1 + slope * (t - T_INJECT)) : 1));
    }
    for (const [arm, make] of [['mixture4', makeMixture], ['betting4', makeBetting]]) {
      const steps = Object.fromEntries(DRIFT4.map((s) => [s, make(mus[s], sigmas[s])]));
      const cell = cells[`${arm}|${slope}`];
      cell.trials++;
      let outcome = null;
      for (let t = 0; t < T_TOTAL && outcome === null; t++)
        for (const sig of DRIFT4)
          if (steps[sig](traj[sig][t])) { outcome = t < T_INJECT ? 'fa' : t; break; }
      if (outcome === 'fa') cell.fa++;
      else if (outcome !== null) cell.det++;
    }
  }
}
console.log('POST-HOC (no verdict): the Ville arms\' drift floor, below-grid slopes');
for (const s of SLOPES) {
  const m = cells[`mixture4|${s}`], b = cells[`betting4|${s}`];
  console.log(`  s=${String(s).padEnd(8)} mixture4=${(m.det/m.trials).toFixed(3)} (fa ${m.fa})  betting4=${(b.det/b.trials).toFixed(3)} (fa ${b.fa})`);
}
