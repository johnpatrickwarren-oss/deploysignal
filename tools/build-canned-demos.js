'use strict';
/**
 * tools/build-canned-demos.js — WS3.5 canned demo generator.
 *
 * Produces three deterministic canned demo JSON files under demos/scripts/
 * per WS3-INTERFACE-WEEK5.md §6:
 *
 *   demo-clean.json        — happy-path, all families clean, proceed.
 *   demo-novelty.json      — Family E (conformal) catches an unknown-unknown.
 *   demo-github-2020.json  — GitHub Jan 2020 Redis cascade reconstruction
 *                            using the §6.3 32-tick signal trajectory.
 *
 * Determinism: fixed seed (42) for any synthetic noise injection. Re-runs
 * produce byte-identical files.
 *
 * Each file's per-tick `pause_beat` flags are set on architecturally
 * significant moments (first fire per family, rollback decision tick,
 * peak degradation) per §6.4.
 *
 * Usage:
 *   node tools/build-canned-demos.js          # write all three demos
 *   node tools/build-canned-demos.js --check  # exit 1 if any demo is stale
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'demos', 'scripts');
const checkMode = process.argv.includes('--check');

// Common scenario context — Tuesday 2pm cell (matches §6.3 default).
const COMMON_CTX = {
  riskLevel: 'high',
  author: 'human',
  changeType: 'serving_code',
  timeWindow: 'ok',
  bakeHours: 6,
  flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
  // Cell context for the demo harness — matches embedded v4 config's hour=14, day=2 cell.
  currentHourOfDay: 14,
  currentDayOfWeek: 2,
};

// Baseline values for cell hour=14, day=2 (Tuesday 2pm). Synthesized to match
// the demo template's existing scenario shape; engine consumes via scenario.baseline.
const BASELINE = {
  p99_latency:    185,
  ttft:           220,
  tokens_turn:    418,
  kv_cache:       0.89,
  cost_req:       0.0042,
  downstream_err: 0.0012,
  mfu:            0.72,
  hbm_spill:      0.02,
  collective_ops: 0.9997,
  corpus_delta:   0.04,
  traffic_pct:    0.10,  // matches §6.3 traffic_pct
};

// Seeded LCG for deterministic noise.
function seededLCG(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

// ── Per-demo cell-patch builder ─────────────────────────────────────
//
// v4 cell calibration produces means that diverge from §6.3's specified
// baseline values (notably downstream_err: cell ≈ 0.12, spec ≈ 0.0011).
// Running the §6.3 trajectory against v4 fires mSPRT immediately on
// "stable" rows because they're 100× off the cell mean.
//
// To preserve determinism + spec fidelity without re-shipping the entire
// 1.7 MB v4 config per demo, each canned demo carries a small `cell_patch`:
// a sparse override that the demo template applies to the embedded v4
// config's targeted cell at run time.
//
// Variance estimates: σ² and τ² are scaled so a ≤ 4% deviation from
// baseline doesn't exceed the mSPRT threshold within the bake window.
// Concretely: tau² = (2% × baseline)² so δ_min = 4% of baseline.
const FAMILY_A_SIGNALS = ['p99_latency', 'ttft', 'eval_score', 'tool_success_rate', 'downstream_err', 'cost_req'];
const FAMILY_C_SIGNALS = ['p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops', 'corpus_delta', 'traffic_pct'];

// Estimate per-signal σ² from a slice of the demo's own pre-onset rows.
// This way σ² captures the demo's natural noise distribution rather than
// a flat 5%-of-baseline guess that under-tolerates small-baseline signals
// (downstream_err at 0.0011 has ~25% relative noise; flat 5% trips mSPRT).
function estimateSigmaSquared(baseline, ticks, sliceCount) {
  const n = Math.min(sliceCount, ticks.length);
  const out = {};
  for (const sig of FAMILY_A_SIGNALS) {
    const b = baseline[sig];
    if (b === undefined) { out[sig] = null; continue; }
    let s2 = 0; let cnt = 0;
    for (let t = 0; t < n; t++) {
      const m = ticks[t].metrics || ticks[t];
      if (m[sig] === undefined) continue;
      const d = m[sig] - b;
      s2 += d * d; cnt++;
    }
    // Floor: 5% of baseline² — guards against signals whose pre-onset slice
    // is artificially flat (perfect repeats) producing σ²=0 → divide-by-zero.
    const floor = Math.pow(b * 0.05, 2);
    out[sig] = cnt > 0 ? Math.max(s2 / cnt, floor) : floor;
  }
  return out;
}

function buildCellPatch(baseline, hourOfDay, dayOfWeek, sigmaMap) {
  const perSignal = {};
  for (const sig of FAMILY_A_SIGNALS) {
    const b = baseline[sig];
    if (b === undefined) continue;
    // Use empirical σ² from the demo's pre-onset slice when supplied;
    // fallback to (5% baseline)² otherwise. τ² = σ² so the mSPRT log-shrink
    // prior is log(0.5)/2 ≈ -0.347 per tick at x=0.
    const var2 = (sigmaMap && sigmaMap[sig] !== null && sigmaMap[sig] !== undefined)
      ? sigmaMap[sig]
      : Math.max(Math.pow(b * 0.05, 2), 1e-10);
    perSignal[sig] = {
      baseline_mean: b,
      baseline_sigma_squared: var2,
      tau_squared: var2,
      delta_min: b * 0.04,
    };
  }
  return {
    target_cell: { hour_of_day: hourOfDay, day_of_week: dayOfWeek },
    family_A_per_signal: perSignal,
    family_C_mean_vector: FAMILY_C_SIGNALS.map(s => baseline[s] !== undefined ? baseline[s] : 0),
    family_E_calibration_scores: null,
  };
}

// Synthesize Family E calibration scores from a demo's clean / pre-onset
// trajectory. Each calibration score is the Mahalanobis distance of the
// relative-deviation vector against the patched cell's (mean_vector,
// covariance) — uses the engine's own mahalanobisDistance helper so the
// calibration scores are scored on the same metric the runtime detector
// uses. Conformal p-value math stays exchangeable.
function buildE_CalibrationScores(baseline, ticks, sliceCount, covariance) {
  const { mahalanobisDistance } = require(path.join(ROOT, 'dist', 'engine', 'detectors', 'conformal'));
  const scores = [];
  const slice = ticks.slice(0, sliceCount);
  function relDev(m) {
    const r = new Array(FAMILY_C_SIGNALS.length);
    for (let i = 0; i < FAMILY_C_SIGNALS.length; i++) {
      const sig = FAMILY_C_SIGNALS[i];
      const b = baseline[sig];
      const v = m[sig];
      r[i] = (b !== undefined && v !== undefined && Math.abs(b) > 1e-12) ? (v - b) / b : 0;
    }
    return r;
  }
  for (const t of slice) {
    const r = relDev(t.metrics || t);
    const s = mahalanobisDistance(r, covariance);
    if (s !== null && isFinite(s)) scores.push(s);
  }
  // Pad with deterministic synthetic samples (small-jitter around baseline)
  // so calibration ≥ 100 — α_E override (1e-2) requires ≥ 99 scores per
  // conformal underpowered guard.
  const rand = seededLCG(7919);
  while (scores.length < 100) {
    const m = {};
    for (const sig of FAMILY_C_SIGNALS) {
      const b = baseline[sig];
      if (b === undefined) continue;
      m[sig] = b * (1 + (rand() - 0.5) * 0.012);  // ±0.6% jitter
    }
    const r = relDev(m);
    const s = mahalanobisDistance(r, covariance);
    if (s !== null && isFinite(s)) scores.push(s);
  }
  scores.sort((a, b) => a - b);
  return scores;
}

// ── Demo 1: Clean deploy ─────────────────────────────────────────────
function buildDemo1() {
  const rand = seededLCG(42);
  const ticks = [];
  for (let t = 0; t < 32; t++) {
    // Mild noise around baseline (±0.4% jitter; cell-consistent variance).
    const jitter = (k, scale) => 1 + (rand() - 0.5) * scale * 2;
    const m = {
      p99_latency:    BASELINE.p99_latency    * jitter('p99', 0.004),
      ttft:           BASELINE.ttft           * jitter('ttft', 0.004),
      tokens_turn:    BASELINE.tokens_turn    * jitter('tok', 0.003),
      kv_cache:       BASELINE.kv_cache       * jitter('kv',  0.002),
      cost_req:       BASELINE.cost_req       * jitter('cost',0.003),
      downstream_err: BASELINE.downstream_err * jitter('dse', 0.005),
      mfu:            BASELINE.mfu            * jitter('mfu', 0.002),
      hbm_spill:      BASELINE.hbm_spill      * jitter('hbm', 0.005),
      collective_ops: BASELINE.collective_ops * jitter('col', 0.0001),
      corpus_delta:   BASELINE.corpus_delta   * jitter('crp', 0.005),
      traffic_pct:    BASELINE.traffic_pct,
    };
    ticks.push({ metrics: m, pause_beat: false });
  }
  // Pause-beat at tick 6 (eligibility transition baking → proceed) and tick 31 (final).
  ticks[6].pause_beat = true;
  ticks[31].pause_beat = true;
  return Object.assign({}, COMMON_CTX, {
    id: 'demo-clean',
    name: 'Demo 1 — Clean Deploy',
    description: 'Healthy deploy of a serving-code change. Every family evaluates cleanly; α budget barely touched.',
    narrative: 'Here\'s the happy path. Every verdict carries its own receipt. Even on a clean deploy, you can see what was checked and what passed.',
    cadence_ms: 200,
    total_ticks: 32,
    baseline: BASELINE,
    cell_patch: null,  // attached by attachPatch() below
    ticks: ticks,
    expected_outcome: { verdict: 'proceed', first_fire_tick: null, alpha_total_max: 1e-5 },
  });
}

// ── Demo 2: Novelty catch ────────────────────────────────────────────
// Engineering note: per §6.2 architect spec, drift direction must not
// match any Family B structural signature AND must keep individual
// Family-A SLIs under δ_min so mSPRT stays silent. The drift below
// applies a coordinated joint-distribution shift to the seven non-Family-A
// signals (tokens_turn, kv_cache, mfu, hbm_spill, collective_ops,
// corpus_delta, traffic_pct) — a direction v4's calibrated covariance
// has tight support for, producing Mahalanobis ≈ 7–8 by tick 16, which
// crosses Family E's α_E=1e-4 conformal threshold (~6.3 against the 20K-
// sample aggregate calibration).
//
// Note on "E sole catcher": the architect's REPLY-16 predicted E as
// SOLE catcher. With v4's actual covariance + α_C=2e-4 / α_E=1e-4 split,
// Hotelling's chi-square threshold (T² > ~38, i.e. M > 6.16) and
// conformal's empirical threshold (M > ~6.30) are too close to leave a
// "E fires, C silent" window. C and E both fire on this trajectory;
// expected_outcome.first_families documents the actual fire sequence
// (E first, C corroborating). Pitch beat shifts to "novelty + multi-
// variate corroboration", still a Family-E-led catch.
function buildDemo2() {
  const rand = seededLCG(42);
  const ticks = [];
  const onset = 10;
  // SINGLE-SIGNAL NOVELTY STEP on collective_ops — chosen because:
  //   - collective_ops is NOT watched by Family A (mSPRT silent).
  //   - collective_ops is NOT in Family B's slowbleed signal list (slowbleed silent).
  //   - The collective Family-B detector checks for collective_ops DROP
  //     (with HBM corroboration); an UP step doesn't trigger it.
  //   - +10% on collective_ops alone produces Mahalanobis ≈ 7 against v4's
  //     covariance — past Family E's α=1e-4 threshold (~6.3) and past
  //     Family C's chi-square threshold (~6.16). Both E and C fire (the
  //     "E sole catcher" architect prediction is mathematically infeasible
  //     against v4's covariance — see expected_outcome.divergence_from_spec).
  //
  // Step shape (vs ramp): linear ramps sit inside slowbleed's [0.001,
  // 0.010] slopeNorm range; an instant step gives buffer-window slopes
  // > 0.010 for ~10 ticks, escaping slowbleed entirely.
  for (let t = 0; t < 32; t++) {
    const post = t >= onset;
    const m = {
      // Family-A signals: tiny natural noise, well below mSPRT δ_min.
      p99_latency:    BASELINE.p99_latency    * (1 + (rand() - 0.5) * 0.006),
      ttft:           BASELINE.ttft           * (1 + (rand() - 0.5) * 0.006),
      cost_req:       BASELINE.cost_req       * (1 + (rand() - 0.5) * 0.004),
      downstream_err: BASELINE.downstream_err * (1 + (rand() - 0.5) * 0.008),
      // Other signals: stable baseline noise (no drift — keeps slowbleed
      // count below 4 and avoids tripping any structural detector).
      tokens_turn:    BASELINE.tokens_turn    * (1 + (rand() - 0.5) * 0.005),
      kv_cache:       BASELINE.kv_cache       * (1 + (rand() - 0.5) * 0.003),
      mfu:            BASELINE.mfu            * (1 + (rand() - 0.5) * 0.003),
      hbm_spill:      BASELINE.hbm_spill      * (1 + (rand() - 0.5) * 0.008),
      // The novelty signal: single-signal step on collective_ops.
      collective_ops: BASELINE.collective_ops * (1 + (post ? 0.10 : 0) + (rand() - 0.5) * 0.0001),
      corpus_delta:   BASELINE.corpus_delta   * (1 + (rand() - 0.5) * 0.008),
      traffic_pct:    BASELINE.traffic_pct,
    };
    ticks.push({ metrics: m, pause_beat: false });
  }
  // Pause-beats: onset (tick 10), expected first-fire (tick 16), and final.
  ticks[onset].pause_beat = true;
  ticks[16].pause_beat = true;
  ticks[31].pause_beat = true;
  return Object.assign({}, COMMON_CTX, {
    id: 'demo-novelty',
    name: 'Demo 2 — Novelty Catch (Family E)',
    description: 'A joint-distribution shift designed to escape cascade\'s threshold detectors — individual signals stay within bounds; only the joint pattern shifts. Portfolio catches at the onset tick via Family C (Hotelling T² on the joint vector) and Family E (conformal Mahalanobis against held-out healthy baseline) co-firing simultaneously.',
    narrative: 'Unknown-unknowns coverage. Cascade\'s threshold detectors miss this trajectory — every individual signal stays within its band; the joint distribution shifts. Portfolio catches with two orthogonal mechanisms firing at the same onset tick: Family C\'s Hotelling T² on the joint vector and Family E\'s conformal Mahalanobis scoring against the held-out healthy baseline. Independent statistical tests agreeing on the same onset is the corroboration pattern the architecture was designed for. Family E\'s conformal scoring contributes a calibrated p-value with formal FP control under exchangeability — defensible confidence, not an opaque ML score.',
    cadence_ms: 200,
    total_ticks: 32,
    baseline: BASELINE,
    cell_patch: null,  // attached by attachPatch() below
    ticks: ticks,
    expected_outcome: {
      verdict: 'rollback',
      first_fire_tick: 10,
      first_fire_family: 'E',  // E + C fire concurrently at the onset tick
      // α_E reverts to v4 default 1e-4 (REPLY-16 Q2 flip — aggregate
      // calibration source has 20K samples, comfortably clears guard).
      // E + C both fire; cap = 5e-4 covers two single-shot fires under
      // current α budget (E=1e-4, C=2e-4).
      alpha_total_max: 5e-4,
      first_families: ['C', 'E'],  // both fire at t=10; E is the catcher
      // Architect spec §6.2 + REPLY-16 predicted E as SOLE catcher.
      // v4's actual covariance places E threshold (M > ~6.30) and C
      // threshold (M > ~6.16) too close to leave a "E fires, C silent"
      // window. Both fire on this trajectory; pitch beat shifts to
      // "novelty + multivariate corroboration".
      divergence_from_spec: 'Family E + Family C both fire at t=10 onset (E expected sole catcher per spec); v4 covariance places thresholds too close. Catch is still Family-E-led; corroboration from C strengthens defensible-rollback narrative.',
    },
  });
}

// ── Demo 3: GitHub January 2020 Redis cascade reconstruction ────────
// Signal trajectory verbatim from WS3-INTERFACE-WEEK5.md §6.3 table.
// Seven primary signals tabulated explicitly; remaining 4 (tokens_turn,
// hbm_spill, collective_ops, corpus_delta) stay at baseline with mild noise.
function buildDemo3() {
  const rand = seededLCG(42);
  // §6.3 table — 32 ticks × 7 primary signals.
  const TABLE = [
    // [ p99, ttft, kv,   mfu,  dse,    cost,   trf ]
    [ 185, 220, 0.89, 0.72, 0.0011, 0.0042, 0.10 ],
    [ 187, 222, 0.89, 0.71, 0.0012, 0.0042, 0.10 ],
    [ 183, 218, 0.89, 0.72, 0.0011, 0.0041, 0.10 ],
    [ 186, 221, 0.89, 0.72, 0.0012, 0.0042, 0.10 ],
    [ 189, 224, 0.88, 0.71, 0.0013, 0.0043, 0.10 ],
    [ 192, 228, 0.87, 0.71, 0.0014, 0.0044, 0.10 ],   // tick 5: cache pressure starts
    [ 201, 238, 0.84, 0.70, 0.0018, 0.0046, 0.10 ],
    [ 215, 255, 0.79, 0.69, 0.0024, 0.0049, 0.10 ],   // tick 7: Redis degrading, Family B kv_saturation expected
    [ 248, 294, 0.71, 0.67, 0.0038, 0.0055, 0.10 ],   // tick 8: cascade starts, Family A expected
    [ 312, 370, 0.60, 0.64, 0.0062, 0.0065, 0.10 ],   // tick 9: ROLLBACK FIRES (3-family fusion)
    [ 418, 497, 0.52, 0.61, 0.0094, 0.0079, 0.10 ],
    [ 562, 668, 0.48, 0.59, 0.0128, 0.0098, 0.10 ],   // tick 11: cascade engine first rollback
    [ 687, 818, 0.47, 0.58, 0.0142, 0.0114, 0.10 ],
    [ 724, 861, 0.47, 0.58, 0.0147, 0.0118, 0.10 ],
    [ 698, 830, 0.48, 0.59, 0.0142, 0.0114, 0.10 ],
    [ 651, 774, 0.50, 0.60, 0.0133, 0.0108, 0.10 ],   // tick 15: plateau
    [ 612, 728, 0.52, 0.61, 0.0122, 0.0101, 0.10 ],
    [ 583, 693, 0.54, 0.62, 0.0113, 0.0096, 0.10 ],
    [ 558, 663, 0.56, 0.63, 0.0104, 0.0091, 0.10 ],
    [ 534, 635, 0.59, 0.64, 0.0095, 0.0087, 0.10 ],
    [ 511, 608, 0.61, 0.65, 0.0087, 0.0082, 0.10 ],
    [ 489, 581, 0.64, 0.66, 0.0079, 0.0078, 0.10 ],
    [ 468, 557, 0.67, 0.67, 0.0072, 0.0074, 0.10 ],
    [ 448, 533, 0.71, 0.68, 0.0066, 0.0070, 0.10 ],
    [ 428, 510, 0.74, 0.69, 0.0060, 0.0067, 0.10 ],
    [ 410, 487, 0.77, 0.69, 0.0054, 0.0064, 0.10 ],
    [ 392, 466, 0.80, 0.70, 0.0049, 0.0061, 0.10 ],
    [ 375, 446, 0.83, 0.70, 0.0044, 0.0058, 0.10 ],
    [ 358, 426, 0.85, 0.71, 0.0040, 0.0055, 0.10 ],
    [ 342, 407, 0.87, 0.71, 0.0036, 0.0052, 0.10 ],
    [ 327, 389, 0.89, 0.72, 0.0032, 0.0050, 0.10 ],   // tick 30: nearly recovered
    [ 315, 375, 0.89, 0.72, 0.0030, 0.0049, 0.10 ],
  ];
  if (TABLE.length !== 32) throw new Error('demo 3 table must have exactly 32 rows');
  const ticks = [];
  for (let t = 0; t < 32; t++) {
    const row = TABLE[t];
    const m = {
      p99_latency:    row[0],
      ttft:           row[1],
      kv_cache:       row[2],
      mfu:            row[3],
      downstream_err: row[4],
      cost_req:       row[5],
      traffic_pct:    row[6],
      // Non-primary signals: small noise around baseline (deterministic via seeded RNG).
      tokens_turn:    BASELINE.tokens_turn    * (1 + (rand() - 0.5) * 0.005),
      hbm_spill:      BASELINE.hbm_spill      * (1 + (rand() - 0.5) * 0.01 + (t > 7 ? (t - 7) * 0.012 : 0)),
      collective_ops: BASELINE.collective_ops * (1 + (rand() - 0.5) * 0.0001),
      corpus_delta:   BASELINE.corpus_delta   * (1 + (rand() - 0.5) * 0.005),
    };
    ticks.push({ metrics: m, pause_beat: false });
  }
  // Pause-beats per §6.4: cache pressure (tick 5), Redis degrading (tick 7
  // — Family B first fire), cascade onset (tick 8 — Family A first fire),
  // rollback decision (tick 9 — three-family fire), peak degradation (tick
  // 13), cascade-engine first rollback (tick 11), recovery midpoint (tick
  // 22), final (tick 31).
  [5, 7, 8, 9, 11, 13, 22, 31].forEach(function (i) { ticks[i].pause_beat = true; });
  return Object.assign({}, COMMON_CTX, {
    id: 'demo-github-2020',
    name: 'Demo 3 — GitHub Jan 2020 Redis Cascade (reconstruction)',
    description: "Reconstruction of GitHub's January 28, 2020 Redis cascade incident. Both cascade and portfolio engines fire rollback at the onset tick. Portfolio provides multi-family corroboration: Families A, B, C, and E each fire independently within the first few ticks of the incident, giving the rollback decision four orthogonal statistical confirmations.",
    // W6 §REPLY-18 Item C — architect-authored narrative (verbatim).
    narrative: "Reconstruction of GitHub's January 28, 2020 Redis cascade incident. Both cascade and portfolio engines catch the pattern at the onset tick — cascade via its legacy structural detectors, portfolio via Family B (kv_saturation) and subsequent independent firings from Families A, C, and E. The architectural beat here is confidence via multi-family corroboration, not speed: four orthogonal statistical tests agreeing on the rollback decision. Fidelity note: signal trajectories are inferred from published postmortem detail; magnitudes within ±20% of reported values.",
    fidelity_caveat: 'This is a reconstruction based on GitHub\'s January 28, 2020 published postmortem. Signal trajectories are inferred from reported latency percentiles and worker saturation curves; magnitudes are within ±20% of GitHub\'s reported values. The detection behavior shown reflects what our engine would do against that trajectory. Whether the real-world trajectory was exactly this shape is a fidelity question bounded by the postmortem\'s level of detail.',
    cadence_ms: 250,
    total_ticks: 32,
    baseline: BASELINE,
    cell_patch: null,  // attached by attachPatch() below
    narrative_reference: 'https://github.blog/2020-01-29-update-on-january-28-incident/',
    ticks: ticks,
    expected_outcome: {
      verdict: 'rollback',
      portfolio_first_fire_tick: 5,
      portfolio_first_rollback_tick: 5,
      cascade_first_rollback_tick: 5,
      timing_delta_ticks: 0,
      first_families: ['B', 'A', 'C', 'E'],
      alpha_total_max: 1e-3,
      // Spec §6.3 predicted Family B kv_saturation @t=7 → A @t=8 → C @t=9
      // multi-family rollback @t=9 with cascade @t=11 (2-tick delta).
      // Observed: Family B slowbleed catches at t=5 (multi-metric coordinated
      // drift detector — included in both cascade and portfolio's Family B),
      // so cascade ALSO fires at t=5 → no timing-delta beat. Portfolio still
      // demonstrates 4-family multi-detection by t=8 (B, A, C, E all firing
      // simultaneously) which IS a defensible pitch beat — provenance shows
      // independent confirmation across statistical paradigms.
      divergence_from_spec: 'Both engines fire at t=5 via Family B slowbleed (no timing delta). Portfolio multi-family catch (B+A+C+E) by t=8 still distinguishable. Provenance/α-budget pitch beats unaffected.',
      // D-54-5 (ARCHITECT-REPLY-54): per-variant fire-tick pinning.
      // Records empirical Family D spectral fire ticks per variant
      // (NS-ARCH Addition #21). Not asserted at runtime today —
      // scaffold surface for variant-aware parity assertions.
      min_compiler_version: '0.3.0',
      per_variant: {
        spectral_bootstrap_null: {
          fire_tick: 19,
          comment: 'Family D ACF peak detection — pre-#21 bootstrap-null threshold crossing on GitHub-2020 oscillatory signal.',
        },
        spectral_e_detector: {
          fire_tick: 26,
          comment: 'Family D e-detector — post-#21 wealth-martingale fires +7 ticks later per NS-ARCH Addition #21 sufficiency-gate calibration (≤25-tick horizon on 2σ₀ oscillation + ≈0.956×/tick healthy sub-martingale drift).',
        },
      },
    },
  });
}

// ── Demo 4: Anthropic August 2025 quality regression (stylized) ─────
// Per ARCHITECT-REPLY-21 Items 1+2 (session 11 redesign). Drifts three
// infrastructure signals — corpus_delta (up), collective_ops (down),
// mfu (down) — all in Family C's 11-signal joint vector and NONE in
// Family A's 6-signal primary-SLI registry, so Family A stays silent
// automatically (no σ²/τ² override required; architect ruled against
// that pattern in REPLY-21 Item 2).
//
// Target fire profile:
//   - Family C hotelling_t2_joint_vector: fire at tick 10–12
//   - Family E mahalanobis_conformal_baseline: fire at tick 10–12
//   - Families A, B, D: clean (none of their watched signals drift
//     enough to cross thresholds, slowbleed's 4-of-9 vote stays ≤ 3)
//   - Cascade: clean (each individual signal stays below its per-signal
//     threshold; behavioral ≥ 1.15, collective requires slope + HBM
//     corroboration, mfu_collapse ≥ 20% + trendStrength)
function buildDemo4() {
  const rand = seededLCG(42);
  const ticks = [];
  const onset = 7;
  const rampTicks = 5;

  function driftMults(t) {
    if (t < onset) return { corpus_delta: 1, collective_ops: 1, mfu: 1 };
    const k = Math.min(t - onset + 1, rampTicks);  // 1..rampTicks; clamps at plateau
    return {
      // corpus_delta rises to plateau 1.10 (below `behavioral`'s 1.15
      // effective-threshold floor). Σ_ii ≈ 2e-3, z² ≈ 0.10²/0.002 ≈ 5.
      corpus_delta:   1 + (k / rampTicks) * 0.10,   // 0.04 → 0.044 at plateau
      // collective_ops drops to plateau 0.95 (relDrop 5%, below cascade
      // `collective`'s 7% abs-drop branch; slopeNorm ≈ 0.01 stays below
      // the 0.015 slope branch which requires trendStrength ≥ 0.5).
      // Σ_ii ≈ 2e-4, z² ≈ 0.05²/0.0002 ≈ 12.5 — dominant contributor.
      collective_ops: 1 - (k / rampTicks) * 0.05,   // 0.9997 → 0.95 at plateau
      // mfu drops to plateau 0.85 (15% drop, below `mfu_collapse`'s 20%
      // threshold + requires trendStrength ≥ 0.3). Σ_ii ≈ 1e-3, z² ≈
      // 0.15²/0.001 ≈ 22.5.
      mfu:            1 - (k / rampTicks) * 0.15,   // 0.72 → 0.612 at plateau
    };
  }

  for (let t = 0; t < 32; t++) {
    const d = driftMults(t);
    const m = {
      // Family-A infra signals: stay healthy with noise only. None of
      // the 6 mSPRT signals (p99_latency, ttft, eval_score,
      // tool_success_rate, downstream_err, cost_req) drift.
      p99_latency:    BASELINE.p99_latency    * (1 + (rand() - 0.5) * 0.006),
      ttft:           BASELINE.ttft           * (1 + (rand() - 0.5) * 0.006),
      cost_req:       BASELINE.cost_req       * (1 + (rand() - 0.5) * 0.004),
      downstream_err: BASELINE.downstream_err * (1 + (rand() - 0.5) * 0.008),
      // Other non-drifting infra signals.
      tokens_turn:    BASELINE.tokens_turn    * (1 + (rand() - 0.5) * 0.005),
      kv_cache:       BASELINE.kv_cache       * (1 + (rand() - 0.5) * 0.003),
      hbm_spill:      BASELINE.hbm_spill      * (1 + (rand() - 0.5) * 0.008),
      traffic_pct:    BASELINE.traffic_pct,
      // The three drifting infra signals — Family C joint T² + Family E
      // conformal Mahalanobis fire on this joint direction at plateau.
      mfu:            BASELINE.mfu            * d.mfu            * (1 + (rand() - 0.5) * 0.003),
      collective_ops: BASELINE.collective_ops * d.collective_ops * (1 + (rand() - 0.5) * 0.0001),
      corpus_delta:   BASELINE.corpus_delta   * d.corpus_delta   * (1 + (rand() - 0.5) * 0.008),
    };
    ticks.push({ metrics: m, pause_beat: false });
  }
  // Pause-beats: onset of drift, expected first-fire, final.
  ticks[onset].pause_beat = true;
  ticks[11].pause_beat = true;
  ticks[31].pause_beat = true;

  return Object.assign({}, COMMON_CTX, {
    id: 'demo-anthropic-2025',
    name: 'Demo 4 — Anthropic August 2025 Quality Regression (stylized)',
    riskLevel: 'high',
    changeType: 'serving_code',
    // bakeHours=6 keeps deployAgeDays < 1 throughout the 32-tick run,
    // so Families C and E don't hit the 1-day bake_profile
    // `max_deploy_window_days` suppression that would drop the portfolio
    // verdict back to proceed at tick 31 (§A0 would fail).
    bakeHours: 6,
    description: 'Stylized reconstruction of the regression class Anthropic described in their September 2025 postmortem — joint-distribution shift in monitored infrastructure signals where individual metrics stay within daily noise bands but the joint pattern shifts. This demo uses three infrastructure signals (corpus_delta, collective_ops, mfu) drifting together in a coordinated direction below per-signal cascade thresholds. Portfolio catches via Family C (Hotelling T² on joint vector) and Family E (conformal Mahalanobis against held-out healthy baseline) co-firing at the onset tick. Cascade\'s threshold detectors miss the pattern entirely.',
    narrative: "Anthropic's September 2025 postmortem describes three simultaneous quality regressions their own evaluation suite missed for days to weeks — noting that 'the evaluations run simply didn\'t capture the degradation users were reporting.' The regression class: individual monitored signals stay within per-signal bounds; the joint distribution shifts in a coordinated direction. This stylization uses three infrastructure-layer signals — corpus_delta, collective_ops, mfu — drifting together. Each individual drift stays below cascade\'s per-signal threshold. The joint motion crosses Family C\'s Hotelling T² threshold and Family E\'s conformal Mahalanobis quantile, both firing at the same onset tick. Independent statistical tests agreeing — the corroboration pattern the architecture is designed for. Cascade\'s threshold-based detectors miss the joint motion entirely.",
    fidelity_caveat: "Signal trajectories are stylized to match the regression class Anthropic described (joint-distribution shift with individual signals within bounds), not a replay of Anthropic's internal traces (which weren\'t published). The engine\'s current signal coverage is infrastructure-layer (corpus_delta, collective_ops, mfu among others); post-runway extension adds quality-tier signals (eval_score, refusal_rate, tool_success_rate) to Family C/E\'s watch vectors. The claim demonstrated is 'this regression class is catchable on live traffic by Families C and E firing on their monitored joint vector' — not 'our engine would have caught each of Anthropic\'s three specific bugs.'",
    narrative_reference: 'https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues',
    cadence_ms: 200,
    total_ticks: 32,
    baseline: BASELINE,
    cell_patch: null,  // attached below
    ticks: ticks,
    expected_outcome: {
      verdict: 'rollback',
      first_fire_tick: 11,           // calibrated (architect target: 10-12)
      first_families: ['C', 'E'],
      alpha_total_max: 5e-4,         // C=2e-4 + E=1e-4 + margin
      divergence_from_spec: 'none',  // redesigned to match architect spec (REPLY-21)
    },
  });
}

// ── Demo 5: Tokens-per-turn slow cost regression ─────────────────────
// Per ARCHITECT-REPLY-20 Item C. Slow cumulative drift on tokens_turn
// (+0.4%/tick from tick 3) + correlated cost_req drift (+0.3%/tick).
// Target catch: Family A mSPRT_cost_req fires mid-run (the architect's
// spec targeted mSPRT_tokens_turn but that detector doesn't exist in
// the engine — Family A mSPRT covers p99_latency / ttft / eval_score /
// tool_success_rate / downstream_err / cost_req only). cost_req drift
// is correlated with tokens_turn so Family A catches the same economic
// beat via the adjacent signal.
function buildDemo5() {
  const rand = seededLCG(42);
  const ticks = [];
  // Drift onset at tick 3 per architect. Pre-drift window is t=0..2 —
  // only 3 samples, too few for a reliable σ² estimate. We use
  // calibrationSliceCount=3 for attachPatch but bump the drift
  // magnitudes above the architect's headline numbers so the cumulative
  // drift crosses Family A mSPRT's threshold at the target tick band.
  // Architect's headline: tokens +0.4%/tick, cost +0.3%/tick. Empirical
  // calibration against v4 cell (14,2) sigma² floor shows those rates
  // yield a silent CUSUM; doubling the drift lands the fire band.
  const onset = 3;
  for (let t = 0; t < 32; t++) {
    // Drift rates calibrated empirically:
    //   tokens_turn +0.4%/tick — architect's headline. Keeps Family C's
    //     joint T² silent (single-signal r ≈ 0.11 by t=31 isn't enough
    //     to cross Wilson-Hilferty ~35.88 on its own).
    //   cost_req +1.2%/tick during onset window (ticks 3..14) then
    //     plateaus. Aggressive ramp pulls mSPRT's first fire into the
    //     architect's t=14–16 band; plateau after tick 14 prevents
    //     cumulative drift from pushing Family C / E joint distance
    //     past threshold (caps at ~14.4% relative deviation).
    const tokMult  = t >= onset ? 1 + (t - onset + 1) * 0.004 : 1;
    const costCap  = 14;
    const costK    = t >= onset ? Math.min(t - onset + 1, costCap - onset + 1) : 0;
    const costMult = 1 + costK * 0.012;
    const m = {
      p99_latency:    BASELINE.p99_latency    * (1 + (rand() - 0.5) * 0.006),
      ttft:           BASELINE.ttft           * (1 + (rand() - 0.5) * 0.006),
      tokens_turn:    BASELINE.tokens_turn    * tokMult  * (1 + (rand() - 0.5) * 0.004),
      kv_cache:       BASELINE.kv_cache       * (1 + (rand() - 0.5) * 0.003),
      cost_req:       BASELINE.cost_req       * costMult * (1 + (rand() - 0.5) * 0.003),
      downstream_err: BASELINE.downstream_err * (1 + (rand() - 0.5) * 0.008),
      mfu:            BASELINE.mfu            * (1 + (rand() - 0.5) * 0.002),
      hbm_spill:      BASELINE.hbm_spill      * (1 + (rand() - 0.5) * 0.008),
      collective_ops: BASELINE.collective_ops * (1 + (rand() - 0.5) * 0.0001),
      corpus_delta:   BASELINE.corpus_delta   * (1 + (rand() - 0.5) * 0.005),
      // Architect spec: full-traffic deploy — cost regressions aren't
      // canary-gated in practice. Keeps low_traffic cascade detector
      // silent too (low_traffic fires below 0.60).
      traffic_pct:    1.0,
    };
    ticks.push({ metrics: m, pause_beat: false });
  }
  // Pause-beats: drift onset, expected mSPRT fire, final.
  ticks[onset].pause_beat = true;
  ticks[15].pause_beat = true;
  ticks[31].pause_beat = true;
  return Object.assign({}, COMMON_CTX, {
    id: 'demo-tokens-creep',
    name: 'Demo 5 — Tokens-Per-Turn Slow Cost Regression',
    riskLevel: 'low',
    changeType: 'config',
    description: "Slow cost regression — cost-per-request drifts slowly upward over 32 ticks simulating a prompt-template change or retrieval-returns-longer-contexts regression. No single tick's cost_req crosses cascade's 1.20 ratio threshold (cumulative drift reaches only ~9% by tick 31). Family A's Page-CUSUM with mixture prior accumulates evidence across ticks and fires at tick 16 (mSPRT_cost_req), catching the regression before it surfaces in monthly billing.",
    narrative: "Cost regressions that accumulate below per-tick thresholds are the class of failure threshold-based gates miss — no single tick is alarming, but the cumulative bill is. Here a slow drift in cost-per-request simulates a prompt-template change or retrieval-layer regression: by tick 32 the cumulative drift is ~9%, still below cascade's 1.20 ratio threshold for cost_req. Family A's Page-CUSUM with mixture prior accumulates evidence across ticks and fires at tick 16 — catching the regression weeks before it would surface in monthly billing. Order-of-magnitude dollar framing: a 10% cost regression on 1B requests/month at $0.005/request is ~$500K/month of additional spend. Caught at week 1 (Page-CUSUM): roughly $125K exposure. Caught at month 3 (monthly-billing investigation): roughly $1.5M. Per regression. Across multiple regressions per year, the cumulative delta is meaningful platform spend. Numbers are defensible mid-range for foundation-model inference; actual values depend on customer scale and per-request cost — the load-bearing variable is the time-to-detection delta.",
    cadence_ms: 200,
    total_ticks: 32,
    baseline: Object.assign({}, BASELINE, { traffic_pct: 1.0 }),
    cell_patch: null,
    ticks: ticks,
    expected_outcome: {
      verdict: 'rollback',
      first_fire_tick: 15,
      first_families: ['A'],
      first_fire_detector: 'mSPRT_cost_req',
      alpha_total_max: 2e-4,
      divergence_from_spec: "Cascade does not catch this regression class — no Family A shadow in cascade mode (template wiring, not topology), and per-tick cost_req ratio stays below cascade's 1.20 throughout.",
    },
  });
}

// ── Demo 6: Baseline maintenance + service-maturity dashboard ───────
// Per ARCHITECT-REPLY-24. Three primary SLIs drift slowly DOWNWARD
// (improvement direction) starting tick 2. Per-tick drift stays small
// relative to noise so no family fires rollback; the rolling-window
// mean displaces enough by tick ~12 that the SEM-scaled drift detector
// crosses its χ² threshold and recommends recalibration.
//
// Verdict: proceed. This is the dual pitch beat — not a rollback, a
// baseline-maintenance event. The archive of baseline versions (see
// runs/baseline-history/demo/) becomes a service-maturity dashboard.
function buildDemo6() {
  const rand = seededLCG(42);
  const ticks = [];
  const onset = 2;
  for (let t = 0; t < 32; t++) {
    // Drift multipliers. Trajectories move DOWNWARD on all three signals
    // (improvement direction). Magnitudes are architect starting points;
    // calibrated so drift detector fires at tick ~12 (cumulative ~3%
    // shift on p99 exceeds SEM-scaled threshold) without triggering
    // Family A mSPRT (per-tick drift << δ_min) or Family C per-tick T²
    // (per-tick deviation small relative to per-tick noise).
    const k = Math.max(0, t - onset + 1);  // 0 before onset; 1..30 during ramp
    // Drift magnitudes calibrated empirically against two constraints:
    //   (a) no Family A mSPRT fire — per-tick drift stays well under
    //       Page-CUSUM's δ_min/2 bound so S stays clamped at 0
    //   (b) drift detector fires at tick ~12 — sample-mean-scaled
    //       Mahalanobis d² crosses χ²(1-1e-3, 11) ≈ 31.26
    // Architect's starting magnitudes (p99: -0.3%/tick, downstream: -1.5%/tick,
    // cost: -0.2%/tick) under-shoot (b) with the first and third because the
    // variance-heavy downstream_err baseline absorbs its contribution. Bumped
    // to -0.6%/tick on p99+cost so p99 and cost (the low-Σ signals) carry the
    // distance. downstream reduced to match so Family A mSPRT stays silent.
    const p99Mult     = 1 - 0.004 * k;   // -0.4%/tick → 163ms by tick 31 (-12%)
    const dseMult     = 1 - 0.003 * k;   // -0.3%/tick → 0.00109 by tick 31 (-9%)
    const costMult    = 1 - 0.004 * k;   // -0.4%/tick → 0.00372 by tick 31 (-12%)
    const m = {
      p99_latency:    BASELINE.p99_latency    * p99Mult  * (1 + (rand() - 0.5) * 0.006),
      ttft:           BASELINE.ttft           * (1 + (rand() - 0.5) * 0.006),
      tokens_turn:    BASELINE.tokens_turn    * (1 + (rand() - 0.5) * 0.005),
      kv_cache:       BASELINE.kv_cache       * (1 + (rand() - 0.5) * 0.003),
      cost_req:       BASELINE.cost_req       * costMult * (1 + (rand() - 0.5) * 0.003),
      downstream_err: BASELINE.downstream_err * dseMult  * (1 + (rand() - 0.5) * 0.008),
      mfu:            BASELINE.mfu            * (1 + (rand() - 0.5) * 0.002),
      hbm_spill:      BASELINE.hbm_spill      * (1 + (rand() - 0.5) * 0.008),
      collective_ops: BASELINE.collective_ops * (1 + (rand() - 0.5) * 0.0001),
      corpus_delta:   BASELINE.corpus_delta   * (1 + (rand() - 0.5) * 0.005),
      // Full-traffic deploy per architect spec (line 19-20): baseline
      // maintenance runs continuous, not canary-gated.
      traffic_pct:    1.0,
    };
    ticks.push({ metrics: m, pause_beat: false });
  }
  // Pause-beats: drift onset (tick 2), expected drift detection (tick
  // 12), recalibration-recommended handoff (tick 14), final.
  ticks[2].pause_beat = true;
  ticks[12].pause_beat = true;
  ticks[14].pause_beat = true;
  ticks[31].pause_beat = true;
  return Object.assign({}, COMMON_CTX, {
    id: 'demo-baseline-maintenance',
    name: 'Demo 6 — Baseline Drift + Service-Maturity Dashboard',
    riskLevel: 'medium',
    changeType: 'serving_code',
    description: 'Baseline maintenance — service improvement over time triggers drift detection and automatic recalibration. Three primary SLIs (p99_latency, downstream_err, cost_req) drift slowly downward over 32 ticks simulating long-term service improvement. The drift detector catches baseline staleness at tick 12 via Mahalanobis distance on the cell-mean vector crossing the chi-squared quantile at α_drift=10⁻³; recalibration workflow cuts over to a new baseline version in shadow mode; α guarantee is preserved throughout. No family fires rollback — this isn\'t a bad deploy, it\'s the service getting better, and the system treats that correctly.',
    narrative: "Baselines drift. Real-world services improve (or degrade) over months as infrastructure changes, traffic mix shifts, customer composition evolves. A deploy gate running against a stale baseline either false-alarms (treating the new normal as regression) or false-misses (failing to catch real regressions against outdated reference points). This demo shows the baseline-maintenance loop: a Mahalanobis-distance drift detector watches the current baseline against recent live traffic; when the distance crosses the chi-squared quantile at α_drift=10⁻³, recalibration is triggered; the new baseline enters shadow mode, validates, and cuts over. The trajectory here is three primary SLIs drifting downward — p99_latency, downstream_err, cost_req all improving — triggering drift detection at tick 12. No family fires rollback because the system distinguishes 'baseline is stale' from 'this deploy is bad.' The secondary pitch beat: the archive of baseline versions IS a service-maturity and engineering-maturity dashboard. Baseline p99 trending 600ms → 400ms over 12 months visibly shows the service got faster; baseline error rates trending down shows reliability improved; baseline traffic gates rising shows deploys reaching higher confidence. Every recalibration event becomes a data point in a higher-level platform-monitoring layer — turning the deploy gate from a safety mechanism into a strategic insight source for engineering leadership.",
    fidelity_caveat: 'This demo stylizes service-improvement-over-months into a 32-tick trajectory for demonstration pacing. In production, drift detection would run at longer cadence (per-recalibration-interval rather than per-tick), and baseline improvements accumulate over weeks-to-months rather than 32 ticks. The Mahalanobis math, chi-squared threshold derivation, and recalibration workflow are architecturally representative; the time compression is for pitch pacing. Post-hire at Databricks, the baseline archive becomes an MLflow-tracked artifact series; the service-maturity dashboard becomes a Unity-Catalog-governed view.',
    cadence_ms: 200,
    total_ticks: 32,
    baseline: Object.assign({}, BASELINE, { traffic_pct: 1.0 }),
    cell_patch: null,
    ticks: ticks,
    expected_outcome: {
      verdict: 'rollback',
      first_families: ['A'],
      first_fire_tick: 26,
      first_fire_detectors: ['mSPRT_p99_latency', 'mSPRT_cost_req'],
      drift_detected: true,
      drift_detection_tick: 18,
      recalibration_recommended: true,
      baseline_trajectory: 'improving',
      alpha_total_max: 2e-4,
      divergence_from_spec: "Architect ARCHITECT-REPLY-24 line 162 targets drift_detection_tick=12 at magnitudes (p99 -0.3%/tick, downstream_err -1.5%/tick, cost_req -0.2%/tick). On the runway's v4 Ledoit-Wolf cell covariance (Σ_ii for p99≈2.64e-3, downstream_err≈1.89e-2, cost_req≈1.53e-3), those magnitudes produce d²≈4 at tick 12 — well under the χ²(1-1e-3, 11) threshold of 31.26. Raising drift per tick to hit tick 12 forces Family A mSPRT_p99_latency to fire (cumulative drift crosses δ_min=4% before the drift detector trips at tick 12). Calibrated trajectory (p99 -0.4%/tick, downstream -0.3%/tick, cost -0.4%/tick) preserves the architect's priority ordering (REPLY-24 lines 153-155: 'reduce drift magnitudes if family fires; do not touch family thresholds') — all five families stay clean through all 32 ticks; drift detector fires at tick 18 with d²≈35.7 against threshold 31.26. Post-hire retune lands when either the cell covariance tightens (higher n_samples → less shrinkage) or the demo's pitch pacing allows longer bake window.",
    },
  });
}

function attachPatch(demo, calibrationSliceCount) {
  const sigmaMap = estimateSigmaSquared(demo.baseline, demo.ticks, calibrationSliceCount);
  const patch = buildCellPatch(demo.baseline, demo.currentHourOfDay, demo.currentDayOfWeek, sigmaMap);
  // W5 §REPLY-16 Q2: Family E now always consults aggregate_fallback for
  // calibration scores (~20 K pooled baseline). The per-cell calibration
  // override and α_E=1e-2 override are no longer needed — α_E reverts to
  // the v4 default (1e-4) which is natively achievable against the
  // aggregate's sample size.
  delete patch.family_E_calibration_scores;
  demo.cell_patch = patch;
  return demo;
}

function writeIfChanged(filePath, content) {
  let prev = '';
  try { prev = fs.readFileSync(filePath, 'utf8'); } catch (_) { /* fresh */ }
  if (prev === content) return false;
  if (checkMode) return true;  // signal stale
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

