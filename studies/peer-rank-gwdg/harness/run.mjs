// studies/peer-rank-gwdg/harness/run.mjs — study 2026-10-peer-rank-gwdg. Registered in ../PREREGISTRATION.md
// (263efa0, Amendment 1 79a4160) before this file existed. Reuses studies/gwdg-gate/harness/lib.mjs for parsing
// and hashing and the gwdg-gate run's windows.json as the window list. Loads the engine's peer-rank kind from a
// local checkout (ENGINE_DIST, default ../deploysignal-engine/dist) pinned to commit af805e8 (§ Engine).
//   GWDG_DATA=<dataset dir> ENGINE_DIST=<engine dist dir> node studies/peer-rank-gwdg/harness/run.mjs [--smoke]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SIGNALS, XID, loadTidy, loadSums, sha256File, parseTs, tickMs, isoUtc } from '../../gwdg-gate/harness/lib.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url)); const STUDY = join(HERE, '..'); const REPO = join(STUDY, '..', '..');
const SMOKE = process.argv.includes('--smoke');
const DATA = process.env.GWDG_DATA ?? join(REPO, '..', 'tessera', 'runs', 'gwdg-data', 'gwdg-gpu-node-telemetry-gpu-detachment-failures-2025-2026-v1.0.0');
const ENGINE = process.env.ENGINE_DIST ?? join(REPO, '..', 'deploysignal-engine', 'dist');
const ENGINE_SHA = 'af805e8';
const GWDG_RUN = join(REPO, 'studies', 'gwdg-gate', 'results', 'run-20260929T012317Z');
const ALPHA = 0.05, N_TESTS = 2 * SIGNALS.length, THRESHOLD = N_TESTS / ALPHA;
const ARMS = { M10: 0.10, M5: 0.05 };

const counters = { exceptions: 0, hash_mismatches: 0 }; const exceptionLog = [];
// engine pin
const engineSha = execSync('git rev-parse HEAD', { cwd: join(ENGINE, '..') }).toString().trim();
const PEER_RANK_SHA256 = 'b7901965efb891a0c60d6bbdd8383e7192a051e71979c27c31c8f56c6f97114c'; // dist/detectors/peer-rank.js as committed at af805e8 (Amendment 2)
try { execSync(`git merge-base --is-ancestor ${ENGINE_SHA} HEAD`, { cwd: join(ENGINE, '..') }); } catch { throw new Error(`NOT EXECUTABLE: ${ENGINE_SHA} is not an ancestor of the engine checkout ${engineSha}`); }
const peerRankHash = createHash('sha256').update(readFileSync(join(ENGINE, 'detectors', 'peer-rank.js'))).digest('hex');
if (peerRankHash !== PEER_RANK_SHA256) throw new Error(`NOT EXECUTABLE: peer-rank.js sha256 ${peerRankHash} is not the pinned ${PEER_RANK_SHA256}`);
const pr = require(join(ENGINE, 'detectors', 'peer-rank.js'));
// freeze: tidy files against gwdg-gate's SHA256SUMS; the two gwdg-gate records against their committed bytes (hashes recorded)
const sums = loadSums(join(REPO, 'studies', 'gwdg-gate', 'SHA256SUMS'));
const hashChecks = [];
function verify(path) { const name = path.split('/').pop(); const expect = sums.get(name); const got = sha256File(path); const ok = expect !== undefined && expect === got; hashChecks.push({ file: name, ok }); if (!ok) counters.hash_mismatches++; return ok; }
const windowsAll = JSON.parse(readFileSync(join(GWDG_RUN, 'windows.json'), 'utf8'));
const windows = windowsAll.filter((w) => w.arm === 'A' && !w.voided);
const recordHashes = { windows_json: sha256File(join(GWDG_RUN, 'windows.json')), units_json: sha256File(join(GWDG_RUN, 'units.json')) };
const files = [...new Set(windows.map((w) => w.file))].sort();
const useFiles = SMOKE ? files.slice(0, 1) : files;

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const out = join(STUDY, 'results', `${SMOKE ? 'smoke' : 'run'}-${stamp}`);
if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);

// Amendment 3: each spec carries the Bonferroni share, so the module's own 1/alpha is the window threshold (280)
function specs(margin) { const s = []; for (const sig of SIGNALS) for (const worse of ['higher', 'lower']) s.push({ sig, worse, spec: { id: `${sig}:${worse}`, worse, tolerance: 0.1, margin: { relative: margin }, alpha: ALPHA / N_TESTS } }); return s; }

