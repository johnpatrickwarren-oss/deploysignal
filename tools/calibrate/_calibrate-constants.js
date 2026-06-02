"use strict";
// tools/calibrate/_calibrate-constants.ts — module-level constants for the
// NS calibration compiler. Extracted VERBATIM from the pre-split
// tools/calibrate.ts god-file (D-54-3 god-file decomposition). No numeric
// or behavioral change; values are byte-identical.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Q2_B_6_1_PSD_EPS_RELATIVE = exports.AUDIT_TOL = exports.EMITTED_TIERS = exports.DEFAULT_TENANT_TIER_CONFIG = exports.MSPRT_MIN_SAMPLES_LEGACY = exports.TRAFFIC_GATE_MIN = exports.FAMILY_C_SIGNALS = exports.FAMILY_E_ALPHA_FRACTION = exports.FAMILY_D_ALPHA_FRACTION = exports.FAMILY_C_ALPHA_FRACTION = exports.FAMILY_A_ALPHA_FRACTION = exports.MIN_PER_SIGNAL_SAMPLES = exports.MIN_SAMPLES_POOLED = exports.MIN_SAMPLES_STRICT = exports.FAMILY_A_SIGNALS = exports.LEGACY_VOTE_THRESHOLDS = exports.HEALTHY_MEANS = exports.CUTOFF_SIGNAL = exports.LEGACY_CUTOFFS = exports.COMPILER_VERSION = void 0;
exports.COMPILER_VERSION = '0.3.0';
// Hand-tuned Family B cutoffs pulled from engine/gates/policy.ts
// THRESHOLD_PROFILES._default (risk-neutral defaults). The per-profile
// tightenings for critical+model_weights etc. live in the engine and are
// applied on top of these at resolve time — the compiler emits the base
// defaults; profile overlays are a Week-2+ concern.
exports.LEGACY_CUTOFFS = {
    p99: 1.20,
    ttft: 1.20,
    compound: 1.12,
    behavioral: 1.18,
    downstream: 1.50,
    cost: 1.20,
    tokens: 1.25,
    tok_econ_tok: 1.25,
    tok_econ_cost: 1.20,
};
// Map each Family B cutoff to the baseline signal used to estimate its
// empirical ratio quantile. Derived cutoffs (e.g. `compound`) don't map to
// one signal; we skip validation for those and just emit the legacy value.
exports.CUTOFF_SIGNAL = {
    p99: 'p99_latency',
    ttft: 'ttft',
    compound: null, // joint of p99 + ttft — skip empirical validation
    behavioral: 'corpus_delta',
    downstream: 'downstream_err',
    cost: 'cost_req',
    tokens: 'tokens_turn',
    tok_econ_tok: 'tokens_turn',
    tok_econ_cost: 'cost_req',
};
// Per-signal healthy means — must match the generator. Kept here locally
// rather than imported from the generator so the compiler can validate
// against any baseline bundle source, not just ours.
exports.HEALTHY_MEANS = {
    p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042,
    downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997,
    corpus_delta: 0.04, traffic_pct: 1.0,
    eval_score: 0.85, refusal_rate: 0.02, output_len_p50: 220,
    tool_success_rate: 0.95,
};
// Vote-threshold registry. slowbleed's "4-of-9 drifting" heuristic is the
// one Family B vote threshold in shared.js today; mSPRT additions are
// Week-2+ work.
exports.LEGACY_VOTE_THRESHOLDS = {
    slowbleed_drift_count: 4,
    kv_saturation_ratio: 1.04,
};
// ── Family A derivation (W2, PM-critique items 1–4) ─────────────────
// Per-cell per-signal MSPRTParams with hierarchical pooling. Primary SLIs
// per ROADMAP §Week 2: p99, ttft, eval_score, tool_success_rate,
// downstream_err, cost_req. Bonferroni-corrected α. Conservative bake
// profile. traffic_pct_gate fixed at 0.10 for W2.
exports.FAMILY_A_SIGNALS = [
    'p99_latency', 'ttft', 'eval_score', 'tool_success_rate',
    'downstream_err', 'cost_req',
];
// W3 §3.1.c thresholds per ARCHITECT-REPLY-09.md Q2 — matches Addition #2
// (NORTH-STAR-ARCHITECTURE.md). Strict cells compute directly; pooled cells
// inherit adjacent-cell samples; below pooled, the compiler emits
// `confidence: 'aggregate'` and runtime consults `aggregate_fallback`.
exports.MIN_SAMPLES_STRICT = 60;
exports.MIN_SAMPLES_POOLED = 20;
// Q60 Phase-3.d.1 (A) — sparse-substrate-tolerant per_signal[sig]
// emission threshold. Signals with fewer samples than this in a bundle
// are omitted from family_A.per_signal entirely (per-cell + aggregate-
// fallback). Setting to 1 means "any sample at all" — the failure mode
// this guards against is uniformly 0-sample signals on real-trace
// substrates (BurstGPT cost_req-only; Azure tokens_turn-only; etc.).
exports.MIN_PER_SIGNAL_SAMPLES = 1;
// α allocation per WEEK4-HANDOFF.md: 40/20/20/10/10 across A/B/C/D/E when
// all families are emitted. B absorbs the leftover when D/E aren't enabled;
// pre-W4 behavior (no D/E) kept C at 20% and gave B the remaining 40%.
exports.FAMILY_A_ALPHA_FRACTION = 0.40;
exports.FAMILY_C_ALPHA_FRACTION = 0.20;
exports.FAMILY_D_ALPHA_FRACTION = 0.10;
exports.FAMILY_E_ALPHA_FRACTION = 0.10;
// Family C signal vector — the multivariate Hotelling T² operates on these.
// Restricted to signals universally present in adversarial-scenario
// baselines. Quality-tier signals (eval_score, refusal_rate,
// tool_success_rate, output_len_p50) are optional in the Metrics contract
// and would introduce missing-data handling into the covariance derivation;
// deferred post-phase.
exports.FAMILY_C_SIGNALS = [
    'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
    'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
    'corpus_delta', 'traffic_pct',
];
// Traffic gate: below this fraction of full traffic, Family A suppresses.
exports.TRAFFIC_GATE_MIN = 0.10;
// Page-CUSUM has no truncation boundary (the test is perpetual, with
// formal anytime-valid FP control via `h = −log(α)`). `min_samples` is
// retained on MSPRTParams for schema stability but unused by the CUSUM
// detector; emit 0 to make the "no truncation" intent explicit.
exports.MSPRT_MIN_SAMPLES_LEGACY = 0;
// ── Addition #23 — tenant-tier bucketing ───────────────────────────────
//
// Tier assignment by baseline-window traffic fraction:
//   fraction ≥ DOMINANT  → 'dominant'
//   fraction ≥ LARGE     → 'large'
//   fraction ≥ MEDIUM    → 'medium'
//   fraction  < MEDIUM   → 'small'
// Boundaries are operator-configurable via CompilerOptions.tenant_tier_config.
// Lower-tier-inclusive at the boundary (fraction === boundary falls to the
// upper tier). Manual overrides bypass the fraction and force a tier.
exports.DEFAULT_TENANT_TIER_CONFIG = {
    boundaries: { dominant: 0.50, large: 0.10, medium: 0.01 },
};
/** Tiers emitted into the compiled cell matrix. Always includes
 *  'aggregate' as the migration/fallback tier. Real tenants bucket to the
 *  four operational tiers; 'aggregate' carries cross-tier pooled stats so
 *  the runtime fallback path works regardless of which tier a live
 *  request falls into. */
exports.EMITTED_TIERS = ['dominant', 'large', 'medium', 'small', 'aggregate'];
// ── Q2.B.6.1 Step 2: integration-state-audit ─────────────────────────
exports.AUDIT_TOL = 1e-8;
exports.Q2_B_6_1_PSD_EPS_RELATIVE = 1e-9;
