// run_sweep.mjs — the effect-size sweep, per PREREGISTRATION.md (frozen 2026-07-31, engine
// resolved to v0.6.6-pre in §1). Endpoints E1/E2/E3; grid and arms frozen there.
//
// Interpretation decisions the pre-registration left open are listed in REPORT.md §3 and made
// here, once, in code: four signals (the corpus defines a noise model only for these), corpus
// multiplicative-jitter generator, calibration window 500, paired trajectories across arms,
// analytical 1/α thresholds (not the shipped bootstrap substitution), shipped τ² derivation for
// the classical arm. No Math.random anywhere — every draw is seeded per (scenario, signal, δ).
//
// Usage: node studies/effect-size-sweep/analysis/run_sweep.mjs
// Append-only: refuses an existing results/run-<UTC>/ dir.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const require_ = createRequire(import.meta.url);
const ENG = join(REPO, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'dist', 'detectors');
const pc = require_(join(ENG, 'page-cusum.js'));
const bet = require_(join(ENG, 'betting-e-process.js'));
const mix = require_(join(ENG, 'family-a-mixture-supermartingale.js'));

// ── frozen by the pre-registration ─────────────────────────────────────────
const DELTAS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0];
const ALPHA = (4e-4 / 6) * 0.5;           // per-signal shipped allocation = 3.333e-5
const T_TOTAL = 100, T_INJECT = 30;       // documented suite convention
const CALIB = 500;                        // interpretation decision (REPORT §3)

// Corpus jitter model (engine/scenarios/slow_burn.ts healthy-infra block). The corpus defines no
// noise model for eval_score / tool_success_rate → excluded, per the fallback-not-invent rule.
const SIGNALS = { p99_latency: 0.008, ttft: 0.008, cost_req: 0.006, downstream_err: 0.03 };

// ── seeded RNG (mulberry32, the calibrators' own primitive) ────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function meanSigma(v) {  // inject-regression.ts:_meanSigma, verbatim semantics
  let sum = 0; for (const x of v) sum += x;
  const mean = sum / v.length;
  let sq = 0; for (const x of v) { const d = x - mean; sq += d * d; }
  return { mean, sigma: Math.sqrt(sq / v.length) };
}

// ── arms ───────────────────────────────────────────────────────────────────
function makeClassical(mu, sigma) {
  const st = pc.freshCUSUM();
  const dmin = Math.max(0.05 * Math.abs(mu), 2 * sigma);        // shipped derivation
  const params = { alpha: ALPHA, tau_squared: (dmin * dmin) / 4,
    min_ticks_before_eligible: 0, min_observation_window: 0,
    derivation: { empirical_variance: sigma * sigma } };
  return (x) => pc.evaluateCUSUM({ signal: 's', params, state: st, trafficPct: 100,
    trafficGate: 0, ticksSinceDeploy: 999, deployAgeDays: 1 }, x - mu).verdict === 'fire';
}
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
    gaussian_sigma_squared_prior: sigma * sigma, ar1_phi: 0 };  // = deriveMixtureSupermartingaleParams (raw variance)
  return (x) => mix.evaluatePageCusumMixtureSupermartingale({ x_centered: x - mu, live_value: x,
    baseline_mean: mu, sigma_squared: sigma * sigma, params, state: st, alpha: ALPHA,
    ar1_phi: 0 }).fire === true;                                 // phi read off INPUT — battery-verified threading
}
const ARMS = { classical: makeClassical, betting: makeBetting, mixture: makeMixture };

// ── the sweep ──────────────────────────────────────────────────────────────
const scenarioPath = join(REPO, 'runs', 'adversarial-scenarios.json');
const scenarioRaw = readFileSync(scenarioPath);
const scenarios = JSON.parse(scenarioRaw);

const cells = {};   // `${arm}|${delta}` -> {trials, detections, false_alarms, ttds: []}
for (const arm of Object.keys(ARMS)) for (const d of DELTAS)
  cells[`${arm}|${d}`] = { trials: 0, detections: 0, false_alarms: 0, ttds: [] };

for (const sc of scenarios) {
  for (const [sig, c] of Object.entries(SIGNALS)) {
    const base = sc.baseline?.[sig];
    if (typeof base !== 'number' || base <= 0) continue;
    for (const delta of DELTAS) {
      const rng = mulberry32(fnv1a(`${sc.id}|${sig}|${delta}`));
      const healthy = () => base * (1 + c * rng());              // corpus jitter model
      const calib = Array.from({ length: CALIB }, healthy);
      const { mean: mu, sigma } = meanSigma(calib);
      // one trajectory, shared by all three arms (paired comparison)
      const traj = Array.from({ length: T_TOTAL }, (_, t) =>
        healthy() + (t >= T_INJECT ? delta * sigma : 0));
      for (const [arm, make] of Object.entries(ARMS)) {
        const step = make(mu, sigma);
        const cell = cells[`${arm}|${delta}`];
        cell.trials++;
        let outcome = null;
        for (let t = 0; t < T_TOTAL; t++) {
          if (step(traj[t])) { outcome = t < T_INJECT ? 'fa' : t; break; }
        }
        if (outcome === 'fa') cell.false_alarms++;
        else if (outcome !== null) { cell.detections++; cell.ttds.push(outcome - T_INJECT); }
      }
    }
  }
}

