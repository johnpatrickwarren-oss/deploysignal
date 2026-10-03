// studies/temporal-null-real/harness/run.mjs — study 2026-10-temporal-null-real. Registered in ../PREREGISTRATION.md
// (fa3dad9) before this file existed; data, split, replay, void rules and endpoints are §1–§4 there.
//
//   node studies/temporal-null-real/harness/run.mjs fetch     → results/raw/lane<N>.json (CloudWatch, period 120, both windows)
//   node studies/temporal-null-real/harness/run.mjs bundle    → results/calibration/bundle/{manifest.json,bundle.jsonl}
//   node tools/calibrate.js --baseline studies/temporal-null-real/results/calibration/bundle --alpha 1e-3 \
//        --families A,B,C,D,E --out studies/temporal-null-real/results/calibration/compiled.json
//   node studies/temporal-null-real/harness/run.mjs replay    → results/run-<UTC>/{sessions.json,endpoints.json,manifest.json}
import { createRequire } from 'node:module';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const ROOT = join(STUDY, '..', '..');
const RES = process.env.TNR_RESULTS ?? join(STUDY, 'results'); // TNR_RESULTS: synthetic smoke only
const REGION = 'us-east-1', PROFILE = process.env.AWS_PROFILE ?? 'twin-aa';
const PERIOD = 120, TICKS = 32, LANES = [0, 1, 2, 3];
const CAL_START = '2026-09-30T14:51:00Z', EVAL_START = '2026-10-02T01:30:00Z', EVAL_END = '2026-10-03T05:00:00Z';
const FULL_REQ = 9740; // two minutes at the full 81 rps (§1)
const LB = { 0: 'app/twin-aa-l0/2517eac385982987', 1: 'app/twin-aa-l1/64ba9a35ae9545ff', 2: 'app/twin-aa-l2/e5be3705a6d06372', 3: 'app/twin-aa-l3/c3b55d75fa39421d' };
const ALPHA = 0.001;

const aws = (args) => JSON.parse(execFileSync('aws', ['--profile', PROFILE, '--region', REGION, '--output', 'json', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }));
const toMs = (s) => Date.parse(s);

