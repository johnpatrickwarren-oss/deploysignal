// engine/types/families/c.ts — Family C (Hotelling T² + Sequential MMD).

import type { SelfNormalizedEProcessFallback } from '../self-normalized-fallback';

/** Per-cell Family C parameters. Multivariate Hotelling T² needs a mean
 *  vector and a (shrunk) covariance matrix over the signals it consumes.
 *
 *  Addition #18 (ARCHITECT-REPLY-33) — covariance_method discriminator
 *  gains `'mcd'` and `'mrcd'` alongside the default `'ledoit_wolf'`.
 *  Outlier metadata + MMD precompute land here additively; both are
 *  `null` on Ledoit-Wolf cells for backward compat with v4-and-earlier
 *  CompiledConfigs. */
export interface FamilyCPerCell {
  /** Mean vector over the Family-C signal set; length = n_family_c_signals.
   *  Under MCD/MRCD this is the robust subset mean, not the raw sample mean. */
  mean_vector: number[];
  /** Covariance matrix over the Family-C signal set; n × n, symmetric PSD.
   *  Estimator identified by `covariance_method`. */
  covariance: number[][];
  /** Ledoit-Wolf shrinkage intensity λ ∈ [0, 1]; 0 ⇒ no shrinkage. Populated
   *  only when `covariance_method === 'ledoit_wolf'` or as MRCD's shrinkage
   *  toward identity; absent under raw MCD. */
  covariance_shrinkage?: number;
  /** Addition #18 D1 — estimator identifier. `'ledoit_wolf'` is the default
   *  value when absent in a migrated v4-and-earlier config; new compilations
   *  populate explicitly.
   *
   *  REPLY-41 Option 2 — adds `'ledoit_wolf_from_degenerate_mrcd'` for
   *  audit visibility when the compiler's off-diagonal nondegeneracy gate
   *  catches an MCD/MRCD output with stripped cross-correlations and falls
   *  back to LW. Runtime treats it identically to plain `'ledoit_wolf'`;
   *  operators reading the audit see "MCD output was degenerate; LW rescue
   *  applied" instead of "LW by D2 routing". */
  covariance_method?:
    | 'ledoit_wolf'
    | 'mcd'
    | 'mrcd'
    | 'ledoit_wolf_from_degenerate_mrcd'
    | 'aggregate_fallback';
  /** REPLY-50 D6b — populated when the compiler diagnosed the cell as
   *  low-variance (LW shrinkage λ < 0.1 AND outlier fraction < 5% under
   *  LW-derived Mahalanobis distance) and skipped MCD in favor of LW.
   *  `covariance_method` remains `'ledoit_wolf'`; this field
   *  differentiates "LW by D2 routing" from "LW by D6b skip". */
  mcd_skip_reason?: 'low_variance';
  /** Addition #18 D3 — outlier-detection metadata. `null` on LW cells
   *  (no outlier step in the LW path); populated on MCD/MRCD cells. */
  outlier_detection?: OutlierDetection | null;
  /** Addition #18 D7 — Sequential MMD compile-time precompute. `null`
   *  when `covariance_method === 'ledoit_wolf'` with fewer than 500
   *  baseline samples (MMD needs enough samples to saturate the
   *  median-heuristic bandwidth estimate) or when the cell wasn't
   *  recompiled post-#18. */
  mmd_params?: MMDParams | null;
  /** Addition #20 (ARCHITECT-REPLY-43 D2) — Hotelling variant
   *  discriminator. `'chi_square'` is the legacy per-tick Wilson-
   *  Hilferty χ² test; `'safe_test'` is the mixture-prior e-process
   *  (Grünwald-de Heide-Koolen 2024). Optional for backward-compat
   *  with pre-#20 configs; absence treated as `'chi_square'` by the
   *  dispatcher. Post-#20 compiler emits `'safe_test'` on new configs. */
  hotelling_variant?: 'chi_square' | 'safe_test';
  /** Addition #20 — safe-Hotelling e-process params. Populated only
   *  when `hotelling_variant === 'safe_test'`. The `precompiled_log_det_shrink`
   *  term = ½ · log(det(Σ+τ²I) / det(Σ)) is computed once at compile
   *  time so the runtime wealth-update is O(p²) Cholesky + forward-
   *  solves without any log-det work per tick. */
  safe_hotelling_params?: SafeHotellingParams | null;
  /** Addition #20 — e-MMD betting params. Populated only when
   *  `mmd_variant === 'betting_e_process'`. Carries the kernel-
   *  baseline-mean-embedding norm² (reused from MMDParams.baseline_baseline_sum
   *  semantics) plus the per-detector α allocation and the running-
   *  moment window length for runtime standardization. */
  e_mmd_params?: EMmdParams | null;
  /** Q67 SPEC Phase-3.d.B (NEW) — canonical Shekhar-Ramdas-2023
   *  betting-e-process params. Populated when the compiled cell is
   *  routed through the Q67 v2 canonical ONS variant (post-Q67 close
   *  default). Coexists with `e_mmd_params` during Phase-3.d.B → .C
   *  transition; runtime dispatcher picks per variant flag.
   *  ADDITIVE optional; pre-Q67 configs handle gracefully (existing
   *  Option-B `evaluateEMmd` path remains the fallback at SLICE 1). */
  betting_e_process_params?: FamilyCBettingEProcessParams | null;
  /** Per ARCHITECT-REPLY-52gi §TPM-ask-2 (2026-04-26) — lower-triangular
   *  Cholesky factor `L` such that `L · Lᵀ = covariance`. Computed once
   *  per cell at compile time so validation harnesses (e.g., the
   *  parametric-Gaussian resampler in `tools/build-report-card.js`) can
   *  generate joint Gaussian samples that preserve the calibrated
   *  multivariate covariance structure. Diagonal entries regularized via
   *  `max(s, 1e-12)` for rank-deficient or near-zero-eigenvalue cells.
   *  Optional for backward-compat with v4-and-earlier configs; absence
   *  treated as "consumer must compute on the fly". */
  cholesky_L?: number[][];
  /** Q2.B.7 (Q2-B-7-ACF-AWARE-PARAMETRIC-SPEC.md) — Lower-triangular
   *  Cholesky factor of the AR(1) white-noise covariance matrix
   *    Σ_C_eps[i,j] = (1 − ρ_i·ρ_j) · Σ_C_blended[i,j]
   *  derived from the Lyapunov equation Σ_x = Φ·Σ_x·Φᵀ + Σ_eps for
   *  diagonal Φ = diag(ρ). Consumed by the AR(1)-aware parametric
   *  resampler (engine/resamplers/ar1.ts jointAR1Sample) so the
   *  generated trajectory has stationary marginal Var(x_i) = Σ_C[i,i]
   *  AND lag-1 autocorrelation matching ρ_i per signal. Pre-Q2.B.7
   *  configs lack this field; the parametric_ar1 mode requires both
   *  cholesky_L_eps AND cholesky_L (the latter for stationary
   *  initialization). */
  cholesky_L_eps?: number[][];
  /** Q2.B.4 (per ARCHITECT-REPLY-52gk §TPM-ask-2 + Q2-B-4 spec) —
   *  Shrinkage intensity α ∈ [0, 1] for per-cell-vs-aggregate Σ blending.
   *  α = 1 means full per-cell Σ (rank-sufficient sample count); α = 0
   *  means full aggregate-Σ shrinkage (insufficient samples); α in (0, 1)
   *  is linear interpolation by sample-count ratio to mcdFloor. */
  shrinkage_alpha?: number;
  /** Q2.B.4 — true if α < 1 (Σ blended with aggregate target).
   *  Audit-visible; supports operators querying "which cells inherited
   *  aggregate covariance regularization?". Distinct from
   *  `covariance_method = 'aggregate_fallback'` which marks the
   *  estimator-dispatch decision; this field marks the post-shrinkage
   *  blend decision. */
  aggregate_fallback_used?: boolean;
  /** Q2.B.4 — max_i |μ_C[i] − μ_A[i]| / |μ_A[i]| over overlapping
   *  Family C / Family A signals. Pre-Q2.B.4 expected 0.05-0.25 range
   *  on aggregate-fallback cells (per REPLY-52gk diagnostic ~15% on
   *  cell 0-0 large-tier); post-Q2.B.4 expected ≤ 1·10⁻¹⁵ (FP-precision
   *  scale modulo floating-point rounding). Compile-time audit asserts
   *  ≤ COHERENCE_HALT_THRESHOLD = 1·10⁻⁹. */
  coherence_residual?: number;
  /** Q2.B.6.2 — Sliding-buffer-aware Hotelling threshold under AR(1) H₀.
   *  Empirical (1−α) quantile of MAX T² (chi_square variant) per
   *  trajectory under joint AR(1) bootstrap with sliding-buffer
   *  evaluation regime. Replaces Wilson-Hilferty χ²_p quantile for the
   *  chi_square variant runtime threshold so per-trajectory FPR matches
   *  α under the runtime sliding-buffer evaluation contract. Optional
   *  for backward-compat with pre-Q2.B.6.2 configs; absence triggers a
   *  fallthrough to chiSquareQuantile(1 − α, p). Stamped post-cholesky_L_eps
   *  by the calibrator. */
  hotelling_sliding_buffer_threshold?: number;

