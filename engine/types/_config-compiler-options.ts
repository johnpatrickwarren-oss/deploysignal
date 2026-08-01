// engine/types/_config-compiler-options.ts — CompilerOptions (compiler-side
// knobs consumed by tools/calibrate.ts) plus the topology-source pointer it
// references. Split out of the engine/types/config.ts god-file; re-exported
// verbatim from there to preserve the facade export surface.

import type { ConfiguredAgent } from '@johnpatrickwarren-oss/deploysignal-engine/types/agent';

/** Addition #18 — compiler-side options consumed by `tools/calibrate.ts`
 *  when deriving `FamilyCPerCell`. Not part of the runtime surface; the
 *  engine does not read this at evaluation time. */
export interface CompilerOptions {
  /** Addition #18 D2 — operator override for the per-cell covariance
   *  estimator choice. When absent the compiler follows the sample-size
   *  rule (MCD for n ≥ 2p+1 and p ≤ 20, MRCD for n < 2p+1 and p ≤ 20,
   *  Ledoit-Wolf for p > 20). When present, every cell gets the
   *  specified method regardless of sample size. */
  covariance_method_override?: 'ledoit_wolf' | 'mcd' | 'mrcd';
  /** Addition #18 — FastMCD trimming target `α` (fraction of samples in
   *  the core subset `h = ⌈α·n⌉`). Must satisfy 0.5 ≤ α ≤ 1. Default
   *  0.75 gives a 25 % breakdown point. */
  mcd_alpha?: number;
  /** Addition #19 (ARCHITECT-REPLY-35 D3) — operator override for the
   *  Family E time-decay half-life (days). Absent → compiler auto-derives
   *  as `min(baseline_age_span_days / 2, 14)`. Present → every cell uses
   *  the specified half-life regardless of baseline span. `λ = log(2) /
   *  halflife_days` drives the exponential-decay weights attached to the
   *  parametric-bootstrap calibration scores. */
  family_e_halflife_days?: number;
  /** Addition #20 (ARCHITECT-REPLY-43 D6) — operator escape hatch that
   *  forces legacy Family C variants (`chi_square` + `bootstrap_null`)
   *  even on post-#20 compiler runs. Used for shadow-compare + audit-
   *  trail reproducibility on historical pre-#20 runs. Absent or false
   *  → compiler emits new defaults (`safe_test` + `betting_e_process`).
   *  Legacy detector paths remain in the runtime per D6 anti-scope;
   *  this flag just pins the compiler-emitted variant. */
  force_legacy_family_c?: boolean;
  /** Addition #20 (ARCHITECT-REPLY-43b — revised from original D4) —
   *  shrink fraction `c` driving the safe-Hotelling mixture-prior
   *  derivation `τ² = c · trace(Σ) / p`. Default 0.03 matches chi_square
   *  fire-timing parity on 2σ joint drift. Scale-invariant: the knob
   *  is dimensionless rather than in relative-deviation-magnitude
   *  units, so operator intuition about c transfers across baselines
   *  with different covariance scales. Higher c → stronger mixture
   *  prior → slower fire under drift; lower c → weaker prior → faster
   *  fire but higher false-positive risk near H₀. */
  family_c_shrink_fraction?: number;
  /** Addition #21 (ARCHITECT-REPLY-45 D2) — operator escape hatch that
   *  forces legacy Family D variant (`bootstrap_null`) even on post-#21
   *  compiler runs. Used for shadow-compare + audit-trail reproducibility
   *  on historical pre-#21 runs. Absent or false → compiler emits new
   *  default (`e_detector`). Legacy detector path remains in the runtime
   *  per D6 anti-scope; this flag just pins the compiler-emitted variant. */
  force_legacy_family_d?: boolean;
  /** Addition #22 (ARCHITECT-REPLY-46 D2) — operator escape hatch that
   *  forces legacy Family E variant (`weighted` quantile from #19) even
   *  on post-#22 compiler runs. Used for shadow-compare + audit-trail
   *  reproducibility on historical pre-#22 runs. Absent or false →
   *  compiler emits new default (`weighted_e_value`). Legacy detector
   *  paths remain in the runtime; this flag just pins the compiler-
   *  emitted variant.
   *
   *  @deprecated ARCHITECT-REPLY-53 R3 — superseded by
   *  `family_E_variant_selector`. Retained for backward-compat one
   *  COMPILER_VERSION cycle (through 0.3.x; removal planned at 0.4.0).
   *  Schema-migration: `true → 'force_weighted'`, `false → 'auto'`.
   *  When both fields are present, `family_E_variant_selector` wins. */
  force_legacy_family_e?: boolean;
  /** ARCHITECT-REPLY-53 R3 — unified Family E variant selector
   *  (promotes the pre-R3 internal conditional to a visible operator
   *  surface). Hybrid pattern: A/C/D remain boolean (`force_legacy_
   *  family_{a,c,d}`) since they have binary choices; E carries three
   *  kinds with a conditional gate between them, so the selector is
   *  the natural fit.
   *
   *  Selector semantics:
   *    - `'auto'` (default) — REPLY-38 D3 ESS+span gate applied
   *      verbatim. Pass → `kind:'weighted_e_value'` (REPLY-46b
   *      hedged-indicator e-value). Fail → `kind:'unweighted'`
   *      (pre-#19 parametric bootstrap).
   *    - `'force_weighted'` — preserves the ESS+span gate, but emits
   *      the pre-#22 `kind:'weighted'` (weighted quantile from #19)
   *      when the gate passes. Byte-identical to the deprecated
   *      `force_legacy_family_e: true` path.
   *    - `'force_weighted_e_value'` — bypasses the ESS+span gate;
   *      always emits `kind:'weighted_e_value'`. Used for shadow-
   *      compare when operator wants the e-value variant on a
   *      baseline that `'auto'` would route to unweighted.
   *    - `'force_unweighted'` — bypasses the gate; always emits
   *      `kind:'unweighted'`. Used for shadow-compare against the
   *      pre-#19 path.
   *
   *  Absent + `force_legacy_family_e` absent → `'auto'` (byte-
   *  identical to pre-R3 default compile). */
  family_E_variant_selector?:
    'auto' | 'force_weighted' | 'force_weighted_e_value' | 'force_unweighted';
  /** Addition #25 (ARCHITECT-REPLY-47 D2) — L3b VerdictGroup time-window
   *  length in seconds. Default 300 (5 min) ≈ one canary at 5s tick
   *  cadence (60 ticks). Groups close when a post-window verdict
   *  arrives OR on terminal verdict. Per-cell override is v2 scope. */
  verdict_group_window_seconds?: number;
  /** Addition #25 (ARCHITECT-REPLY-47 D5) — grace window for late-
   *  arriving verdicts (seconds). A verdict arriving after the
   *  containing group closed but within `grace_seconds` attaches to
   *  the prior group via `late_arrival_verdicts[]` and triggers a
   *  `verdict_group_updated` event. Default 300 (5 min) — covers
   *  max natural detector latency (Family D 30-sample window
   *  ≈ 2.5 min + settle + network lag). */
  verdict_group_grace_seconds?: number;
  /** Addition #25 (ARCHITECT-REPLY-47 D8) — saturation count for the
   *  group-confidence score `min(1, k / saturation)` where `k` is the
   *  count of distinct firing families in the group. Default 3
   *  (single-family fire → 0.33, two families → 0.67, three+ → 1.0). */
  verdict_group_confidence_saturation?: number;
  /** REPLY-50 D6b — low-variance MCD-skip. Compiler runs an LW
   *  pre-check diagnostic on MCD-routed cells and skips MCD in favor
   *  of LW when (λ < 0.1) AND (outlier-fraction under Σ_LW < 0.05).
   *  Default `true` post-slice-2 (Q2 distribution review confirmed
   *  aggregate cell activates cleanly). Explicit `false` restores
   *  slice-1 default-off behavior for byte-identical shadow-compare
   *  against pre-streamlining main. */
  enable_d6b_mcd_skip?: boolean;
  /** Addition #26 (ARCHITECT-REPLY-48 D2) — customer-configured pointer
   *  to a TopologySource. Absent → enrichment path is skipped entirely
   *  and no VerdictGroupWithTopology is emitted (pure-dormant default
   *  per acceptance criteria). */
  topology_ref?: ConfiguredTopologyRef;
  /** Addition #26 (REPLY-48 D4/P1) — window around a VerdictGroup's
   *  `[window_start_ts, window_end_ts]` inside which candidate events
   *  are eligible for temporal-overlap scoring. Default 300 s
   *  (symmetric with VerdictGroup window per D2 alignment). */
  topology_correlation_window_seconds?: number;
  /** Addition #26 (REPLY-48 D4/P1) — BFS hop-count cutoff from the
   *  group's deploy-service node. Default 3 ("beyond 3-hop, correlation
   *  is noise"). Candidates at distance > cutoff are dropped. */
  topology_max_hop_distance?: number;
  /** REPLY-51b R4-2 — cell-dimension baseline-deficiency mode.
   *  Controls compile behavior when the active profile enables a
   *  `cell_dimensions.*` axis the baseline bundle doesn't carry
   *  metadata for:
   *    'warn' (default): emit a Warning (stderr + `compile_warnings[]`),
   *      fall back to disabling the dimension for this compile.
   *    'error': throw a compile-time error; operator must realign
   *      profile vs baseline.
   *    'silent': collapse the dimension without any warning surface.
   *  Legacy (pre-#51b) compiles are unaffected — cell dimensions are
   *  driven off bundle metadata alone when no profile is active. */
  cell_dimension_deficiency_mode?: 'warn' | 'error' | 'silent';
  /** Addition #27 (ARCHITECT-REPLY-49) — agentic rollback proposer.
   *  Absent OR `enabled: false` → agent path never invoked (byte-
   *  identical behavior to pre-#27 compile + runtime). When enabled,
   *  orchestrator fires AgentProposer post-VerdictGroup-close. */
  agent?: ConfiguredAgent;