// ── fetch ────────────────────────────────────────────────────────────────────────────────────────
function tgArn(lane) {
  const r = aws(['elbv2', 'describe-target-groups', '--names', `twin-aa-l${lane}-prod-old`]);
  return r.TargetGroups[0].TargetGroupArn.replace(/^.*:targetgroup\//, 'targetgroup/');
}
function metricData(lane, tg, startIso, endIso) {
  const dims = [{ Name: 'TargetGroup', Value: tg }, { Name: 'LoadBalancer', Value: LB[lane] }];
  const q = (id, name, stat) => ({ Id: id, MetricStat: { Metric: { Namespace: 'AWS/ApplicationELB', MetricName: name, Dimensions: dims }, Period: PERIOD, Stat: stat }, ReturnData: true });
  const queries = [q('p99', 'TargetResponseTime', 'p99'), q('req', 'RequestCount', 'Sum'), q('e5', 'HTTPCode_Target_5XX_Count', 'Sum'), q('hh', 'HealthyHostCount', 'Minimum')];
  const out = { p99: new Map(), req: new Map(), e5: new Map(), hh: new Map() };
  // CloudWatch returns ≤ 100,800 datapoints per call but we page by day to stay well under limits
  for (let t = toMs(startIso); t < toMs(endIso); t += 86_400_000) {
    const e = Math.min(t + 86_400_000, toMs(endIso));
    let next;
    do {
      const args = ['cloudwatch', 'get-metric-data', '--metric-data-queries', JSON.stringify(queries), '--start-time', new Date(t).toISOString(), '--end-time', new Date(e).toISOString(), '--scan-by', 'TimestampAscending'];
      if (next) args.push('--next-token', next);
      const r = aws(args);
      for (const m of r.MetricDataResults) for (let i = 0; i < m.Timestamps.length; i++) out[m.Id].set(toMs(m.Timestamps[i]), m.Values[i]);
      next = r.NextToken;
    } while (next);
  }
  return out;
}
function fetch() {
  mkdirSync(join(RES, 'raw'), { recursive: true });
  for (const lane of LANES) {
    const tg = tgArn(lane);
    const d = metricData(lane, tg, CAL_START, EVAL_END);
    const ticks = [];
    for (let t = toMs(CAL_START); t < toMs(EVAL_END); t += PERIOD * 1000) {
      const req = d.req.get(t);
      ticks.push({ t: new Date(t).toISOString(), p99_s: d.p99.get(t) ?? null, req: req ?? null, e5: d.e5.get(t) ?? (req !== undefined ? 0 : null), hh: d.hh.get(t) ?? null });
    }
    writeFileSync(join(RES, 'raw', `lane${lane}.json`), JSON.stringify({ lane, target_group: tg, load_balancer: LB[lane], period_s: PERIOD, start: CAL_START, end: EVAL_END, fetched: new Date().toISOString(), ticks }));
    const missing = ticks.filter((x) => x.req === null).length;
    console.log(`lane${lane}: ${ticks.length} ticks, ${missing} without RequestCount, ${ticks.filter((x) => x.p99_s === null).length} without p99`);
  }
}

// ── signals from a raw tick ──────────────────────────────────────────────────────────────────────
function signals(x) {
  return { p99_latency: x.p99_s === null ? NaN : x.p99_s * 1000, downstream_err: x.req ? (x.e5 ?? 0) / x.req : NaN, traffic_pct: x.req === null ? NaN : x.req / FULL_REQ };
}
function loadRaw(lane) { return JSON.parse(readFileSync(join(RES, 'raw', `lane${lane}.json`), 'utf8')); }
function utcParts(iso) { const d = new Date(iso); return { hour_of_day: d.getUTCHours(), day_of_week: d.getUTCDay() }; }

// ── bundle (calibration window → BaselineBundle, §1) ─────────────────────────────────────────────
function bundle() {
  const dir = join(RES, 'calibration', 'bundle');
  mkdirSync(dir, { recursive: true });
  const lines = []; let gapMax = 0; const means = {};
  for (const lane of LANES) {
    const raw = loadRaw(lane);
    const cal = raw.ticks.filter((x) => toMs(x.t) >= toMs(CAL_START) && toMs(x.t) < toMs(EVAL_START));
    let gap = 0; for (const x of cal) { if (x.req === null) { gap++; gapMax = Math.max(gapMax, gap); } else gap = 0; }
    const good = cal.filter((x) => x.req !== null && x.p99_s !== null);
    const sig = good.map(signals);
    means[lane] = { p99_latency: sig.reduce((a, s) => a + s.p99_latency, 0) / sig.length, downstream_err: sig.reduce((a, s) => a + s.downstream_err, 0) / sig.length, traffic_pct: sig.reduce((a, s) => a + s.traffic_pct, 0) / sig.length, n: sig.length };
    for (let i = 0; i + TICKS <= good.length; i += TICKS) {
      const run = good.slice(i, i + TICKS); const s = run.map(signals);
      lines.push(JSON.stringify({ tenant_id: 'prod-old', signal_series: { p99_latency: s.map((v) => v.p99_latency), downstream_err: s.map((v) => v.downstream_err), traffic_pct: s.map((v) => v.traffic_pct) }, hour_of_day: run.map((x) => utcParts(x.t).hour_of_day), day_of_week: run.map((x) => utcParts(x.t).day_of_week), lane }));
    }
  }
  writeFileSync(join(dir, 'bundle.jsonl'), lines.join('\n') + '\n');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 'temporal-null-real-cal', generated_at: new Date().toISOString(), seed: 0, cell_dim: 'hour_of_day_x_day_of_week', n_runs: lines.length, ticks_per_run: TICKS, tenants: 1, signals: ['p99_latency', 'downstream_err', 'traffic_pct'], source: { window: [CAL_START, EVAL_START], period_s: PERIOD, lanes: LANES }, calibration_gap_max_ticks: gapMax, lane_means: means }, null, 2));
  console.log(`bundle: ${lines.length} runs of ${TICKS}; max calibration gap ${gapMax} ticks; means ${JSON.stringify(means)}`);
}