  /** Q70 Phase-3.d.E — self-normalized e-process variant fallback for the
   *  family_C_safe_test detector (per-cell). Activates when conditional
   *  exemption (Q70.1) is too restrictive for the (substrate × sweep_mode)
   *  triple. §7 EmpiricalProcessLILBound primary; §6 BetaBinomial secondary.
   *  ADDITIVE optional (sub-rule 2 MERGE); pre-Q70 configs lack this field;
   *  runtime detector dispatch falls through to standard Ville bound when
   *  absent. SLICE 1: schema only; calibrator stamping + detector
   *  consumption deferred to SLICE 2. */
  self_normalized_fallback?: SelfNormalizedEProcessFallback;
}

/** Addition #20 (ARCHITECT-REPLY-43 D4) — safe-Hotelling e-process
 *  compile-time precompute stored per FamilyCPerCell. Consumed by
 *  `engine/detectors/hotelling.ts` evaluateSafeHotelling() at runtime.
 *
 *  Mixture prior on alternative mean μ ~ N(0, τ²I_p); τ² = δ_min² / 4
 *  matches Page-CUSUM's mixture prior for cross-family semantic
 *  consistency. α is half of Family C's budget (50/50 split with e-MMD
 *  per D5); fire threshold = 1/α = 10,000 on default 2e-4 family budget. */
