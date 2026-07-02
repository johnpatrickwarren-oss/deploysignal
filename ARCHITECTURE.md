# Architecture

## The pipeline

```
raw metrics ──┐
              ├─► TrendBuffer ──► SignalSnapshot ──► G0 blast ──► G1 policy ──► G2 approval ──► G3 state ──► G4 health ──► Verdict
baseline   ──┘                                        │            │             │               │
flags      ──┘                                        └──────── short-circuit on structural fire ┘
```

Every tick, the orchestrator receives `{live, baseline, flags}`, feeds live metrics into the TrendBuffer, extracts a snapshot, and routes through the gates in order. Any gate can short-circuit the pipeline with a rollback or extend verdict.

## TrendBuffer (`engine/core.ts`)

A bounded rolling window per signal. On `get()` it returns:

- `n` — sample count
- `mean`, `min`, `max`, `range`
- `slope` — linear regression slope
- `slopeNorm` — slope normalized by baseline
- `cv` — coefficient of variation
- `trendStrength` — how monotonic the trend is (0 = pure noise, 1 = monotonic)

The design insight: `cv` is not a noise indicator on trending data. A metric drifting smoothly upward has high `cv` but is not noisy — it's moving. `trendStrength` separates real movement from jitter. Detectors that tried to use `cv` as a noise filter produced false negatives; `trendStrength` is what survived.

## G0 — Blast radius (`engine/gates/blast_radius.ts`)

Classifies deployment risk level from change metadata (risk level, change type, author, file paths). Adjusts the effective risk tier that downstream gates see. Does not short-circuit.

## G1 — Policy gate (`engine/gates/policy.ts`)

Checks time windows, change types, and risk-level rules. Can short-circuit to `rollback`. Produces a `policyContext` consumed by G4 (health) — contains thresholds, warmup state, downstream corroboration rules.

## G2 — Approval gate (`engine/gates/approval.ts`)

Validates flags and author context. Can short-circuit to `extend`.

## G3 — State gate (`engine/gates/state.ts`)

Checks deploy state (deploy ID, target cloud). Can short-circuit to `extend`.

## G4 — Health gate (`engine/gates/health.ts`)

The bulk of the detection logic. Each detector consumes a trend snapshot and returns a tripped/not-tripped verdict with a reason. Detectors are independent — the first to fire wins.

### Current detectors

The eight detectors documented here are the architecturally distinctive ones — they encode the patterns specific to AI inference workloads. The engine runs 24 rollback detectors and 9 extend detectors in total; the remaining 16 rollback detectors and all 9 extend detectors are threshold checks on individual signals or flags. Full list: see `engine/gates/health.ts` and `engine/signals/quality.ts`.

**`slowbleed`** — four or more metrics drifting simultaneously at low magnitude.
_Catches:_ correlated sub-threshold drift across the signal set. The individual metric movements are each too small to trip their own detector, but the joint pattern is distinctive. Triggers when slopeNorm is in the 0.001–0.010 range with trendStrength > 0 and ratio > 2% off baseline, across 4+ of 9 tracked signals.

**`mfu_collapse`** — >=20% sustained MFU drop with trendStrength >= 0.3 and n >= 6.
_Catches:_ GPU utilization collapse. Triggers before latency responds, giving an early signal.

**`kv_saturation`** — KV cache ratio >= 1.04 AND cv < 0.005 AND |slopeNorm| < 0.002.
_Catches:_ cache at capacity ceiling. The signature is a pinned-flat ratio — the cache can't grow further, but the engine is still trying.

**`hbm_elevation`** — HBM spill ratio >= 1.08 with slopeNorm >= 0.002, trendStrength > 0, and n >= 8.
_Catches:_ early high-bandwidth memory pressure before full saturation.

**`hbm_spill_roll`** — standalone sustained HBM rise (slopeNorm >= 0.006, ratio >= 1.28, trendStrength >= 0.3, n >= 8).
_Catches:_ HBM pressure trending upward without other signals moving yet.

**`collective`** — absolute-drop override (>= 7% relative drop with HBM slopeNorm >= 0.005), plus a slope-gated path requiring slopeNorm >= 0.015 or trendStrength >= 0.5 with HBM corroboration.
_Catches:_ collective operation degradation events.

**`capacity`** — requires n >= 6, stable HBM with slopeNorm >= 0.005, and >= 2 of {HBM ratio >= 1.30, KV ratio <= 0.90, latency slopeNorm >= 0.008}.
_Catches:_ multi-signal capacity constraint patterns.

**`gpu_eff`** — model_weights only, after 12h warmup. MFU drop >= ~12% with latency or HBM corroboration.
_Catches:_ GPU efficiency regressions specific to model weight changes.

