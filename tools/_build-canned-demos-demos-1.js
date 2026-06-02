'use strict';
/**
 * tools/_build-canned-demos-demos-1.js — demo builders 1–3 for the canned
 * demo generator (split out of build-canned-demos.js verbatim).
 */

const { COMMON_CTX, BASELINE, seededLCG } = require('./_build-canned-demos-shared');

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
//
// §6.3 table — 32 ticks × 7 primary signals.
const DEMO3_TABLE = [
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

function buildDemo3() {
  const rand = seededLCG(42);
  const TABLE = DEMO3_TABLE;
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

module.exports = { buildDemo1, buildDemo2, buildDemo3 };