export interface SafeHotellingParams {
  /** Mixture-prior variance per dimension. REPLY-43b revision:
   *  `tau_squared = shrink_fraction · trace(Σ) / p` (scale-invariant
   *  in baseline covariance magnitude). Original D4 tied τ² to the
   *  per-signal δ_min, which produced τ²/λ ratios of ~200% on
   *  synthetic-v1 — dominating the data likelihood. */
  tau_squared: number;
  /** Per-detector α (= α_C × 0.5 = 1e-4 on default config). Fire at
   *  `M_t ≥ 1/alpha`. */
  alpha: number;
  /** Precomputed ½ · log(det(Σ+τ²I) / det(Σ)). Runtime z_t uses this as
   *  a scalar constant — no log-det math per tick. On healthy
   *  well-conditioned cells expected O(0.15-0.2) at c=0.03 default;
   *  values >> 1 indicate degenerate Σ slipping past REPLY-41's
   *  off-diagonal nondegeneracy gate OR a non-isotropic eigenvalue
   *  spread producing heavy tails in τ²/λ_i. */
  precompiled_log_det_shrink: number;
  /** Addition #20 (REPLY-43b) — shrink fraction `c` used to derive
   *  τ² on this cell (`τ² = c · trace(Σ) / p`). Stored per-cell for
   *  audit reproducibility: fire timings are sensitive to c, so
   *  replay consumers need to know which c produced a given trip. */
  shrink_fraction: number;
  /** Q2.B.6.2 — Sliding-buffer-aware wealth threshold under AR(1) H₀.
   *  Empirical (1−α) quantile of per-trajectory MAX wealth M_t under
   *  the joint AR(1) bootstrap with sliding-buffer evaluation regime;
   *  replaces the analytical 1/α threshold for safe_test variant
   *  runtime evaluation. Optional for backward-compat with pre-Q2.B.6.2
   *  configs; absence triggers fallthrough to 1/alpha. */
  sliding_buffer_threshold?: number;
  /** Q2.B.6.2 — Audit-visible calibration scope. `'single_window'` is
   *  the pre-Q2.B.6.2 single-tick threshold semantic; `'sliding_buffer_ar1'`
   *  is the post-Q2.B.6.2 per-trajectory MAX statistic under joint
   *  AR(1) bootstrap with sliding-buffer evaluation. */
  calibration_scope?: 'single_window' | 'sliding_buffer_ar1';
}

