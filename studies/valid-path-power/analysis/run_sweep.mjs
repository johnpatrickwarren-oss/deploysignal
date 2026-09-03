// run_sweep.mjs — the valid-path power study, per PREREGISTRATION.md (frozen 2026-09-03, before
// this file existed). Endpoints E1–E5; grid, arms, α and the ship floor frozen there.
//
// Interpretation decisions the pre-registration left open, made here once and listed in
// REPORT.md §3: the K6 replacement is re-centred on μ̂ (the engine library replaces a zero-mean
// series); the terminal arms read the whole canary [500, 600) as their test window; the
// sequential UI's `changeFrom` is the deploy start (index 500), not the onset; false alarms are
// crossings before canary tick 30 on a sequential arm and are counted, never re-tried.
//
// Usage: node studies/valid-path-power/analysis/run_sweep.mjs [--smoke]
// Append-only: refuses an existing results/run-<UTC>/ dir. No Math.random; no wall clock in any
// tracked artifact except the run-directory name.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const require_ = createRequire(import.meta.url);
const ENGDIR = join(REPO, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine');
const ENG = join(ENGDIR, 'dist', 'detectors');
const safeT = require_(join(ENG, 'safe-t-e-value.js'));
const ui = require_(join(ENG, 'universal-inference-e-value.js'));
const sui = require_(join(ENG, 'sequential-ui.js'));
const bet = require_(join(ENG, 'betting-e-process.js'));
const mix = require_(join(ENG, 'family-a-mixture-supermartingale.js'));

// ── frozen by the pre-registration (§2, §3) ────────────────────────────────
const ALPHA_PRIMARY = (4e-4 / 6) * 0.5;          // 3.333e-5, the shipped per-signal allocation
const ALPHA_SECONDARY = 0.05;                     // the K-matrix's level, comparability only
const ALPHAS = [ALPHA_PRIMARY, ALPHA_SECONDARY];
const CALIB = 500, T_TOTAL = 100, T_INJECT = 30;
const SIGNALS = { p99_latency: 0.008, ttft: 0.008, cost_req: 0.006, downstream_err: 0.03 };
const SIG4 = Object.keys(SIGNALS);
const SHIPPED_RATIO = 2.41e4;                     // ville-guarantee-is-empirical, median over 82,888 cells
const SCENARIO_SHA = 'dd15a08e246c3e2152fc122fca6fb0eb0e6ed2f7f8b556dcfe95a0ae828f7474';
const FLOOR = 0.50;                               // COVERAGE_FLOOR, reused

// class → [{ sev: label, ...params, canonical }]
const CELLS = {
  null: [{ sev: 'none', canonical: true }],
  K1: [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0].map((d) => ({ sev: `${d}sigma`, delta: d, canonical: d === 1.5 })),
  K2: [0.25, 0.5, 0.75].map((e) => ({ sev: `K4-e${e}sigma`, eps: e, canonical: e === 0.5 })),
  K3: [[0.5, 0.02], [0.5, 0.05], [0.5, 0.1], [0.75, 0.02], [0.75, 0.05], [0.75, 0.1]]
    .map(([a, f]) => ({ sev: `A${a}sigma-f${f}`, amp: a, freq: f, canonical: a === 0.75 && f === 0.05 })),
  K4: [3, 5, 8].map((m) => ({ sev: `${m}sigma-point`, mult: m, canonical: m === 5 })),
  K5: [2.5e-3, 5e-3, 1e-2, 2e-2].map((s) => ({ sev: `slope${s}`, slope: s, canonical: s === 1e-2 })),
  K6: [1.0, 1.5, 2.0].map((d) => ({ sev: `mix-d${d}`, d, canonical: d === 1.5 })),
};
const VALID_ARMS = ['safe_t', 'universal_inference', 'sequential_ui'];
const PLUGIN_ARMS = ['mixture', 'betting'];
const ARMS = [...VALID_ARMS, ...PLUGIN_ARMS, 'betting_shipped'];
const TERMINAL = new Set(['safe_t', 'universal_inference']);

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
// Box–Muller from a uniform stream (the engine library's gaussFrom, same role).
function gaussFrom(r) {
  let spare = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    do { u = r(); } while (u <= 1e-12);
    v = r();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
}

// ── injections, ported from ../deploysignal-engine/validation/coverage/lib/inject.mjs ──
// σ = σ̂ (calibration), `at` = T_INJECT on the canary index; K6 re-centred on μ̂ (REPORT §3).
function inject(cls, p, traj, mu, sigma, rng) {
  const at = T_INJECT;
  switch (cls) {
    case 'null': return traj;
    case 'K1': return traj.map((v, t) => (t >= at ? v + p.delta * sigma : v));
    case 'K2': return traj.map((v, t) => (t >= at ? v + p.eps * sigma : v));
    case 'K3': return traj.map((v, t) => (t >= at ? v + p.amp * sigma * Math.sin(2 * Math.PI * p.freq * (t - at)) : v));
    case 'K4': return traj.map((v, t) => (t === at ? v + p.mult * sigma : v));
    case 'K5': return traj.map((v, t) => (t >= at ? v + p.slope * (t - at) * sigma : v));
    case 'K6': {
      const g = gaussFrom(rng);
      const s = Math.sqrt(Math.max(0, 1 - (p.d * p.d) / 4));
      return traj.map((v, t) => {
        if (t < at) return v;
        const b = rng() < 0.5;
        const z = (b ? p.d / 2 : -p.d / 2) + g() * s;
        return mu + sigma * z;
      });
    }
    default: throw new Error(`unknown class ${cls}`);
  }
}

// ── arms: each returns { fired: boolean, tick: canary index | null } per α ──
// Terminal arms: one look at the end of the canary; tick is null (undefined TTD).
function runTerminal(arm, series) {
  const cal = { start: 0, len: CALIB }, test = { start: CALIB, len: T_TOTAL };
  const e = arm === 'safe_t'
    ? safeT.safeTwoSampleTEValue(series, cal, test, { ar1Phi: 0 })
    : ui.universalInferenceMeanShiftEValue(series, cal, test);
  return ALPHAS.map((a) => ({ fired: e >= 1 / a, tick: null }));
}
function runSequentialUi(series) {
  const r = sui.sequentialUiMeanShiftEProcess(series, { changeFrom: CALIB });
  // r.logE[i] is the e-process after scored tick s = i + 1; canary tick t ↔ series index CALIB + t.
  return ALPHAS.map((a) => {
    const thr = Math.log(1 / a);
    for (let t = 0; t < T_TOTAL; t++) {
      if (r.logE[CALIB + t - 1] >= thr) return { fired: true, tick: t };
    }
    return { fired: false, tick: null };
  });
}
function runWealth(arm, traj, mu, sigma) {
  return ALPHAS.map((a) => {
    if (arm === 'mixture') {
      const st = mix.freshMixtureSupermartingaleState();
      const params = { mixture_distribution: 'gaussian', gaussian_sigma_squared_prior: sigma * sigma, ar1_phi: 0 };
      for (let t = 0; t < T_TOTAL; t++) {
        const x = traj[t];
        const v = mix.evaluatePageCusumMixtureSupermartingale({ x_centered: x - mu, live_value: x,
          baseline_mean: mu, sigma_squared: sigma * sigma, params, state: st, alpha: a, ar1_phi: 0 });
        if (v.fire === true) return { fired: true, tick: t };
      }
      return { fired: false, tick: null };
    }
    const st = bet.freshBettingState();
    const derivation = { mean: mu, empirical_variance: sigma * sigma, ar1_phi: 0 };
    if (arm === 'betting_shipped') derivation.betting_sliding_buffer_threshold = SHIPPED_RATIO / a;
    const params = { derivation, min_ticks_before_eligible: 0, min_observation_window: 0 };
    for (let t = 0; t < T_TOTAL; t++) {
      const v = bet.evaluateBettingEProcess({ signal: 's', params, state: st, alphaBetting: a,
        ticksSinceDeploy: 999, trafficPct: 100 }, traj[t] - mu);
      if (v.verdict === 'fire') return { fired: true, tick: t };
    }
    return { fired: false, tick: null };
  });
}
function runArm(arm, series, traj, mu, sigma) {
  if (TERMINAL.has(arm)) return runTerminal(arm, series);
  if (arm === 'sequential_ui') return runSequentialUi(series);
  return runWealth(arm, traj, mu, sigma);
}

// ── smoke (§6): one obvious fire and one clean no-fire per arm ─────────────
function smoke() {
  const rng = mulberry32(fnv1a('smoke'));
  const base = 100, c = 0.008;
  const healthy = () => base * (1 + c * rng());
  const calib = Array.from({ length: CALIB }, healthy);
  const { mean: mu, sigma } = meanSigma(calib);
  const out = {};
  for (const delta of [0, 3]) {
    const traj = Array.from({ length: T_TOTAL }, (_, t) => healthy() + (t >= T_INJECT ? delta * sigma : 0));
    const series = calib.concat(traj);
    for (const arm of ARMS) {
      const r = runArm(arm, series, traj, mu, sigma)[0];
      out[`${arm}|delta=${delta}`] = r;
      const ok = delta === 0 ? r.fired === false : r.fired === true;
      if (!ok) throw new Error(`smoke FAILED: ${arm} at delta=${delta}: ${JSON.stringify(r)}`);
    }
  }
  return out;
}

// ── the sweep ──────────────────────────────────────────────────────────────
function main() {
  const smokeResult = smoke();
  console.log('smoke passed:', Object.entries(smokeResult).map(([k, v]) => `${k}:${v.fired}${v.tick !== null ? '@' + v.tick : ''}`).join(' '));
  if (process.argv.includes('--smoke')) return;

  const scenarioPath = join(REPO, 'runs', 'adversarial-scenarios.json');
  const scenarioRaw = readFileSync(scenarioPath);
  const sha = createHash('sha256').update(scenarioRaw).digest('hex');
  if (sha !== SCENARIO_SHA) throw new Error(`NOT-EXECUTABLE: scenario sha ${sha} != registered ${SCENARIO_SHA}`);
  const pin = JSON.parse(readFileSync(join(REPO, 'package.json'))).dependencies['@johnpatrickwarren-oss/deploysignal-engine'];
  const installed = JSON.parse(readFileSync(join(ENGDIR, 'package.json'))).version;
  if (!pin.endsWith('#v' + installed)) throw new Error(`NOT-EXECUTABLE: installed engine ${installed} != pin ${pin}`);
  const scenarios = JSON.parse(scenarioRaw);

  const cells = {};   // `${arm}|${class}|${sev}|${alpha}` -> counters
  const cellKey = (arm, cls, sev, a) => `${arm}|${cls}|${sev}|${a}`;
  const fresh = () => ({ trials: 0, detections: 0, false_alarms: 0, ttds: [], exceptions: 0 });
  for (const arm of ARMS) for (const [cls, list] of Object.entries(CELLS)) for (const p of list) for (const a of ALPHAS)
    cells[cellKey(arm, cls, p.sev, a)] = fresh();

  const record = (arm, cls, sev, results) => {
    results.forEach((r, ai) => {
      const c = cells[cellKey(arm, cls, sev, ALPHAS[ai])];
      c.trials++;
      if (!r.fired) return;
      if (r.tick !== null && r.tick < T_INJECT) c.false_alarms++;
      else { c.detections++; if (r.tick !== null) c.ttds.push(r.tick - T_INJECT); }
    });
  };
  const exceptionLog = [];
  const guarded = (arm, cls, sev, fn) => {
    try { return fn(); } catch (e) {
      for (const a of ALPHAS) cells[cellKey(arm, cls, sev, a)].exceptions++;
      if (exceptionLog.length < 20) exceptionLog.push({ arm, cls, sev, message: String(e && e.message || e) });
      return null;
    }
  };

  const t0 = Date.now();
  for (const sc of scenarios) {
    for (const [cls, list] of Object.entries(CELLS)) {
      for (const p of list) {
        if (cls === 'K2') {
          // one group trial per scenario: all four signals shifted, union across signals per arm
          const usable = SIG4.every((k) => typeof sc.baseline?.[k] === 'number' && sc.baseline[k] > 0);
          if (!usable) continue;
          const perSig = {};
          for (const sig of SIG4) {
            const rng = mulberry32(fnv1a(`${sc.id}|${sig}|${cls}|${p.sev}`));
            const base = sc.baseline[sig], c = SIGNALS[sig];
            const healthy = () => base * (1 + c * rng());
            const calib = Array.from({ length: CALIB }, healthy);
            const { mean: mu, sigma } = meanSigma(calib);
            const traj = inject(cls, p, Array.from({ length: T_TOTAL }, healthy), mu, sigma, rng);
            perSig[sig] = { series: calib.concat(traj), traj, mu, sigma };
          }
          for (const arm of ARMS) {
            const per = SIG4.map((sig) => guarded(arm, cls, p.sev, () => runArm(arm, perSig[sig].series, perSig[sig].traj, perSig[sig].mu, perSig[sig].sigma)));
            if (per.some((x) => x === null)) continue;
            // union: earliest crossing across signals (terminal arms: fired if any fired)
            const union = ALPHAS.map((_, ai) => {
              let fired = false, tick = null;
              for (const r of per) {
                const x = r[ai];
                if (!x.fired) continue;
                fired = true;
                if (x.tick !== null && (tick === null || x.tick < tick)) tick = x.tick;
              }
              return { fired, tick };
            });
            record(arm, cls, p.sev, union);
          }
          continue;
        }
        for (const sig of SIG4) {
          const base = sc.baseline?.[sig];
          if (typeof base !== 'number' || base <= 0) continue;
          const c = SIGNALS[sig];
          const rng = mulberry32(fnv1a(`${sc.id}|${sig}|${cls}|${p.sev}`));
          const healthy = () => base * (1 + c * rng());
          const calib = Array.from({ length: CALIB }, healthy);
          const { mean: mu, sigma } = meanSigma(calib);
          const traj = inject(cls, p, Array.from({ length: T_TOTAL }, healthy), mu, sigma, rng);
          const series = calib.concat(traj);
          for (const arm of ARMS) {
            const r = guarded(arm, cls, p.sev, () => runArm(arm, series, traj, mu, sigma));
            if (r === null) continue;
            record(arm, cls, p.sev, r);
          }
        }
      }
    }
  }
  const runtimeMs = Date.now() - t0;

  // ── endpoints (bars frozen) ──────────────────────────────────────────────
  const rate = (arm, cls, sev, a = ALPHA_PRIMARY) => { const c = cells[cellKey(arm, cls, sev, a)]; return c.trials ? c.detections / c.trials : null; };
  const best = (arms, cls, sev, a = ALPHA_PRIMARY) => {
    let bestArm = null, bestRate = -1;
    for (const arm of arms) { const r = rate(arm, cls, sev, a); if (r !== null && r > bestRate) { bestRate = r; bestArm = arm; } }
    return { arm: bestArm, rate: bestRate < 0 ? null : +bestRate.toFixed(4) };
  };
  const canonical = (cls) => CELLS[cls].find((p) => p.canonical).sev;
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const voided = Object.entries(cells).filter(([, c]) => c.exceptions > 0).map(([k]) => k);

  const k1c = canonical('K1');
  const dValidK1 = best(VALID_ARMS, 'K1', k1c);
  const deltaStarValid = CELLS.K1.map((p) => p.delta).find((d) => (best(VALID_ARMS, 'K1', `${d}sigma`).rate ?? 0) >= FLOOR) ?? null;
  const E1 = { d_valid_k1_canonical: dValidK1, floor: FLOOR, delta_star_valid: deltaStarValid,
    pass: dValidK1.rate !== null && dValidK1.rate >= FLOOR };

  const taxes = {};
  for (const cls of ['K1', 'K2', 'K3', 'K4', 'K5', 'K6']) {
    const sev = canonical(cls);
    const v = best(VALID_ARMS, cls, sev), pl = best(PLUGIN_ARMS, cls, sev);
    taxes[cls] = { severity: sev, valid: v, plugin: pl, tax: (v.rate === null || pl.rate === null) ? null : +(pl.rate - v.rate).toFixed(4) };
  }
  const scored = ['K1', 'K2', 'K5'];
  const E2 = { taxes, scored, pass: scored.every((k) => taxes[k].tax !== null && taxes[k].tax <= 0.25) };

  const e3rows = ['1.5sigma', '0.5sigma'].map((sev) => {
    const v = best(VALID_ARMS, 'K1', sev), sh = rate('betting_shipped', 'K1', sev);
    return { severity: sev, valid: v, betting_shipped: sh === null ? null : +sh.toFixed(4), pass: v.rate !== null && sh !== null && v.rate >= sh - 0.10 };
  });
  const E3 = { rows: e3rows, pass: e3rows.every((r) => r.pass) };

  const E4 = { alpha: ALPHA_SECONDARY, arms: {} };
  for (const arm of ARMS) {
    const c = cells[cellKey(arm, 'null', 'none', ALPHA_SECONDARY)];
    const crossings = c.detections + c.false_alarms;   // any crossing anywhere on the null canary
    const n = c.trials, r = n ? crossings / n : null;
    const bound = n ? ALPHA_SECONDARY + 2 * Math.sqrt(ALPHA_SECONDARY * (1 - ALPHA_SECONDARY) / n) : null;
    const entry = { n, crossings, rate: r === null ? null : +r.toFixed(4), bound: bound === null ? null : +bound.toFixed(4) };
    if (VALID_ARMS.includes(arm)) entry.pass = r !== null && r <= bound;
    else entry.reference_eps_bound = +(ALPHA_SECONDARY * (1 + (arm === 'mixture' ? 0 : 0.184))).toFixed(4);
    E4.arms[arm] = entry;
  }
  E4.valid_arms_passing = VALID_ARMS.filter((a) => E4.arms[a].pass);

  const E5 = { rows: CELLS.K1.map((p) => {
    const row = { severity: p.sev };
    for (const arm of ['sequential_ui', 'mixture', 'betting']) {
      const c = cells[cellKey(arm, 'K1', p.sev, ALPHA_PRIMARY)];
      row[arm] = { detections: c.detections, median_ttd: c.detections >= 20 ? med(c.ttds) : null };
    }
    return row;
  }) };

  const shipRule = {
    a_routes: E1.pass && (E4.valid_arms_passing.includes(E1.d_valid_k1_canonical.arm)),
    routed_arm: E1.pass ? E1.d_valid_k1_canonical.arm : null,
    voided_cells: voided,
  };

  // ── provenance ───────────────────────────────────────────────────────────
  const runId = 'run-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 16) + 'Z';
  const outDir = join(HERE, '..', 'results', runId);
  if (existsSync(outDir)) throw new Error(`refusing existing ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  const sh = (cmd) => execSync(cmd, { cwd: REPO }).toString().trim();
  const table = {};
  for (const [k, c] of Object.entries(cells))
    table[k] = { trials: c.trials, detections: c.detections, false_alarms: c.false_alarms,
      detection_rate: c.trials ? +(c.detections / c.trials).toFixed(4) : null, median_ttd: med(c.ttds), exceptions: c.exceptions };
  writeFileSync(join(outDir, 'cells.json'), JSON.stringify(table, null, 1));
  writeFileSync(join(outDir, 'endpoints.json'), JSON.stringify({ E1, E2, E3, E4, E5, ship_rule: shipRule }, null, 1));
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
    study: '2026-09-valid-path-power', run: runId,
    deploysignal_sha: sh('git rev-parse HEAD'),
    engine_pin: pin, engine_installed_version: installed,
    scenario_file_sha256: sha,
    alphas: ALPHAS, alpha_primary: ALPHA_PRIMARY, shipped_threshold_ratio: SHIPPED_RATIO,
    calib_window: CALIB, t_total: T_TOTAL, t_inject: T_INJECT, signals: SIG4,
    cells: Object.fromEntries(Object.entries(CELLS).map(([k, v]) => [k, v.map((p) => p.sev)])),
    arms: ARMS, seed_scheme: 'mulberry32(fnv1a(`${scenario.id}|${signal}|${class}|${severity}`))',
    smoke: smokeResult, exceptions_total: Object.values(cells).reduce((s, c) => s + c.exceptions, 0),
    exception_samples: exceptionLog, runtime_ms: runtimeMs,
    node: process.version, command: 'node studies/valid-path-power/analysis/run_sweep.mjs',
  }, null, 1));

  console.log(`run ${runId}  (${(runtimeMs / 1000).toFixed(1)} s)`);
  const fmt = (x) => (x === null ? '  —  ' : x.toFixed(3));
  for (const [cls, list] of Object.entries(CELLS)) for (const p of list)
    console.log(`  ${cls.padEnd(4)} ${p.sev.padEnd(16)} ` + ARMS.map((a) => `${a}=${fmt(rate(a, cls, p.sev))}`).join(' '));
  console.log('E1', E1.pass, JSON.stringify(E1.d_valid_k1_canonical), 'delta*_valid =', deltaStarValid);
  console.log('E2', E2.pass, Object.entries(taxes).map(([k, v]) => `${k}:${v.tax}`).join(' '));
  console.log('E3', E3.pass, JSON.stringify(e3rows.map((r) => [r.severity, r.valid.rate, r.betting_shipped])));
  console.log('E4', JSON.stringify(Object.fromEntries(Object.entries(E4.arms).map(([k, v]) => [k, v.rate]))), 'passing:', E4.valid_arms_passing.join(','));
  console.log('ship rule: (a) routes =', shipRule.a_routes, 'routed arm =', shipRule.routed_arm);
  console.log('exceptions total:', Object.values(cells).reduce((s, c) => s + c.exceptions, 0), 'voided cells:', voided.length);
}
main();