Also: `p99`, `ttft`, `compound_lat`, `tok_econ`, `tokens`, `cost`, `downstream`, `behavioral`, plus flag-based signals (`security`, `artifact`, `provenance`, `contract`) and quality signals from `engine/signals/quality.ts`.

### Worked example: slowbleed

A deployment looks fine on every individual metric. p99 is up 1.8%. TTFT is up 2.1%. `tokens_turn` is down 1.6%. `eval_score` is down 0.9%. None of these crosses its own detector threshold. Traditional monitoring sees green across the board.

`slowbleed` counts metrics with `slopeNorm` in the 0.001–0.010 range and `trendStrength > 0`. Four qualify. The detector fires with `reason: "4 metrics drifting (p99, ttft, tokens_turn, eval_score)"`. Health returns rollback signals, and `computeVerdict` produces `rollback`.

This is the single most distinctive DeploySignal detector — nothing else in standard SRE tooling catches this signature, which is why it covers a large class of adversarial scenarios.

## Verdict shape

```
{
  verdict: "proceed" | "extend" | "rollback",
  reason: "<detector id>: <human-readable>",
  tripped: [{ id, label, gate }],
  short_circuit: <gate name or null>,
  trend_snapshot: { <signal>: { n, slopeNorm, cv, trendStrength } }
}
```

The orchestrator has four verdict return points (policy short-circuit, approval short-circuit, state short-circuit, health evaluation); PLAN.md Phase 1 wraps them through a single `_emit()` helper so audit logging is uniform.

## The tuning harness (`loop.js`)

> **Note:** the tuning harness itself (`loop.js`, `run_loop.sh`) is **not
> included** in this public repository — this repo is a curated reference
> subset, and there is no `npm run loop` here. This section documents how
> the shipped detector code was produced.

DeploySignal's detectors were not hand-tuned. They were evolved by a loop that pairs **Opus** (plans what to change and why) with **Sonnet** (writes the code patches), validated each iteration against the adversarial suite.

The loop has a **two-layer guardrail**:

1. **Prompt layer** — rules embedded in `buildPatchPrompt` (ordered branches, no dead conditions, structural over numeric, no threshold chasing, guard preservation).
2. **Runtime enforcement** — `applyPatches` auto-strips common failure patterns (tautology detection, guard removal, non-boolean returns).

The second layer exists because without it, after ~10 iterations Sonnet accumulates dead branches and impossible conditions that pass detection but degrade code quality.

`ADV_TP_THRESHOLD = 0.975` is a floor the loop defends, not a target it chases. When the loop hits the floor on a clean sweep, convergence is declared.

## Scenario pool

120 adversarial scenarios in `runs/adversarial-scenarios.json`, each a time series of metric values designed to exercise a specific failure mode. Scenarios are grouped into families:

- Baseline: `adv_slowbleed_*`, `adv_mfu_collapse_*`, etc. (105 original)
- Context-length family: KV cache + attention cost scenarios (5)
- Batch-saturation family: throughput ceiling + request queuing (5)
- Quantization-drift family: precision-induced quality regression (5)

Each new family is a tuning cycle. Never more than one family per cycle — multi-family tuning produces signals that over-fit.

## Known limits (architectural, not tuning)

Three scenario patterns are not catchable with the current detector architecture:

1. **`adv_collective_ops_flap`** — collective operation duty-cycle flapping averaged below tick resolution. Requires sub-tick sampling.
2. **`adv_oscillating_cache_signal`** — downstream error oscillation with amplitude below the FP-safe threshold floor. Requires FFT or oscillation-aware detection.
3. **`adv_correlated_noise`** — all metrics within 0.2% movement, joint pattern detectable only via covariance. Requires a covariance-aware signal (planned).

These are documented structural gaps. The covariance signal in the next-cycle queue targets #3 and possibly #2.

## Runs and artifacts

> **Note:** these are artifacts of the (not-included) tuning harness; per-run
> outputs and `analyze_iterations.py` are not part of this public subset.
> The curated inputs that *are* shipped live under `runs/` (e.g.
> `runs/adversarial-scenarios.json`, `runs/compiled-configs/`).

Per-run outputs land in `runs/<run-id>/`. Each contains:

- `iterations/` — tuning loop iteration snapshots (if run was a tuning cycle)
- `scenario_results.json` — per-scenario verdict + trip reason
- `summary.txt` — human-readable TP/FP summary

`analyze_iterations.py` post-processes tuning runs to produce convergence plots and iteration-level diagnostics.

## Invariants (do not break)

- `ADV_TP_THRESHOLD` is a floor. Never bump it without a full sweep confirming the new rate is exact.
- G4 detectors are independent. Do not add inter-detector dependencies without explicit review.
- `TrendBuffer.get()` contract (the returned shape) is the public type surface for the engine. Any change ripples through every detector.
- `orchestrator.js` must pass through every verdict via `_emit()` once Phase 1 lands. No ad-hoc `return` statements bypassing audit.