/** Addition #20 (ARCHITECT-REPLY-43 D3) — e-MMD betting-e-process
 *  compile-time precompute stored per FamilyCPerCell. Consumed by
 *  `engine/detectors/sequential-mmd.ts` evaluateEMmd() at runtime.
 *  Option-B DeploySignal simplification: kernel-distance scalar fed
 *  through REPLY-34's betting primitives. */
export interface EMmdParams {
  /** (1/m²)·Σ_{i,j} k(x_i, x_j) over the baseline samples —
   *  precomputed once at compile. Reused from MMDParams.baseline_baseline_sum
   *  for continuity with #18. */
  kernel_baseline_mean_norm_squared: number;
  /** Per-detector α (= α_C × 0.5 = 1e-4 on default config). Fire at
   *  `M_t ≥ 1/alpha`. */
  alpha: number;
  /** Running-moment window length for kernel-distance standardization.
   *  Default 30 ticks (parity with #18's streaming-window size). */
  running_moment_window: number;
}

/** Q67 SPEC Phase-3.d.B (NEW) — Shekhar-Ramdas-2023 canonical betting-
 *  e-process parameters for Sequential MMD Ville-bounded variant. Per-
 *  cell hyperparameters derived from baseline calibration state per Q67.1
 *  derivation table; canonical-aligned with reference impl
 *  `github.com/sshekhar17/nonparametric-testing-by-betting`
 *  (`kernelMMD.py` + `SeqTestsUtils.py` ONSstrategy). ADDITIVE optional;
 *  pre-Phase-3.d.B configs handle gracefully (default mmd_variant flips
 *  to 'betting_e_process' at Phase-3.d.B SLICE 1; classical retained
 *  with deprecation warning per Q67.5).
 *
 *  Distinct from existing #20 EMmdParams — EMmdParams parameterizes the
 *  Option-B simplification (kernel-distance scalar via baseline pool +
 *  GRAPA/ONS-fallback betting). Q67 v2 `FamilyCBettingEProcessParams`
 *  parameterizes the canonical Shekhar-Ramdas-2023 ONS variant: kernel-
 *  MMD witness via split-sample baseline + canonical ONS update +
 *  two-sided bet range. Both structs may coexist on a cell during
 *  Phase-3.d.B → .C transition; runtime dispatcher picks per
 *  `mmd_variant` flag. */
export interface FamilyCBettingEProcessParams {
  /** Gaussian RBF kernel bandwidth via median heuristic on baseline cell
   *  rows. Computed once at compile time per cell; runtime detector reads
   *  pre-derived value. Q67 § Q67.1 derivation. */
  kernel_bandwidth_sigma: number;
  /** ONS bet clamp; canonical default 0.5 per Shekhar-Ramdas-2023
   *  reference impl `SeqTestsUtils.py:11 ONSstrategy(F, lambda_max=0.5)`.
   *  Bet range is [-lambda_max, +lambda_max] (TWO-SIDED per Q67 v2 §
   *  Q67.4-bis amendment). */
  lambda_max: number;
  /** Betting strategy variant. SLICE 1 ships 'ons' (canonical Online
   *  Newton Step). 'grapa' (Krichevsky-Trofimov mixture) tagged for
   *  Phase-3.d.B.b sub-track if SLICE 1 acceptance fails empirically.
   *  'plug_in' is theoretical reference only; rejected for production. */
  betting_strategy: 'ons' | 'grapa' | 'plug_in';
  /** ONS initial bet (canonical default 0). Optional; absent → 0. */
  ons_initial_lambda?: number;
  /** Per-detector α (= α_C × 0.5 = 1e-4 on default config). Fire at
   *  `S_t ≥ 1/alpha` (Ville bound). Inherited from existing EMmdParams.alpha
   *  semantic; preserved here for explicit per-variant α-tracking. */
  alpha: number;
  /** Sample size N_baseline for split-sample MMD witness construction.
   *  Subset selection from per-cell baseline rows at compile time;
   *  fixed-sample reference for streaming-adapted predictable witness
   *  per Q67 § Q67.4-ter "Witness paired-samples vs streaming adaptation". */
  baseline_sample_size: number;

