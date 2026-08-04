// run_sweep.mjs — the drift-regime sweep, per PREREGISTRATION.md (frozen 2026-08-04).
// Endpoints E1/E2/E3; grid and arms frozen there. Interpretation decisions left open by the
// text are made here, once, and listed in REPORT.md §3.
//
// Usage: node studies/drift-regime-sweep/analysis/run_sweep.mjs
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
const ENG = join(REPO, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'dist');
const bet = require_(join(ENG, 'detectors', 'betting-e-process.js'));
const mix = require_(join(ENG, 'detectors', 'family-a-mixture-supermartingale.js'));
const core = require_(join(ENG, 'core.js'));
const { ROLLBACK_DEFS } = require_(join(REPO, 'engine', 'gates', '_health-defs.js'));
const slowbleedDef = ROLLBACK_DEFS.find((d) => d.id === 'slowbleed');

// ── frozen by the pre-registration ─────────────────────────────────────────
const SLOPES = [0.0002, 0.0005, 0.001, 0.002, 0.005, 0.010, 0.020]; // fraction of mean per tick
const ALPHA = (4e-4 / 6) * 0.5;            // per-signal shipped allocation, as C9
const T_TOTAL = 100, T_INJECT = 30, CALIB = 500;
const SIGNALS = { p99_latency: 0.008, ttft: 0.008, cost_req: 0.006, downstream_err: 0.03 };
const DRIFT4 = Object.keys(SIGNALS);
// slowbleed's nine keys; the five without a corpus noise model are pinned flat at scenario baseline.
const SB_KEYS = ['p99_latency', 'ttft', 'tokens_turn', 'cost_req', 'hbm_spill',
  'downstream_err', 'corpus_delta', 'kv_cache', 'mfu'];

// ── seeded RNG, identical scheme to C9 ─────────────────────────────────────
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
function meanSigma(v) {
  let sum = 0; for (const x of v) sum += x;
  const mean = sum / v.length;
  let sq = 0; for (const x of v) { const d = x - mean; sq += d * d; }
  return { mean, sigma: Math.sqrt(sq / v.length) };
}

// ── per-signal Ville adapters, verbatim semantics from C9 ──────────────────
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

// ── the sweep ──────────────────────────────────────────────────────────────
const scenarioPath = join(REPO, 'runs', 'adversarial-scenarios.json');
const scenarioRaw = readFileSync(scenarioPath);
const scenarios = JSON.parse(scenarioRaw);

const ARMS = ['mixture4', 'betting4', 'slowbleed'];
const cells = {};
for (const arm of ARMS) for (const s of SLOPES)
  cells[`${arm}|${s}`] = { trials: 0, detections: 0, false_alarms: 0, ttds: [] };

for (const sc of scenarios) {
  const usable = DRIFT4.every((k) => typeof sc.baseline?.[k] === 'number' && sc.baseline[k] > 0);
  if (!usable) continue;
  for (const slope of SLOPES) {
    // per-signal streams: calib then trajectory, one seeded stream each, C9's scheme
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

    // arm 1+2: unions of four per-signal detectors on the identical trajectories
    for (const [arm, make] of [['mixture4', makeMixture], ['betting4', makeBetting]]) {
      const steps = Object.fromEntries(DRIFT4.map((s) => [s, make(mus[s], sigmas[s])]));
      const cell = cells[`${arm}|${slope}`];
      cell.trials++;
      let outcome = null;
      for (let t = 0; t < T_TOTAL && outcome === null; t++)
        for (const sig of DRIFT4)
          if (steps[sig](traj[sig][t])) { outcome = t < T_INJECT ? 'fa' : t; break; }
      if (outcome === 'fa') cell.false_alarms++;
      else if (outcome !== null) { cell.detections++; cell.ttds.push(outcome - T_INJECT); }
    }

    // arm 3: the shipped slowbleed rule — fresh TrendBuffer, all nine keys per tick,
    // baseline = calib means for the modeled four, scenario constants for the flat five
    {
      const b = {};
      for (const k of SB_KEYS) b[k] = DRIFT4.includes(k) ? mus[k] : (sc.baseline?.[k] || 1);
      const tb = new core.TrendBuffer();
      const cell = cells[`slowbleed|${slope}`];
      cell.trials++;
      let outcome = null;
      for (let t = 0; t < T_TOTAL && outcome === null; t++) {
        const m = {};
        for (const k of SB_KEYS) m[k] = DRIFT4.includes(k) ? traj[k][t] : b[k];
        for (const k of SB_KEYS) tb.push(k, m[k]);
        if (slowbleedDef.check(m, b, null, null, tb)) outcome = t < T_INJECT ? 'fa' : t;
      }
      if (outcome === 'fa') cell.false_alarms++;
      else if (outcome !== null) { cell.detections++; cell.ttds.push(outcome - T_INJECT); }
    }
  }
}