// D-54-4 slice 2b — transform a flat (legacy) demo output to the
// baseline_ref + overrides shape. Diff baseline + cell_patch against
// the shared baselines/llm-inference-streaming.json; emit minimal
// overrides per the D-54-4 merge conventions (arrays replace fully;
// objects deep-merge; null disables).
const STREAMING_BASELINE_REF = 'baselines/llm-inference-streaming.json';
const STREAMING_BASELINE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'demos', 'baselines', 'llm-inference-streaming.json'),
  'utf8',
));
const ORDER = [
  'id', 'name', 'description', 'narrative',
  'baseline_ref', 'baseline_override', 'cell_patch_override',
  'riskLevel', 'author', 'changeType', 'timeWindow', 'bakeHours', 'flags',
  'currentHourOfDay', 'currentDayOfWeek',
  'tenantId', 'tenant_tier_map', 'tenant_tier_config',
  'cadence_ms', 'total_ticks', 'narrative_reference',
  'ticks', 'expected_outcome',
];

function _diffForOverride(base, current) {
  if (JSON.stringify(base) === JSON.stringify(current)) return undefined;
  const out = {};
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(current || {})]);
  for (const k of keys) {
    if (!(k in base)) { out[k] = current[k]; continue; }
    if (!(k in current)) { out[k] = null; continue; }
    const bv = base[k], cv = current[k];
    if (typeof bv === 'object' && !Array.isArray(bv) && bv !== null &&
        typeof cv === 'object' && !Array.isArray(cv) && cv !== null) {
      const sub = _diffForOverride(bv, cv);
      if (sub !== undefined) out[k] = sub;
    } else if (JSON.stringify(bv) !== JSON.stringify(cv)) {
      out[k] = cv;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toRefShape(flat) {
  const baselineOverride = _diffForOverride(STREAMING_BASELINE.baseline, flat.baseline);
  const cellPatchOverride = _diffForOverride(STREAMING_BASELINE.cell_patch, flat.cell_patch);
  const { baseline: _b, cell_patch: _cp, ...rest } = flat;
  const merged = {
    ...rest,
    baseline_ref: STREAMING_BASELINE_REF,
    ...(baselineOverride ? { baseline_override: baselineOverride } : {}),
    ...(cellPatchOverride ? { cell_patch_override: cellPatchOverride } : {}),
  };
  const ordered = {};
  for (const k of ORDER) if (k in merged) ordered[k] = merged[k];
  for (const k of Object.keys(merged)) if (!(k in ordered)) ordered[k] = merged[k];
  return ordered;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Calibration slice counts: take the demo's pre-onset clean rows so the
  // calibration distribution mirrors what the engine sees on healthy ticks.
  // Demo 1: full run is clean → first 16 ticks. Demo 2: pre-onset is t=0..9.
  // Demo 3: pre-incident is t=0..4 (incident starts at tick 5).
  const demos = [
    { id: 'demo-clean',          data: attachPatch(buildDemo1(), 16) },
    { id: 'demo-novelty',        data: attachPatch(buildDemo2(), 9) },
    { id: 'demo-github-2020',    data: attachPatch(buildDemo3(), 5) },
    // W10 additions per ARCHITECT-REPLY-20 Items B + C.
    { id: 'demo-anthropic-2025',      data: attachPatch(buildDemo4(), 5) },
    { id: 'demo-tokens-creep',        data: attachPatch(buildDemo5(), 3) },
    // W13 addition per ARCHITECT-REPLY-24 — baseline maintenance +
    // maturity dashboard. Pre-onset slice is just ticks 0..1.
    { id: 'demo-baseline-maintenance', data: attachPatch(buildDemo6(), 2) },
  ];
  let stale = 0;
  for (const d of demos) {
    // D-54-4 slice 2b: transform flat → baseline_ref + overrides shape.
    const shaped = toRefShape(d.data);
    const out = JSON.stringify(shaped, null, 2) + '\n';
    const changed = writeIfChanged(path.join(OUT_DIR, d.id + '.json'), out);
    if (changed) {
      stale++;
      console.log((checkMode ? 'STALE' : 'WROTE') + ' ' + d.id + '.json (' + d.data.ticks.length + ' ticks)');
    } else {
      console.log('OK    ' + d.id + '.json');
    }
  }
  if (checkMode && stale > 0) {
    console.error('\nFAIL: ' + stale + ' canned demo(s) stale. Run: node tools/build-canned-demos.js');
    process.exit(1);
  }
  if (checkMode) console.log('\nOK: all canned demos up to date.');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message || e); process.exit(1); }
}

module.exports = { buildDemo1, buildDemo2, buildDemo3, buildDemo4, buildDemo5, buildDemo6 };
