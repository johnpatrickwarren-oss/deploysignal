// posthoc_matched_prior.mjs — POST-HOC DIAGNOSTIC, NOT PRE-REGISTERED. NO VERDICT ATTACHES.
//
// E1's primary run measured the classical arm with the SHIPPED τ² derivation, which is
// μ-dominated on this corpus (τ/σ = 0.0866/c ≈ 2.9–10.8σ per signal). This rerun forces
// τ² = σ̂² on the identical trajectories — the runway-A1 pattern (force the family, identical
// cell) — to separate "cost of the bound" from "mistuned prior". Report §4 only.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const require_ = createRequire(import.meta.url);
const ENG = join(REPO, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'dist', 'detectors');
const pc = require_(join(ENG, 'page-cusum.js'));
const mix = require_(join(ENG, 'family-a-mixture-supermartingale.js'));

const DELTAS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0];
const ALPHA = (4e-4 / 6) * 0.5;
const T_TOTAL = 100, T_INJECT = 30, CALIB = 500;
const SIGNALS = { p99_latency: 0.008, ttft: 0.008, cost_req: 0.006, downstream_err: 0.03 };

function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function fnv1a(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193);}return h>>>0;}
function meanSigma(v){let s=0;for(const x of v)s+=x;const m=s/v.length;let q=0;for(const x of v){const d=x-m;q+=d*d;}return{mean:m,sigma:Math.sqrt(q/v.length)};}

const scenarios = JSON.parse(readFileSync(join(REPO,'runs','adversarial-scenarios.json')));
const cells = {};
for (const arm of ['classical_matched','mixture']) for (const d of DELTAS) cells[`${arm}|${d}`]={trials:0,det:0};

for (const sc of scenarios) for (const [sig,c] of Object.entries(SIGNALS)) {
  const base = sc.baseline?.[sig];
  if (typeof base !== 'number' || base <= 0) continue;
  for (const delta of DELTAS) {
    const rng = mulberry32(fnv1a(`${sc.id}|${sig}|${delta}`));   // same seeds as the primary run
    const healthy = () => base * (1 + c * rng());
    const calib = Array.from({length: CALIB}, healthy);
    const { mean: mu, sigma } = meanSigma(calib);
    const traj = Array.from({length: T_TOTAL}, (_, t) => healthy() + (t >= T_INJECT ? delta*sigma : 0));

    const cst = pc.freshCUSUM();
    const cparams = { alpha: ALPHA, tau_squared: sigma*sigma,    // MATCHED prior — the forced change
      min_ticks_before_eligible: 0, min_observation_window: 0,
      derivation: { empirical_variance: sigma*sigma } };
    const mst = mix.freshMixtureSupermartingaleState();
    const mparams = { mixture_distribution:'gaussian', gaussian_sigma_squared_prior: sigma*sigma, ar1_phi: 0 };
    const steps = {
      classical_matched: (x) => pc.evaluateCUSUM({signal:'s',params:cparams,state:cst,trafficPct:100,trafficGate:0,ticksSinceDeploy:999,deployAgeDays:1}, x-mu).verdict==='fire',
      mixture: (x) => mix.evaluatePageCusumMixtureSupermartingale({x_centered:x-mu,live_value:x,baseline_mean:mu,sigma_squared:sigma*sigma,params:mparams,state:mst,alpha:ALPHA,ar1_phi:0}).fire===true,
    };
    for (const [arm, step] of Object.entries(steps)) {
      const cell = cells[`${arm}|${delta}`]; cell.trials++;
      for (let t = 0; t < T_TOTAL; t++) if (step(traj[t])) { if (t >= T_INJECT) cell.det++; break; }
    }
  }
}
console.log('POST-HOC (no verdict): classical with tau^2 = sigma^2, identical trajectories');
for (const d of DELTAS) {
  const cm = cells[`classical_matched|${d}`], mx = cells[`mixture|${d}`];
  console.log(`  δ=${String(d).padEnd(4)} classical_matched=${(cm.det/cm.trials).toFixed(3)} mixture=${(mx.det/mx.trials).toFixed(3)} gap=${((cm.det/cm.trials)-(mx.det/mx.trials)).toFixed(3)}`);
}
