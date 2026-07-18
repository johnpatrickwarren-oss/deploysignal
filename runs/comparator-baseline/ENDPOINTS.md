# Comparator-Baseline Evaluation — Pre-Registration (ENDPOINTS.md)

Status: **frozen before harness code**. This document is committed in the
same PR as `.gitignore` changes and *before* any `tools/_comparator-baseline-*`
or `tools/run-comparator-baseline.ts` code exists (WS6.2 Task 1). Every
subsequent task in the implementation plan builds against the frozen JSON
block at the bottom of this file; the harness parses that block at runtime
and hard-fails if CLI arguments disagree with it.

## Purpose

External review of the portfolio detector's evaluation asked for a
comparator baseline: how does the portfolio's escaped-regression /
false-rollback / detection-delay profile compare against a **well-tuned**
single-signal threshold gate and a **well-tuned** canary-vs-control
statistical judge — the two families of gate most deployment-health tooling
actually ships (metric-threshold checks à la Flagger/Argo Rollouts, and
canary-vs-control hypothesis tests à la Spinnaker/Kayenta)? A comparison
against an untuned or strawman baseline is not informative; this harness
pre-registers the tuning procedure, the evaluation splits, and the exact
metrics *before* any comparator code is written, so that the tuning
procedure cannot be adjusted after seeing evaluation-split results. This
harness supersedes any prior, non-pre-registered comparator work; no result
from any such prior attempt was consulted in writing this document or the
code that follows it.

**No metrics beyond those listed here may be added to the report emitted in
this PR.**

## Arms

All arms consume the identical, generate-once trajectory for a given
window (see Fairness notes below for the one deliberate asymmetry).

| Arm id | Definition |
|---|---|
| `portfolio_alpha` | Existing engine via `runGateOverTrajectory`; fire = any A/C/D/E α-spending detector (same classification as `runFprSweep`/`runProfileSweep`). |
| `portfolio_combined` | Same run; fire = any family A–E including structural B (matches `combined_detected`). |
| `threshold_tuned` | Static per-signal gates: fire when the signal is beyond `k_s · σ_s` from cell μ (in the pre-registered degradation direction) for `m` consecutive ticks. μ_s, σ_s come from the same compiled-config cell the portfolio consults (`family_A.per_signal.<s>.baseline_mean`, `sqrt(baseline_sigma_squared)`; fallback `aggregate_fallback` cell — same fallback path as the engine). Mimics Flagger/Argo-Rollouts metric threshold checks. Parameters `(k_s per signal, m global)` tuned on the held-out tuning split. |
| `canary_tuned` | Canary-vs-control comparison, Kayenta-style: at each look in a fixed schedule, run a Mann-Whitney U test per signal on the trailing `W` ticks of the canary stream vs the same-index ticks of a paired control stream (a second healthy window from the same cell, deterministic disjoint seed, never injected); Bonferroni-correct across (signals × looks); fire on any directional rejection. Parameters `(α_c, W)` tuned on the held-out tuning split. Documented as mimicking the Spinnaker/Kayenta canary judge (Mann-Whitney per metric) with a fixed-look progressive-delivery schedule. |
| `combined_tuned` | OR of `threshold_tuned` and `canary_tuned`, with the FP budget checked **jointly** on the tuning split (this is the reviewers' "well-tuned combination"). |
| `combined_default` (secondary) | Untuned textbook defaults for bracketing: `k=3, m=3` all signals; Mann-Whitney at `α=0.05` Bonferroni over signals × looks, `W=20`. |

## Industry-mimicry citations

- **Flagger** (Weaveworks/Flux CD progressive-delivery operator) and **Argo
  Rollouts** (Argo Project) both implement canary analysis primarily as
  static per-metric threshold checks (metric beyond a configured bound for
  N consecutive analysis runs triggers rollback). `threshold_tuned` mirrors
  this class of gate.
- **Spinnaker Kayenta** implements canary judging as a per-metric
  statistical comparison between a canary and a control/baseline
  deployment (Mann-Whitney U is one of Kayenta's supported per-metric
  judges) evaluated on a fixed schedule of "canary stages"/looks.
  `canary_tuned` mirrors this class of gate.

These are cited only as descriptions of a general, publicly documented
class of tooling behavior (static-threshold checks; canary-vs-control
hypothesis tests on a fixed look schedule) — no code, threshold value, or
prose from any other study or repository was consulted or copied in
implementing these arms.

## Splits

All splits are deterministic via `mulberry32`.

- **Tuning split (healthy only):** 262 windows, seed stream
  `mulberry32(20260716)`, same generator/cell-sampling loop as the FPR
  sweep. Used exclusively to choose comparator parameters. Selection rule:
  most sensitive parameters subject to ≤ 0 false fires on the tuning split
  (per arm, then jointly for `combined_tuned`; escalation rule
  pre-registered — see Tuning grids below).
- **Eval healthy split:** exactly the canonical 131 windows — replicates
  `runFprSweep`'s loop byte-for-byte (same `mulberry32(42)` consumption
  order: cell pick then window draw per iteration) so the portfolio's
  false-rollback count is reproducible against the existing report card.