// ── endpoints (bars frozen) ────────────────────────────────────────────────
const D = (arm, s) => { const c = cells[`${arm}|${s}`]; return c.detections / c.trials; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// E1 — complementarity window
const e1_window = SLOPES.filter((s) => D('slowbleed', s) >= 0.5 && D('mixture4', s) <= 0.5);
const E1 = { window_slopes: e1_window, pass: e1_window.length > 0 };

// E2 — matched-displacement comparison against C9's step cells
const C9 = JSON.parse(readFileSync(join(REPO, 'studies', 'effect-size-sweep', 'results',
  'run-2026-08-04T04583Z', 'cells.json')));
const C9_DELTAS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0];
const CV = Object.fromEntries(Object.entries(SIGNALS).map(([k, c]) => [k, c * Math.sqrt(1 / 12)]));
const e2_rows = SLOPES.map((s) => {
  const perSig = DRIFT4.map((sig) => {
    const dSigma = Math.min(3, (s * (T_TOTAL - T_INJECT - 1)) / CV[sig]);
    const nearest = C9_DELTAS.reduce((a, b) => Math.abs(b - dSigma) < Math.abs(a - dSigma) ? b : a);
    return C9[`mixture|${nearest}`].detection_rate;
  });
  const union = 1 - perSig.reduce((p, d) => p * (1 - d), 1);
  return { slope: s, drift: +D('mixture4', s).toFixed(4), step_union: +union.toFixed(4),
    gap: +(D('mixture4', s) - union).toFixed(4) };
});
const E2 = { rows: e2_rows, pass: e2_rows.every((r) => Math.abs(r.gap) <= 0.10) };

// E3 — slowbleed operating window, both edges, both unit systems
const sbOn = SLOPES.filter((s) => D('slowbleed', s) >= 0.5);
const E3 = {
  floor: sbOn[0] ?? null, ceiling: sbOn[sbOn.length - 1] ?? null,
  floor_sigma_per_tick: sbOn.length ? Object.fromEntries(DRIFT4.map((k) =>
    [k, +(sbOn[0] / CV[k]).toFixed(2)])) : null,
};

// ── provenance ─────────────────────────────────────────────────────────────
const runId = 'run-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 16) + 'Z';
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
  study: '2026-08-drift-regime-sweep', run: runId,
  deploysignal_sha: sh('git rev-parse HEAD'),
  engine_pin: JSON.parse(readFileSync(join(REPO, 'package.json')))
    .dependencies['@johnpatrickwarren-oss/deploysignal-engine'],
  engine_installed_version: JSON.parse(readFileSync(join(ENG, '..', 'package.json'))).version,
  scenario_file_sha256: createHash('sha256').update(scenarioRaw).digest('hex'),
  c9_step_source: 'studies/effect-size-sweep/results/run-2026-08-04T04583Z/cells.json',
  alpha_per_signal: ALPHA, slopes: SLOPES, drifting_signals: DRIFT4,
  calib_window: CALIB, t_total: T_TOTAL, t_inject: T_INJECT,
  seed_scheme: 'mulberry32(fnv1a(`${scenario.id}|${signal}|${slope}`))',
  node: process.version, command: 'node studies/drift-regime-sweep/analysis/run_sweep.mjs',
}, null, 1));

console.log(`run ${runId}`);
for (const s of SLOPES)
  console.log(`  s=${String(s).padEnd(6)} mixture4=${D('mixture4', s).toFixed(3)} betting4=${D('betting4', s).toFixed(3)} slowbleed=${D('slowbleed', s).toFixed(3)}`);
console.log('E1', E1.pass, '(window:', JSON.stringify(E1.window_slopes) + ')');
console.log('E2', E2.pass, '(max |gap|', Math.max(...e2_rows.map((r) => Math.abs(r.gap))).toFixed(4) + ')');
console.log('E3 floor', E3.floor, 'ceiling', E3.ceiling);
const fa = Object.values(table).reduce((s, c) => s + c.false_alarms, 0);
console.log('false alarms total:', fa, 'of', Object.values(table).reduce((s, c) => s + c.trials, 0), 'arm-trials');