// ── endpoints (thresholds frozen) ──────────────────────────────────────────
const D = (arm, d) => { const c = cells[`${arm}|${d}`]; return c.detections / c.trials; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

const gaps = DELTAS.map((d) => D('classical', d) - D('mixture', d));
const e1_monotone = gaps.every((g, i) => i === 0 || g <= gaps[i - 1] + 1e-12);
const e1_magnitude = gaps[0] - gaps[gaps.length - 1] >= 0.10;
const E1 = { gaps: Object.fromEntries(DELTAS.map((d, i) => [d, +gaps[i].toFixed(4)])),
  monotone_nonincreasing: e1_monotone, gap_first_minus_last: +(gaps[0] - gaps[gaps.length - 1]).toFixed(4),
  pass: e1_monotone && e1_magnitude, confounded: true };
const e2_diffs = DELTAS.map((d) => Math.abs(D('betting', d) - D('mixture', d)));
const E2 = { max_abs_diff: +Math.max(...e2_diffs).toFixed(4),
  diffs: Object.fromEntries(DELTAS.map((d, i) => [d, +e2_diffs[i].toFixed(4)])),
  pass: e2_diffs.every((x) => x <= 0.10) };
const dstar = DELTAS.find((d) => D('mixture', d) >= 0.5) ?? null;
const E3 = { delta_star: dstar, pass: dstar !== null && dstar <= 2.5 };

// ── provenance ─────────────────────────────────────────────────────────────
const runId = 'run-' + new Date().toISOString().replace(/[:.]/g, '').replace('T', 'T').slice(0, 16) + 'Z';
const outDir = join(HERE, '..', 'results', runId);
if (existsSync(outDir)) throw new Error(`refusing existing ${outDir}`);
mkdirSync(outDir, { recursive: true });
const sh = (c) => execSync(c, { cwd: REPO }).toString().trim();
const table = {};
for (const [k, c] of Object.entries(cells))
  table[k] = { trials: c.trials, detections: c.detections, false_alarms: c.false_alarms,
    detection_rate: +(c.detections / c.trials).toFixed(4), median_ttd: med(c.ttds) };
writeFileSync(join(outDir, 'cells.json'), JSON.stringify(table, null, 1));
writeFileSync(join(outDir, 'endpoints.json'), JSON.stringify({ E1, E2, E3 }, null, 1));
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
  study: '2026-07-effect-size-sweep', run: runId,
  deploysignal_sha: sh('git rev-parse HEAD'),
  engine_pin: JSON.parse(readFileSync(join(REPO, 'package.json')))
    .dependencies['@johnpatrickwarren-oss/deploysignal-engine'],
  engine_installed_version: JSON.parse(readFileSync(join(REPO, 'node_modules',
    '@johnpatrickwarren-oss', 'deploysignal-engine', 'package.json'))).version,
  scenario_file_sha256: createHash('sha256').update(scenarioRaw).digest('hex'),
  alpha_per_signal: ALPHA, deltas: DELTAS, signals: Object.keys(SIGNALS),
  calib_window: CALIB, t_total: T_TOTAL, t_inject: T_INJECT,
  seed_scheme: 'mulberry32(fnv1a(`${scenario.id}|${signal}|${delta}`))',
  node: process.version, command: 'node studies/effect-size-sweep/analysis/run_sweep.mjs',
}, null, 1));

console.log(`run ${runId}`);
for (const d of DELTAS)
  console.log(`  δ=${String(d).padEnd(4)} classical=${D('classical', d).toFixed(3)} betting=${D('betting', d).toFixed(3)} mixture=${D('mixture', d).toFixed(3)} gap=${(D('classical', d) - D('mixture', d)).toFixed(3)}`);
console.log('E1', E1.pass, '(monotone', e1_monotone + ', span', E1.gap_first_minus_last + ')');
console.log('E2', E2.pass, '(max diff', E2.max_abs_diff + ')');
console.log('E3', E3.pass, '(delta* =', dstar + ')');
const fa = Object.values(table).reduce((s, c) => s + c.false_alarms, 0);
console.log('false alarms total:', fa, 'of', Object.values(table).reduce((s, c) => s + c.trials, 0), 'arm-trials');