function runWindow(tidy, w, margin) {
  const unitSeries = tidy.series[w.gpu]; const peerGpus = tidy.gpus.filter((g) => g !== w.gpu);
  const startMs = parseTs(w.start), endMs = parseTs(w.end);
  const ticks = Math.round((endMs - startMs) / tickMs);
  const tests = specs(margin).map((t) => ({ ...t, state: pr.initPeerRank(t.spec), maxE: 1 }));
  let fire = null; const firing = []; let missing = 0, skipped = 0, scored = 0;
  let disappearance = null, gone = 0;
  const xid = unitSeries[XID]; let xidFirst = null;
  for (let k = 0; k < ticks; k++) {
    const ms = startMs + k * tickMs;
    if (xidFirst === null && xid?.has(ms) && xid.get(ms) > 0) xidFirst = k;
    const unitAll = SIGNALS.every((s) => unitSeries[s]?.has(ms));
    const peersAll = peerGpus.filter((g) => SIGNALS.every((s) => tidy.series[g][s]?.has(ms))).length;
    if (!unitAll && peersAll >= 2) { gone++; if (gone === 6 && disappearance === null) disappearance = k - 5; } else gone = 0;
    for (const t of tests) {
      const u = unitSeries[t.sig]?.has(ms) ? unitSeries[t.sig].get(ms) : NaN;
      const peers = peerGpus.map((g) => (tidy.series[g][t.sig]?.has(ms) ? tidy.series[g][t.sig].get(ms) : NaN));
      const st = pr.stepPeerRank(t.spec, t.state, { unit: u, peers });
      t.state = st.state; if (st.x === null) { if (!Number.isFinite(u)) missing++; else skipped++; } else scored++;
      t.maxE = Math.max(t.maxE, st.rollbackE);
      if (fire === null && st.fire) { fire = k; }
      if (fire === k && st.rollbackE >= THRESHOLD - 1e-9) firing.push(t.spec.id);
    }
    if (fire !== null) break;
  }
  return { unit: w.unit, file: w.file, gpu: w.gpu, kind: w.kind, ticks, ticks_expected: w.ticks, start: w.start, end: w.end, peers: peerGpus.length, margin,
    outcome: fire === null ? 'hold' : 'rollback', fire_tick: fire, fire_at: fire === null ? null : isoUtc(startMs + fire * tickMs), firing, first_signal: firing[0] ?? null,
    lead_hours_vs_I: fire === null || w.kind !== 'detection' ? null : (fire - ticks / 2) * (tickMs / 3600000), xid_first_tick: xidFirst, fire_minus_xid_ticks: fire === null || xidFirst === null ? null : fire - xidFirst,
    disappearance_tick: disappearance, fire_at_or_after_disappearance: fire !== null && disappearance !== null ? fire >= disappearance : null,
    missing_scores: missing, skipped_scores: skipped, scored, max_e: Object.fromEntries(tests.map((t) => [t.spec.id, Math.round(t.maxE * 100) / 100])), temporal_outcome: w.outcome, temporal_fire_tick: w.fire_tick };
}