  /** Q2.A — operator-supplied per-signal class overrides. Compiler
   *  resolution: `cfg.signal_classes[signal] ?? DEFAULT_SIGNAL_CLASSES[signal]
   *  ?? 'gaussian_like'`. Override semantics: apply user overrides as-is
   *  (don't fail compile on `p99_latency: 'heavy_tail'` etc. — operators
   *  may have domain knowledge architect-defaults don't). Compiler emits
   *  resolved classes onto CompiledConfig.signal_classes for runtime
   *  consumption. Absent → all signals resolve via DEFAULT_SIGNAL_CLASSES. */
  signal_classes?: Record<string, import('@johnpatrickwarren-oss/deploysignal-engine/signal-classes').SignalClass>;
}

/** Compiler-configured pointer to a customer-hosted topology source.
 *  D2 — DS stays orchestrator-and-topology-source-agnostic; topology
 *  data lives on the customer side, DS queries via URI with an
 *  in-memory TTL cache. */
export interface ConfiguredTopologyRef {
  /** Matches a registered TopologySource.id (v1: 'otel_service_graph_v1'). */
  source_id: string;
  /** Customer-hosted endpoint URI. */
  uri: string;
  /** Fetch timeout in milliseconds. Default 5000 per D2. */
  fetch_timeout_ms?: number;
  /** In-memory snapshot cache TTL in seconds. Default 60 per D2. */
  cache_ttl_seconds?: number;
}