// ── replay (§2–§4) ───────────────────────────────────────────────────────────────────────────────
function familyOf(id) {
  const m = /^family_([A-E])_/.exec(id); if (m) return m[1];
  return 'B'; // hand-tuned rule ids (p99, downstream, compound, …) are Family B (engine/gates/_health-defs.ts)
}
function replay() {
  const engine = require(join(ROOT, 'shared.js'));
  const { orchestrate, TrendBuffer, TOTAL_TICKS } = engine;
  if (TOTAL_TICKS !== TICKS) throw new Error(`TOTAL_TICKS ${TOTAL_TICKS} ≠ ${TICKS}`);
  const cfgPath = join(RES, 'calibration', 'compiled.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(RES, 'calibration', 'bundle', 'manifest.json'), 'utf8'));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const out = join(RES, `run-${stamp}`);
  if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
  const sessions = [];
  for (const lane of LANES) {
    const raw = loadRaw(lane);
    const ev = raw.ticks.filter((x) => toMs(x.t) >= toMs(EVAL_START) && toMs(x.t) < toMs(EVAL_END));
    const m = manifest.lane_means[lane];
    const scenario = { id: `tnr-l${lane}`, riskLevel: 'high', bakeHours: (TICKS * PERIOD) / 3600, author: 'human', changeType: 'config', timeWindow: 'ok',
      flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
      baseline: { p99_latency: m.p99_latency, downstream_err: m.downstream_err, traffic_pct: 1.0 } };
    for (let s = 0; s < 25; s++) {
      const ticks = ev.slice(s * TICKS, (s + 1) * TICKS);
      if (ticks.length < TICKS) break;
      const voidReasons = [];
      if (ticks.some((x) => x.req === null)) voidReasons.push('missing RequestCount datapoint');
      if (ticks.some((x) => x.hh !== null && x.hh < 2)) voidReasons.push('HealthyHostCount < 2');
      if (ticks.some((x) => x.req !== null && x.req < 2000)) voidReasons.push('RequestCount < 2000');
      const tp = ticks.map((x) => (x.req ?? 0) / FULL_REQ); const meanTp = tp.reduce((a, b) => a + b, 0) / tp.length;
      const regime = meanTp >= 0.9 ? 'full' : meanTp <= 0.6 ? 'half' : 'mixed';
      const rec = { lane, session: s, start: ticks[0].t, end: ticks[TICKS - 1].t, restart_session: s === 0, regime, mean_traffic_pct: meanTp, void_reasons: voidReasons, executable: voidReasons.length === 0,
        verdict: null, verdict_tick: null, rollback_ids: {}, extend_ids: {}, families_rollback: [], families_extend: [], failures: 0 };
      if (rec.executable) {
        const tb = new TrendBuffer(10);
        for (let i = 0; i < TICKS; i++) {
          const live = signals(ticks[i]);
          for (const k of Object.keys(live)) tb.push(k, live[k]);
          const { hour_of_day, day_of_week } = utcParts(ticks[i].t);
          let r;
          try {
            r = orchestrate({ liveMetrics: live, scenario, hoursElapsed: i * (scenario.bakeHours / TICKS), trendBuffer: tb, tick: i, totalTicks: TICKS, compiledConfig: cfg, currentHourOfDay: hour_of_day, currentDayOfWeek: day_of_week, fusionTopology: 'portfolio' });
          } catch (e) { rec.failures++; rec.error = String(e.message).slice(0, 200); break; }
          for (const f of r.healthResult?.rollback ?? []) if (!(f.id in rec.rollback_ids)) rec.rollback_ids[f.id] = i;
          for (const f of r.healthResult?.extend ?? []) if (!(f.id in rec.extend_ids)) rec.extend_ids[f.id] = i;
          if (rec.verdict === null && r.verdict !== 'extend') { rec.verdict = r.verdict; rec.verdict_tick = i; }
          if (i === TICKS - 1 && rec.verdict === null) rec.verdict = (r.healthResult && r.healthResult.extend.length > 0) ? 'extend' : 'proceed';
        }
        rec.families_rollback = [...new Set(Object.keys(rec.rollback_ids).map(familyOf))].sort();
        rec.families_extend = [...new Set(Object.keys(rec.extend_ids).map(familyOf))].sort();
      }
      sessions.push(rec);
    }
  }
  // endpoints (§4)
  const ex = sessions.filter((s) => s.executable && s.failures === 0);
  const N = ex.length;
  const binomUpper = (k, n) => { // exact 95% one-sided upper bound by bisection
    let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const p = (lo + hi) / 2; let cdf = 0; for (let j = 0; j <= k; j++) cdf += Math.exp(lgammaC(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p)); if (cdf > 0.05) lo = p; else hi = p; } return hi; };
  const pGe = (k, n, p) => { let s = 0; for (let j = 0; j < k; j++) s += Math.exp(lgammaC(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p)); return 1 - s; };
  const rollbacks = ex.filter((s) => s.verdict === 'rollback');
  const alpha = cfg.alpha_budget;
  const E1 = { rollback_sessions: rollbacks.length, N, rate: rollbacks.length / N, upper95: binomUpper(rollbacks.length, N), p_ge_at_alpha_total: pGe(rollbacks.length, N, alpha.total), verdict: N > 0 && pGe(rollbacks.length, N, alpha.total) >= 0.01 ? 'PASS' : 'FAIL' };
  const E2 = {};
  for (const fam of ['A', 'C', 'D', 'E']) {
    const k = ex.filter((s) => s.families_rollback.includes(fam)).length; const a = alpha.per_family[fam] ?? 0;
    E2[fam] = { sessions_with_rollback_fire: k, alpha_share: a, p_ge: a > 0 ? pGe(k, N, a) : null, verdict: a > 0 ? (pGe(k, N, a) >= 0.01 ? 'PASS' : 'FAIL') : (k === 0 ? 'no cells, no fires' : 'FIRED WITHOUT BUDGET') };
  }
  E2.B_holds = ex.filter((s) => s.families_extend.includes('B') || s.families_rollback.includes('B')).length;
  const byRegime = {}; for (const r of ['full', 'half', 'mixed']) { const g = ex.filter((s) => s.regime === r); byRegime[r] = { sessions: g.length, rollbacks: g.filter((s) => s.verdict === 'rollback').length, any_rollback_fire: g.filter((s) => s.families_rollback.length > 0).length }; }
  const restart = ex.filter((s) => s.restart_session);
  const E3 = { by_regime: byRegime, restart_sessions: { sessions: restart.length, rollbacks: restart.filter((s) => s.verdict === 'rollback').length, any_rollback_fire: restart.filter((s) => s.families_rollback.length > 0).length }, concordance_two_or_more_families: ex.filter((s) => s.families_rollback.length >= 2).length, fire_ids: countIds(ex, 'rollback_ids') };
  const E4 = { extend_sessions: ex.filter((s) => s.verdict === 'extend').length, proceed_sessions: ex.filter((s) => s.verdict === 'proceed').length, hold_ids: countIds(ex, 'extend_ids') };
  const voids = sessions.filter((s) => !s.executable), failures = sessions.filter((s) => s.failures > 0);
  const notExecutable = voids.length > 10 || !(cfg.baseline_cells?.cells?.some((c) => c.family_A && Object.keys(c.family_A.per_signal ?? {}).length)) || manifest.calibration_gap_max_ticks > 30;
  mkdirSync(out, { recursive: true });
  const sha = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
  const dirty = execSync('git status --porcelain -- engine shared.js tools/calibrate* studies/temporal-null-real/harness studies/temporal-null-real/results/calibration', { cwd: ROOT }).toString().trim().split('\n').filter(Boolean);
  const pkg = require(join(ROOT, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'package.json'));
  writeFileSync(join(out, 'sessions.json'), JSON.stringify(sessions, null, 1));
  writeFileSync(join(out, 'endpoints.json'), JSON.stringify({ study: '2026-10-temporal-null-real', generated: new Date().toISOString(), sessions: sessions.length, executable: N, void: voids.map((s) => ({ lane: s.lane, session: s.session, reasons: s.void_reasons })), harness_failures: failures.length, not_executable: notExecutable, alpha_budget: alpha, compiled: { version: cfg.version, cells: cfg.baseline_cells?.cells?.length ?? 0, confidence: (cfg.baseline_cells?.cells ?? []).reduce((a, c) => (a[c.confidence] = (a[c.confidence] ?? 0) + 1, a), {}), family_A_signals: Object.keys(cfg.baseline_cells?.cells?.find((c) => c.family_A)?.family_A?.per_signal ?? {}), family_D: !!cfg.baseline_cells?.cells?.find((c) => c.family_D), family_C: !!cfg.baseline_cells?.cells?.find((c) => c.family_C && Object.keys(c.family_C).length), family_E: !!cfg.baseline_cells?.cells?.find((c) => c.family_E && Object.keys(c.family_E).length) }, E1, E2, E3, E4 }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ repo_sha: sha, dirty, engine_version: pkg.version, node: process.version, period_s: PERIOD, ticks: TICKS, eval_window: [EVAL_START, EVAL_END], cal_window: [CAL_START, EVAL_START], compiled_sha256: sha256(cfgPath) }, null, 2));
  console.log(`sessions ${sessions.length}, executable ${N}, void ${voids.length}, failures ${failures.length}; E1 ${E1.rollback_sessions}/${N} ${E1.verdict}; E2 ${JSON.stringify(Object.fromEntries(Object.entries(E2).map(([k, v]) => [k, typeof v === 'object' ? `${v.sessions_with_rollback_fire} ${v.verdict}` : v])))}; regimes ${JSON.stringify(byRegime)}; restart ${JSON.stringify(E3.restart_sessions)}; extend ${E4.extend_sessions} proceed ${E4.proceed_sessions}; NOT EXECUTABLE ${notExecutable}`);
  console.log(`written ${out}`);
}
function countIds(ex, key) { const c = {}; for (const s of ex) for (const id of Object.keys(s[key])) c[id] = (c[id] ?? 0) + 1; return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1])); }
function lgammaC(n, k) { return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1); }
function lgamma(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (let j = 0; j < 6; j++) s += c[j] / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
function sha256(p) { return execSync(`shasum -a 256 "${p}"`).toString().split(' ')[0]; }

const cmd = process.argv[2];
if (cmd === 'fetch') fetch(); else if (cmd === 'bundle') bundle(); else if (cmd === 'replay') replay(); else { console.error('usage: run.mjs fetch | bundle | replay'); process.exit(2); }