  /** Q72 SLICE 2 (Phase 3.A) — Random Fourier Features seed integer.
   *  Used by both calibrator and runtime to deterministically generate
   *  the RFF feature map (ω matrix + b vector) without persisting the
   *  full matrices. Mulberry32 + Box-Muller produce byte-identical
   *  output across Darwin and Linux for fixed seed. ADDITIVE optional
   *  field per sub-rule 2 MERGE; pre-Q72-SLICE-2 configs lack this
   *  field and runtime falls through to the legacy biased streaming
   *  witness (Q67 § Q67.4-ter) — backward-compat for replay of
   *  pre-fix configs. */
  rff_seed?: number;
  /** Q72 SLICE 2 — RFF feature dimension D. Architect Phase-3.A pick:
   *  D = 256 default (per `engine/detectors/family-c-rff.ts`
   *  RFF_DEFAULT_DIM). Halt-criterion (b) escalation to D = 512 / 1024
   *  if FPR convergence at D = 256 insufficient empirically. */
  rff_dim?: number;
  /** Q72 SLICE 2 — precomputed μ_P^φ = (1/N_P) Σ_i φ(X_{P,i}) over the
   *  baseline pool (size N_P = baseline_sample_size). Length = rff_dim.
   *  Computed once at calibration time so runtime detector skips
   *  re-evaluating the P-side at every tick (otherwise per-tick cost
   *  would be O(N_P · D · d) instead of O(D · d)).
   *
   *  When this field is present, the runtime detector uses the unbiased
   *  RFF witness:
   *    F_t = φ(x_t) · (μ_P^φ - μ_Q^φ)
   *  where μ_Q^φ = (1/m_t) Σ_j φ(X_{Q,j}) is the running RFF empirical
   *  mean of past Q-side observations (predictability preserved by
   *  computing F_t BEFORE updating μ_Q^φ with x_t).
   *
   *  When this field is ABSENT, the runtime falls back to the legacy
   *  biased kernel-of-empirical-mean witness (preserves replay of
   *  pre-Q72-SLICE-2 audit logs). */
  baseline_rff_mean?: number[];
}

/** Q67 SPEC Phase-3.d.B (NEW) — per-(deploy, cell) state for the
 *  canonical Shekhar-Ramdas-2023 ONS betting-e-process variant.
 *  Persisted across ticks within window; reset at window boundary
 *  (mirrors Q66 Phase-3.d.A SLICE 1 state-management pattern). */
export interface FamilyCBettingEProcessState {
  /** Wealth process S_t (multiplicative). Stored in log-space as
   *  log_S_t for numerical stability; S_t materialized on read. */
  log_S_t: number;
  /** ONS bet λ_t — predictable; updated each tick from past wealth
   *  gradient + Hessian. Initialized at ons_initial_lambda (canonical 0). */
  ons_lambda: number;
  /** ONS accumulated Hessian A_t — initialized at A_0 = 1 per canonical
   *  reference impl (implicit regularization; no separate ε term). */
  ons_inverse_hessian: number;
  /** Tick count for predictability bookkeeping. */
  n: number;
  /** Running-max of past witness payoffs (denominator for normalization
   *  at i > 10 per canonical `kernelMMDprediction` lines 57-92). */
  witness_running_max: number;
  /** Running sum of past observations for streaming Q_{t-1} construction
   *  (per-coordinate; 11-dim Family C joint vector). Used to compute
   *  predictable witness W_{t-1}(x_t) without including current observation.
   *  LEGACY (Q67 §Q67.4-ter biased streaming witness) — populated when
   *  `betting_e_process_params.baseline_rff_mean` is absent. */
  q_running_sum: number[];
  /** Q72 SLICE 2 (Phase 3.A) — Running RFF empirical-mean numerator
   *  for streaming Q_{t-1} construction in RFF feature space. Length =
   *  rff_dim (D). μ_Q^φ = q_running_phi_sum / q_count. Populated when
   *  `betting_e_process_params.baseline_rff_mean` is present (runtime
   *  RFF path active). ADDITIVE optional per sub-rule 2 MERGE; pre-
   *  Q72-SLICE-2 state objects lack this field and detector falls
   *  through to legacy q_running_sum path. */
  q_running_phi_sum?: number[];
  /** Count of past observations (length of Q-side empirical distribution). */
  q_count: number;
  /** Has detector fired at least once in current window? */
  fired: boolean;
  /** Tick at first fire (null if not fired). */
  tick_at_first_fire: number | null;
  /** α consumed at fire(s); audit symmetry with EMmdState.alphaConsumed. */
  alphaConsumed: number;
}

