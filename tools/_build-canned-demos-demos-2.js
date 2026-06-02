'use strict';
/**
 * tools/_build-canned-demos-demos-2.js — demo builders 4–6 for the canned
 * demo generator (split out of build-canned-demos.js verbatim).
 */

const { COMMON_CTX, BASELINE, seededLCG } = require('./_build-canned-demos-shared');

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
    fidelity_caveat: 'This demo stylizes service-improvement-over-months into a 32-tick trajectory for demonstration pacing. In production, drift detection would run at longer cadence (per-recalibration-interval rather than per-tick), and baseline improvements accumulate over weeks-to-months rather than 32 ticks. The Mahalanobis math, chi-squared threshold derivation, and recalibration workflow are architecturally representative; the time compression is for pitch pacing. In a production platform deployment, the baseline archive becomes a tracked artifact series and the service-maturity dashboard becomes a governed catalog view.',
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

module.exports = { buildDemo4, buildDemo5, buildDemo6 };
