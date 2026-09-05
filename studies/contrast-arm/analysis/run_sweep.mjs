// run_sweep.mjs — the control-arm study, per PREREGISTRATION.md (frozen 2026-09-05, before this file
// existed). Endpoints E1–E5; substrate, variants, arms, α and bars frozen there.
//
// Interpretation decisions the pre-registration left open, made here once and listed in REPORT.md §3:
// the contrast arm's e-BH reads the mixture card's running wealth at the PRIMARY α card (the card's α
// only sets its own threshold); a scenario's "would-be rollback" tick is the first canary tick with a
// non-empty selected set; the temporal arm is C64 (d)'s mixture arm verbatim; the cohort monitor's
// revocation tick is the first canary tick `passing` is false.
//
// Usage: node studies/contrast-arm/analysis/run_sweep.mjs [--smoke]
// Append-only: refuses an existing results/run-<UTC>/ dir. No Math.random; no wall clock in any
// tracked artifact except the run-directory name. No bare catch: exceptions are counted per cell,
// listed, and the cell voided.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render } from './report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const require_ = createRequire(import.meta.url);
const ENGDIR = join(REPO, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine');
const mix = require_(join(ENGDIR, 'dist', 'detectors', 'family-a-mixture-supermartingale.js'));
const contrast = require_(join(ENGDIR, 'dist', 'per-shard', 'contrast.js'));
const cm = require_(join(ENGDIR, 'dist', 'fleet', 'calibration-monitor.js'));
// the SHIPPED module: the same functions the gate runs
const arm = require_(join(REPO, 'dist', 'engine', 'gates', '_health-contrast.js'));
const guarantees = require_(join(REPO, 'dist', 'engine', 'guarantees.js'));

// ── frozen by the pre-registration (§2, §3) ────────────────────────────────
const ALPHA_PRIMARY = (4e-4 / 6) * 0.5;          // 3.333e-5
const ALPHA_SECONDARY = 0.05;
const ALPHAS = [ALPHA_PRIMARY, ALPHA_SECONDARY];
const Q = guarantees.CONTRAST_ARM_Q;             // 0.05
const FIT = 500, T_TOTAL = 100, T_INJECT = 30, DELTA = 1.5, DELTA_3 = 3;
const SIGNALS = { p99_latency: 0.008, ttft: 0.008, cost_req: 0.006, downstream_err: 0.03 };
const SIG4 = Object.keys(SIGNALS);
const SCENARIO_SHA = 'dd15a08e246c3e2152fc122fca6fb0eb0e6ed2f7f8b556dcfe95a0ae828f7474';
const VARIANTS = ['null', 'canary', 'shared', 'contaminated', 'canary-3'];
const ARMS = ['contrast', 'temporal'];
const FLOOR = 0.50;
const MONITOR_ALPHA = guarantees.CONTRAST_MONITOR_ALPHA;   // 0.01
const FIT_RATIO_FLOOR = guarantees.CONTRAST_FIT_RATIO_FLOOR;

// ── seeded RNG, the C9/C35 scheme ──────────────────────────────────────────
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

/** One unit of one signal: 500 calibration + 100 canary healthy draws, and the unit's own σ̂. */
function unit(scId, sig, unitName) {
  const rng = mulberry32(fnv1a(`${scId}|${sig}|${unitName}`));
  const base = null; // set by caller
  return { rng, base };
}
function drawUnit(sc, sig, unitName) {
  const rng = mulberry32(fnv1a(`${sc.id}|${sig}|${unitName}`));
  const base = sc.baseline[sig], c = SIGNALS[sig];
  const healthy = () => base * (1 + c * rng());
  const calib = Array.from({ length: FIT }, healthy);
  const traj = Array.from({ length: T_TOTAL }, healthy);
  const { mean, sigma } = meanSigma(calib);
  return { calib, traj, mu: mean, sigma };
}
const step = (traj, sigma, delta) => traj.map((v, t) => (t >= T_INJECT ? v + delta * sigma : v));

/** The five variants from one set of draws (paired). */
function variants(u) {
  const s = (unitDraw, delta) => step(unitDraw.traj, unitDraw.sigma, delta);
  return {
    'null': { canary: u.canary.traj, a: u.a.traj, b: u.b.traj },
    'canary': { canary: s(u.canary, DELTA), a: u.a.traj, b: u.b.traj },
    'shared': { canary: s(u.canary, DELTA), a: s(u.a, DELTA), b: s(u.b, DELTA) },
    'contaminated': { canary: u.canary.traj, a: u.a.traj, b: s(u.b, DELTA) },
    'canary-3': { canary: s(u.canary, DELTA_3), a: u.a.traj, b: u.b.traj },
  };
}

// ── arms ───────────────────────────────────────────────────────────────────
/** Temporal (C64 d's mixture arm verbatim): first canary tick any of the four signals crosses 1/α. */
function temporalTick(perSig, alpha) {
  let first = null;
  for (const sig of SIG4) {
    const { calib, traj } = perSig[sig];
    const { mean: mu, sigma } = meanSigma(calib);
    const st = mix.freshMixtureSupermartingaleState();
    const params = { mixture_distribution: 'gaussian', gaussian_sigma_squared_prior: sigma * sigma, ar1_phi: 0 };
    for (let t = 0; t < T_TOTAL; t++) {
      const x = traj[t];
      const v = mix.evaluatePageCusumMixtureSupermartingale({ signal: sig, x_centered: x - mu, live_value: x, baseline_mean: mu, sigma_squared: sigma * sigma, params, state: st, alpha, ar1_phi: 0 });
      if (v.fire === true) { if (first === null || t < first) first = t; break; }
    }
  }
  return first;
}

/** Contrast (the shipped module): per pair the fit on the baseline contrast, the residual per tick
 *  through contrastResidualStep, the mixture card at (0, 1, 0) and α, the cohort residual into the
 *  gaussian monitor; each tick selectContrastArm across the four pairs at q under the study flag.
 *  Returns the first tick with a non-empty selection, per-signal monitor revocation ticks, and the
 *  shipped gate reading at m/T. */
function contrastTick(perSig, live, alpha) {
  const pairs = {};
  for (const sig of SIG4) {
    const u = perSig[sig];
    const fit = contrast.fitContrast(u.canary.calib.map((x, i) => x - u.a.calib[i]));
    const cfit = contrast.fitContrast(u.a.calib.map((x, i) => x - u.b.calib[i]));
    pairs[sig] = { fit, cfit, prev: null, cprev: null, st: mix.freshMixtureSupermartingaleState(),
      mon: cm.freshCalibrationMonitor({ alpha: MONITOR_ALPHA, incrementKind: 'gaussian' }), revoked: null, logE: 0 };
  }
  const params = { mixture_distribution: 'gaussian', gaussian_sigma_squared_prior: guarantees.CONTRAST_MIXTURE_PRIOR, ar1_phi: 0 };
  const gateShipped = (FIT / T_TOTAL) >= FIT_RATIO_FLOOR ? 'asserted_m_much_greater_than_n' : 'refused_fit_ratio';
  let first = null;
  for (let t = 0; t < T_TOTAL; t++) {
    const cands = [];
    for (const sig of SIG4) {
      const p = pairs[sig], v = live[sig];
      const cs = arm.contrastResidualStep(v.a[t] - v.b[t], p.cprev, p.cfit); p.cprev = cs.dc;
      if (Number.isFinite(cs.r)) { cm.updateCalibration(p.mon, cs.r); if (!p.mon.passing && p.revoked === null) p.revoked = t; }
      const s = arm.contrastResidualStep(v.canary[t] - v.a[t], p.prev, p.fit); p.prev = s.dc;
      if (!Number.isFinite(s.r)) throw new Error(`non-finite contrast residual ${sig} t=${t}`);
      mix.evaluatePageCusumMixtureSupermartingale({ signal: 'contrast', x_centered: s.r, live_value: s.r, baseline_mean: 0, sigma_squared: 1, params, state: p.st, alpha, ar1_phi: 0 });
      p.logE = Math.log(Math.max(p.st.M_t ?? 1, 1e-300));
      if (!Number.isFinite(p.logE)) throw new Error(`non-finite contrast logE ${sig} t=${t}`);
      if (p.mon.passing) cands.push({ pair: sig, log_e: p.logE });
    }
    if (first === null && cands.length > 0) {
      const sel = arm.selectContrastArm(cands, Q, FIT, 'asserted_by_study_flag');
      if (sel.selected.length > 0) first = t;
    }
  }
  const revoked = {}; for (const sig of SIG4) revoked[sig] = pairs[sig].revoked;
  return { first, revoked, gateShipped };
}

// ── smoke (§5): one obvious fire and one clean no-fire per arm ─────────────
function smoke(scenarios) {
  const sc = scenarios[0];
  const perSig = {};
  for (const sig of SIG4) perSig[sig] = { canary: drawUnit(sc, sig, 'canary'), a: drawUnit(sc, sig, 'control-a'), b: drawUnit(sc, sig, 'control-b') };
  const out = {};
  for (const variant of ['null', 'canary-3']) {
    const live = {}; for (const sig of SIG4) live[sig] = variants(perSig[sig])[variant];
    const temporalSig = {}; for (const sig of SIG4) temporalSig[sig] = { calib: perSig[sig].canary.calib, traj: live[sig].canary };
    const tT = temporalTick(temporalSig, ALPHA_PRIMARY);
    const cT = contrastTick(perSig, live, ALPHA_PRIMARY).first;
    out[variant] = { temporal: tT, contrast: cT };
    const ok = variant === 'null' ? (tT === null && cT === null) : (tT !== null && cT !== null);
    if (!ok) throw new Error(`smoke FAILED at ${variant}: ${JSON.stringify(out[variant])}`);
  }
  return out;
}

// ── the sweep ──────────────────────────────────────────────────────────────
function main() {
  const scenarioPath = join(REPO, 'runs', 'adversarial-scenarios.json');
  const scenarioRaw = readFileSync(scenarioPath);
  const sha = createHash('sha256').update(scenarioRaw).digest('hex');
  if (sha !== SCENARIO_SHA) throw new Error(`NOT-EXECUTABLE: scenario sha ${sha} != registered ${SCENARIO_SHA}`);
  const pin = JSON.parse(readFileSync(join(REPO, 'package.json'))).dependencies['@johnpatrickwarren-oss/deploysignal-engine'];
  const installed = JSON.parse(readFileSync(join(ENGDIR, 'package.json'))).version;
  if (!pin.endsWith('#v' + installed)) throw new Error(`NOT-EXECUTABLE: installed engine ${installed} != pin ${pin}`);
  const scenarios = JSON.parse(scenarioRaw).filter((sc) => SIG4.every((k) => typeof sc.baseline?.[k] === 'number' && sc.baseline[k] > 0));

  const smokeResult = smoke(scenarios);
  console.log('smoke passed:', JSON.stringify(smokeResult));
  if (process.argv.includes('--smoke')) return;

  const cells = {};
  const key = (armId, variant, a) => `${armId}|${variant}|${a}`;
  for (const armId of ARMS) for (const v of VARIANTS) for (const a of ALPHAS) cells[key(armId, v, a)] = { trials: 0, rollbacks: 0, ttds: [], exceptions: 0 };
  const revocation = {}; for (const sig of SIG4) revocation[sig] = { n: 0, revoked: 0, ticks: [] };
  const revocationNull = {}; for (const sig of SIG4) revocationNull[sig] = { n: 0, revoked: 0 };
  const shipped = { refused_fit_ratio: 0, asserted_m_much_greater_than_n: 0 };
  const exceptionLog = [];
  const t0 = Date.now();
  for (const sc of scenarios) {
    const perSig = {};
    for (const sig of SIG4) perSig[sig] = { canary: drawUnit(sc, sig, 'canary'), a: drawUnit(sc, sig, 'control-a'), b: drawUnit(sc, sig, 'control-b') };
    for (const variant of VARIANTS) {
      const live = {}; for (const sig of SIG4) live[sig] = variants(perSig[sig])[variant];
      for (const a of ALPHAS) {
        // temporal
        try {
          const temporalSig = {}; for (const sig of SIG4) temporalSig[sig] = { calib: perSig[sig].canary.calib, traj: live[sig].canary };
          const t = temporalTick(temporalSig, a);
          const c = cells[key('temporal', variant, a)]; c.trials++; if (t !== null) { c.rollbacks++; c.ttds.push(t - T_INJECT); }
        } catch (e) { cells[key('temporal', variant, a)].exceptions++; if (exceptionLog.length < 20) exceptionLog.push({ arm: 'temporal', variant, a, sc: sc.id, message: String(e && e.message || e) }); }
        // contrast
        try {
          const r = contrastTick(perSig, live, a);
          const c = cells[key('contrast', variant, a)]; c.trials++; if (r.first !== null) { c.rollbacks++; c.ttds.push(r.first - T_INJECT); }
          if (a === ALPHA_PRIMARY) {
            shipped[r.gateShipped]++;
            if (variant === 'contaminated') for (const sig of SIG4) { revocation[sig].n++; if (r.revoked[sig] !== null) { revocation[sig].revoked++; revocation[sig].ticks.push(r.revoked[sig]); } }
            if (variant === 'null') for (const sig of SIG4) { revocationNull[sig].n++; if (r.revoked[sig] !== null) revocationNull[sig].revoked++; }
          }
        } catch (e) { cells[key('contrast', variant, a)].exceptions++; if (exceptionLog.length < 20) exceptionLog.push({ arm: 'contrast', variant, a, sc: sc.id, message: String(e && e.message || e) }); }
      }
    }
  }
  const runtimeMs = Date.now() - t0;

  // ── endpoints (bars frozen) ──────────────────────────────────────────────
  const N = scenarios.length;
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const R = (armId, variant, a = ALPHA_PRIMARY) => { const c = cells[key(armId, variant, a)]; return c.trials ? c.rollbacks / c.trials : null; };
  const TTD = (armId, variant, a = ALPHA_PRIMARY) => med(cells[key(armId, variant, a)].ttds);
  const halfWidth = 2 * Math.sqrt(0.05 * 0.95 / N);
  const E1 = { n: N, contrast_null: R('contrast', 'null'), bar: 0.05 + halfWidth, temporal_null: { primary: R('temporal', 'null'), secondary: R('temporal', 'null', ALPHA_SECONDARY) },
    pass: R('contrast', 'null') !== null && R('contrast', 'null') <= 0.05 + halfWidth };
  const E2 = { contrast: { rate: R('contrast', 'canary'), ttd: TTD('contrast', 'canary') }, temporal: { rate: R('temporal', 'canary'), ttd: TTD('temporal', 'canary') },
    contrast_3: { rate: R('contrast', 'canary-3'), ttd: TTD('contrast', 'canary-3') }, temporal_3: { rate: R('temporal', 'canary-3'), ttd: TTD('temporal', 'canary-3') },
    floor: FLOOR, pass: R('contrast', 'canary') !== null && R('contrast', 'canary') >= FLOOR };
  const E3 = { contrast_shared: R('contrast', 'shared'), contrast_null: R('contrast', 'null'), bar: R('contrast', 'null') + halfWidth,
    temporal_shared: R('temporal', 'shared'), temporal_canary: R('temporal', 'canary'),
    pass: R('contrast', 'shared') !== null && R('contrast', 'shared') <= R('contrast', 'null') + halfWidth };
  const E4 = { per_signal: {}, contrast_contaminated: R('contrast', 'contaminated'), bar: E1.bar,
    pass_signals: [], pass: null };
  for (const sig of SIG4) {
    const r = revocation[sig], rn = revocationNull[sig];
    E4.per_signal[sig] = { n: r.n, revoked: r.revoked, fraction: r.n ? r.revoked / r.n : null, median_tick: med(r.ticks), null_revoked: rn.revoked, null_fraction: rn.n ? rn.revoked / rn.n : null };
  }
  E4.pass_signals = ['p99_latency', 'ttft'].filter((s) => E4.per_signal[s].fraction !== null && E4.per_signal[s].fraction >= 0.5);
  E4.pass = E4.pass_signals.length === 2;
  const E5 = { fit_ratio: FIT / T_TOTAL, floor: FIT_RATIO_FLOOR, shipped_gate_counts: shipped, authority: guarantees.CONTRAST_ARM_AUTHORITY };
  const voided = Object.entries(cells).filter(([, c]) => c.exceptions > 0).map(([k]) => k);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const outDir = join(HERE, '..', 'results', `run-${stamp}`);
  if (existsSync(outDir)) throw new Error(`refusing to reuse ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  const manifest = {
    study: '2026-09-contrast-arm', register: 'knowledge WORKLIST C81 (Part 2)',
    repo_sha: execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(),
    engine: { pin, installed }, scenario_sha: sha, n_scenarios: N, node: process.version,
    constants: { ALPHAS, Q, FIT, T_TOTAL, T_INJECT, DELTA, DELTA_3, SIGNALS, VARIANTS, ARMS, FLOOR, MONITOR_ALPHA, FIT_RATIO_FLOOR },
    smoke: smokeResult, runtime_ms: runtimeMs, exceptions: Object.values(cells).reduce((s, c) => s + c.exceptions, 0), exception_log: exceptionLog, voided_cells: voided,
    hashes: { harness: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
      registration: createHash('sha256').update(readFileSync(join(HERE, '..', 'PREREGISTRATION.md'))).digest('hex'),
      module: createHash('sha256').update(readFileSync(join(REPO, 'engine', 'gates', '_health-contrast.ts'))).digest('hex') },
  };
  const cellsOut = Object.entries(cells).map(([k, c]) => { const [armId, variant, alpha] = k.split('|'); return { arm: armId, variant, alpha: Number(alpha), trials: c.trials, rollbacks: c.rollbacks, rate: c.trials ? c.rollbacks / c.trials : null, median_ttd: med(c.ttds), exceptions: c.exceptions }; });
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(outDir, 'cells.json'), JSON.stringify(cellsOut, null, 1) + '\n');
  writeFileSync(join(outDir, 'endpoints.json'), JSON.stringify({ E1, E2, E3, E4, E5 }, null, 2) + '\n');
  writeFileSync(join(outDir, 'REPORT.md'), render(outDir));
  console.log(`${N} scenarios, ${runtimeMs} ms, exceptions ${manifest.exceptions} -> ${outDir}`);
  console.log(JSON.stringify({ E1: { r: E1.contrast_null, pass: E1.pass }, E2: { c: E2.contrast, t: E2.temporal, pass: E2.pass }, E3: { s: E3.contrast_shared, ts: E3.temporal_shared, pass: E3.pass }, E4: E4.pass_signals, E5: E5.shipped_gate_counts }));
}
main();