/** Addition #20 — per-(deploy, cell) safe-Hotelling e-process state.
 *  Persisted across ticks; `M` is the wealth process (multiplicative),
 *  `alphaConsumed` tracks α spend across fires. */
export interface SafeHotellingState {
  M: number;
  n: number;
  alphaConsumed: number;
}

/** Addition #20 — per-(deploy, cell) e-MMD betting-e-process state.
 *  Parallel to BettingEProcessState (Family A, REPLY-34) but global
 *  per-cell rather than per-signal; `runningMean` and `runningSecondMoment`
 *  standardize the kernel-distance scalar over `running_moment_window`
 *  ticks before the betting update. */
export interface EMmdState {
  M: number;
  bet: number;
  n: number;
  runningMean: number;
  runningSecondMoment: number;
  alphaConsumed: number;
}

/** Addition #18 D3 — outlier-detection provenance on MCD/MRCD cells.
 *  Populated by the compiler's robust-covariance step; carried on the
 *  compiled config so audit replay can show which samples the estimator
 *  trimmed. Field is null when the covariance estimator didn't trim any
 *  samples (`'ledoit_wolf'` path). */
export interface OutlierDetection {
  /** Which robust estimator identified the outlier support. Null when
   *  `covariance_method === 'ledoit_wolf'`. */
  method: 'mcd' | 'mrcd' | null;
  /** Samples in the baseline before outlier-trim (equals `n_samples` on
   *  the enclosing BaselineCellEntry). */
  raw_baseline_n: number;
  /** Samples kept after trim; matches `h_support` on successful MCD runs. */
  trimmed_baseline_n: number;
  /** Fraction trimmed = `(raw - trimmed) / raw`. Architect rule: capped at
   *  0.5 per the method's breakdown point; compiler asserts this. */
  outlier_fraction: number;
  /** FastMCD "h" — size of the core subset that minimizes |Σ|. Controlled
   *  by `CompilerOptions.mcd_alpha` (default α=0.75 → h = ⌈α·n⌉). */
  h_support: number;
  /** Mahalanobis cutoff used for the reweighting step — typically
   *  √χ²(0.975, p). Robust-consistent under multivariate normality. */
  mahalanobis_cutoff: number;
}

/** Addition #18 D7 — Sequential MMD compile-time precompute stored per
 *  FamilyCPerCell. Consumed by `engine/detectors/sequential-mmd.ts` at
 *  runtime. See Li/Chen 2019 "Sequential MMD with streaming data". */
export interface MMDParams {
  /** Only kernel supported in this ship. Gaussian RBF with
   *  median-heuristic bandwidth; no operator tunable per D5. */
  kernel: 'gaussian_rbf';
  /** Median-heuristic bandwidth: `σ = median(||x_i − x_j||)` over all
   *  pairs of baseline samples. Controls the RBF kernel's scale so the
   *  statistic is invariant to global rescaling of the baseline. */
  bandwidth: number;
  /** Streaming-window size `b` (ticks of live observations compared
   *  against the baseline). D6 architect-set default = 30. */
  window_size: number;
  /** Third term of the U-statistic — baseline × baseline kernel sums,
   *  independent of the live window. Precomputed once at compile time
   *  so the per-tick cost is O(b·p) rather than O(bm). */
  baseline_baseline_sum: number;
  /** (1 − α) quantile of `U_t` under H₀, computed via bootstrap. Fire
   *  when observed `U_t > null_quantile`. */
  null_quantile: number;
  /** Number of bootstrap resamples used to derive `null_quantile`. D7
   *  default = 2000. */
  null_quantile_bootstraps: number;
  /** α allocated to Sequential MMD within Family C — D8 rule: half of
   *  `alpha_budget.per_family.C`. Hotelling T² receives the other half. */
  alpha: number;
}