- **Eval injected split:** 5 profiles × R=20 repeats = 100 windows, seed
  `42 + 1000 + profileIndex*100 + repeat`, anchor-cell selection rule
  identical to `runProfileSweep` (hour=12/day=3 preferred), injection at
  tick 30 of 100 via `injectRegression`. The existing report card runs 1
  trial/profile; repeats are needed for median/p95 delay to be meaningful,
  and the portfolio is re-measured under the identical repeats in the same
  run.
- **No-leakage invariant:** tuning-seed stream ∩ eval-seed streams = ∅ by
  construction; enforced by a test on recorded window provenance.

## Endpoint definitions (primary; frozen)

Per arm:

- **`escaped_regressions`** — count and rate over the 100 injected
  windows: an injected window is an "escape" if the arm produces no fire at
  any tick `t ∈ [30, 100)` (i.e. no fire from injection tick through the
  end of the window).
- **`false_rollbacks`** — count and rate over the 131 healthy eval windows:
  a healthy window is a "false rollback" if the arm fires at any tick.
- **`detection_delay_ticks_median`** and **`detection_delay_ticks_p95`** —
  computed over detected (non-escaped) injected windows only, as
  `first_post_injection_fire_tick − 30`.
- **`per_profile`** breakdown of all three metrics above (secondary, but
  pre-registered and required in every report).

Secondary (also pre-registered, clearly labeled as secondary in the
emitted report): tuned parameter values, per-signal firing attribution,
the `combined_default` row, and optional v8/v9 real-trace healthy-FP-only
rows (gated on Open Question 4 below).

## Tuning grids (frozen)

- **Threshold arm:** `k ∈ {2, 2.5, 3, 3.5, 4, 5, 6, 8}` per signal,
  `m ∈ {1, 2, 3, 5, 8}` global. Rule: for each `m` (ascending), set
  `k_s = min{k : signal s fires on 0/262 tuning windows}`; pick the
  smallest `m` whose combined per-signal gates produce 0/262 false fires
  jointly; ties broken by smaller `m`.
- **Canary arm:** `α_c ∈ {0.05, 0.01, 0.005, 0.001}` (pre-Bonferroni),
  `W ∈ {10, 20}`; look schedule fixed
  `{20, 30, 40, 50, 60, 70, 80, 90, 99}`. Rule: largest `α_c` (most
  sensitive), then largest `W`, with 0/262 tuning false fires.
- **Combined arm:** if the OR of the two tuned arms exceeds 0/262 false
  fires on the tuning split, tighten in pre-registered order: decrease
  `α_c` one grid step, then increase `m` one step, repeat until 0/262.
- **FP budget for tuning:** 0 false fires on the 262 tuning windows
  (maximum sensitivity subject to zero observed false fires). This is
  Open Question 2's adopted default.

## Degradation-direction table (frozen; domain knowledge, not fit to data)

- **up-bad** (fires when the signal rises): `p99_latency`, `ttft`,
  `cost_req`, `downstream_err`, `refusal_rate`, `kv_cache`, `hbm_spill`,
  `corpus_delta`
- **down-bad** (fires when the signal falls): `eval_score`,
  `tool_success_rate`, `mfu`
- **two-sided** (fires on deviation in either direction):
  `tokens_turn`, `output_len_p50`, `traffic_pct`, `collective_ops`

The two-sided assignment for `tokens_turn`, `output_len_p50`,
`traffic_pct`, `collective_ops` is Open Question 1's adopted default —
these signals do not have an unambiguous single degradation direction, so
both directions are treated as potentially indicative.

## Fairness / parity notes

- Comparator thresholds are built from the exact per-cell baseline
  statistics the portfolio's compiled config carries (`family_A.per_signal`
  mean/σ, with the same `aggregate_fallback` fallback path the engine
  uses) — this is **information parity**: the comparator sees the same
  calibration data the portfolio does, nothing less.
- The canary arm additionally receives a paired control stream that the
  portfolio does not get. This is an asymmetry *in the comparator's
  favor* — the conservative direction for this study, since it can only
  make the comparator look better than a canary judge deployed without a
  true control, not worse.