const results = [];
for (const file of useFiles) {
  const path = join(DATA, 'telemetry', file);
  if (!verify(path)) { for (const w of windows.filter((x) => x.file === file)) results.push({ unit: w.unit, kind: w.kind, voided: true, reason: 'hash_mismatch' }); continue; }
  const tidy = await loadTidy(path);
  for (const w of windows.filter((x) => x.file === file)) {
    for (const [arm, margin] of Object.entries(ARMS)) {
      let r = null;
      try { r = runWindow(tidy, w, margin); } catch (e) { counters.exceptions++; exceptionLog.push({ unit: w.unit, arm, error: String(e?.stack ?? e).slice(0, 1500) }); }
      results.push(r ? { arm, voided: false, ...r } : { arm, unit: w.unit, kind: w.kind, voided: true, reason: 'exception' });
    }
  }
  console.log(`${file}: ${windows.filter((x) => x.file === file).length} windows done`);
}
// endpoints
const upper95 = (k, n) => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const p = (lo + hi) / 2; let cdf = 0; for (let j = 0; j <= k; j++) cdf += Math.exp(lgC(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p)); if (cdf > 0.05) lo = p; else hi = p; } return hi; };
function lgC(n, k) { return lg(n + 1) - lg(k + 1) - lg(n - k + 1); }
function lg(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (let j = 0; j < 6; j++) s += c[j] / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
const median = (xs) => { const s = xs.filter((x) => x !== null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const E = {};
for (const arm of Object.keys(ARMS)) {
  const sc = results.filter((r) => r.arm === arm && !r.voided);
  const nul = sc.filter((r) => r.kind === 'null'), det = sc.filter((r) => r.kind === 'detection');
  const nrb = nul.filter((r) => r.outcome === 'rollback'), drb = det.filter((r) => r.outcome === 'rollback');
  const nullTicks = nul.reduce((a, r) => a + r.ticks, 0);
  E[arm] = {
    null: { windows: nul.length, rollbacks: nrb.length, rate: nul.length ? nrb.length / nul.length : null, upper95: nul.length ? upper95(nrb.length, nul.length) : null, per_1000_ticks: nullTicks ? (nrb.length / nullTicks) * 1000 : null, ticks: nullTicks, verdict: nul.length ? (nrb.length / nul.length <= 0.05 ? 'PASS' : 'FAIL') : 'n/a', first_signals: count(nrb.map((r) => r.first_signal)), temporal_rollbacks_same_windows: nul.filter((r) => r.temporal_outcome === 'rollback').length },
    detection: { windows: det.length, rollbacks: drb.length, rate: det.length ? drb.length / det.length : null, verdict: det.length ? (drb.length / det.length >= 0.5 ? 'PASS' : 'FAIL') : 'n/a', lead_hours_vs_I_median: median(drb.map((r) => r.lead_hours_vs_I)), early_fraction: drb.length ? drb.filter((r) => r.lead_hours_vs_I < 0).length / drb.length : null, fire_minus_xid_median: median(drb.map((r) => r.fire_minus_xid_ticks)), with_disappearance: det.filter((r) => r.disappearance_tick !== null).length, fires_at_or_after_disappearance: drb.filter((r) => r.fire_at_or_after_disappearance === true).length, first_signals: count(drb.map((r) => r.first_signal)), temporal_rollbacks_same_windows: det.filter((r) => r.temporal_outcome === 'rollback').length },
  };
}
function count(xs) { const c = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1])); }
const voids = results.filter((r) => r.voided).length;
const notExecutable = counters.hash_mismatches > 0 || voids > 0.05 * results.length || (!SMOKE && (E.M10.null.windows < 40 || E.M10.detection.windows < 36));
mkdirSync(out, { recursive: true });
const repoSha = execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim();
writeFileSync(join(out, 'windows.json'), JSON.stringify(results, null, 1));
writeFileSync(join(out, 'endpoints.json'), JSON.stringify({ study: '2026-10-peer-rank-gwdg', generated: new Date().toISOString(), smoke: SMOKE, threshold: THRESHOLD, n_tests: N_TESTS, signals: SIGNALS, arms: ARMS, windows_total: results.length, voided: voids, counters, exceptions: exceptionLog, hash_checks: hashChecks, not_executable: notExecutable, E1: E.M10.null, E2: E.M10.detection, E4_M5: E.M5, }, null, 2));
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ repo_sha: repoSha, engine_sha: engineSha, engine_dist: ENGINE, peer_rank_js_sha256: peerRankHash, gwdg_run: GWDG_RUN, record_hashes: recordHashes, data: DATA, node: process.version }, null, 2));
console.log(`M10 null ${E.M10.null.rollbacks}/${E.M10.null.windows} ${E.M10.null.verdict} (upper ${E.M10.null.upper95?.toFixed(3)}; temporal ${E.M10.null.temporal_rollbacks_same_windows}) | detection ${E.M10.detection.rollbacks}/${E.M10.detection.windows} ${E.M10.detection.verdict} early ${E.M10.detection.early_fraction} | M5 null ${E.M5.null.rollbacks}/${E.M5.null.windows} det ${E.M5.detection.rollbacks}/${E.M5.detection.windows} | voids ${voids} exceptions ${counters.exceptions} hashes bad ${counters.hash_mismatches} | NOT EXECUTABLE ${notExecutable}`);
console.log(`written ${out}`);