- Tuning uses healthy data only (no regression-profile peeking), mirroring
  how such gates are tuned in production (alert-budget tuning against
  historical healthy traffic, not incident-fitting against known
  regressions).

## Portfolio fire-event definition (Open Question 5, adopted default)

Portfolio arms use detector-level classification identical to the existing
sweeps (`portfolio_alpha` = A/C/D/E α-spending detectors;
`portfolio_combined` adds structural family B), **not** `verdict ===
'rollback'`, so the numbers stay reconcilable with existing report-card
output.

## Scoped-out variations (Open Question 6, adopted default)

The Kayenta "score-aggregation" variant (a fraction-of-metrics-failing
score, rather than any-metric-fires) is **not implemented** in this PR.
`canary_tuned` and `combined_default` use Bonferroni-corrected any-metric
fire only. This is noted here as a scoped-out variation for a possible
follow-up, not a silent omission.

## Real-trace surfaces (Open Question 4, adopted default)

v8/v9 real-trace healthy-FP rows are included as clearly-labeled secondary
rows only if the corresponding baseline bundle carries per-tick
`hour_of_day`/`day_of_week` metadata (checked via `listPopulatedCells`
returning a non-empty result for that bundle); otherwise they are deferred
to a follow-up PR rather than bending the window-generation machinery in
this one.

## Repeats per profile (Open Question 3, adopted default)

`repeats_per_profile = 20` (100 injected windows total; comparable runtime
order to the existing 131-window healthy sweep). If measured runtime
exceeds roughly 10 minutes, the fallback is to drop to 10 repeats and
update this document **before** Task 2 begins — pre-registration still
holds because the change would happen before any comparator statistics
are computed, not after seeing results.

## Mechanical endpoint-freeze enforcement

The JSON block below is the single source of truth for frozen parameters.
The harness (`tools/run-comparator-baseline.ts`, Task 7) loads this block,
refuses to run if CLI args disagree with `frozen_params` (unless
`--allow-nonregistered-params` is passed, which stamps
`"non_registered_run": true` into the report for smoke/test runs only),
and stamps `endpoints_version` plus a SHA-256 hash of this JSON block into
every emitted report. A test asserts the emitted report's metric keys
equal exactly `primary_metrics` (plus declared secondary metrics), so that
a post-hoc endpoint addition fails CI in the same PR that adds it.

```json
{
  "endpoints_version": "v1",
  "primary_metrics": [
    "escaped_regressions",
    "false_rollbacks",
    "detection_delay_ticks_median",
    "detection_delay_ticks_p95"
  ],
  "secondary_metrics": [
    "per_profile",
    "tuned_parameter_values",
    "per_signal_firing_attribution",
    "combined_default",
    "real_trace_healthy_fp"
  ],
  "arms": [
    "portfolio_alpha",
    "portfolio_combined",
    "threshold_tuned",
    "canary_tuned",
    "combined_tuned",
    "combined_default"
  ],
  "frozen_params": {
    "eval_seed": 42,
    "tuning_seed": 20260716,
    "healthy_windows": 131,
    "tuning_windows": 262,
    "canary_ticks": 100,
    "injection_tick": 30,
    "repeats_per_profile": 20,
    "bake_hours": 6,
    "resampler": "iid_bootstrap",
    "look_schedule": [20, 30, 40, 50, 60, 70, 80, 90, 99],
    "grids": {
      "threshold": {
        "k": [2, 2.5, 3, 3.5, 4, 5, 6, 8],
        "m": [1, 2, 3, 5, 8],
        "selection_rule": "for each m ascending, set k_s = min{k : signal s fires on 0/262 tuning windows}; pick the smallest m whose combined per-signal gates produce 0/262 false fires jointly; ties broken by smaller m"
      },
      "canary": {
        "alpha_c": [0.05, 0.01, 0.005, 0.001],
        "W": [10, 20],
        "selection_rule": "largest alpha_c (most sensitive), then largest W, with 0/262 tuning false fires"
      },
      "combined": {
        "escalation_rule": "if OR of threshold_tuned and canary_tuned exceeds 0/262 false fires on the tuning split, tighten in order: decrease alpha_c one grid step, then increase m one step, repeat until 0/262"
      },
      "tuning_fp_budget": 0
    },
    "direction_table": {
      "up_bad": ["p99_latency", "ttft", "cost_req", "downstream_err", "refusal_rate", "kv_cache", "hbm_spill", "corpus_delta"],
      "down_bad": ["eval_score", "tool_success_rate", "mfu"],
      "two_sided": ["tokens_turn", "output_len_p50", "traffic_pct", "collective_ops"]
    }
  }
}
```
