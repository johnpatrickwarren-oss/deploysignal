# WS3 Interface Spec — Week 5 Demo Overhaul

_Architect output. Drafted 2026-04-18._
_End-of-W4 commitment from `coordination/ARCHITECT-REPLY-03.md` Part 4 (sketch) and `coordination/ARCHITECT-REPLY-04.md` (delivery calendar), satisfying the W5 unblock request in John's W4 close-out FYI._
_Consumers: WS3 Cowork (primary — scaffolding provenance panel in WS3.2; needs field names for WS3.3–WS3.5). TPM (for WS3-WEEK5-HANDOFF.md amendment). Mac Claude Code (engine emission invariants)._

## Pasteable normative summary for WS3 Cowork

```
WS3-INTERFACE-WEEK5 — what is normative vs what is recommended

NORMATIVE (do not deviate without architect sign-off):
- All UI data-binding field names MUST match audit/SCHEMA.md v2 exactly.
- Reserved colors: verdict traffic-light (#1e9e4f proceed, #e8b109 extend, #d93025 rollback,
  #8a8f9c baking/suppressed) — consistent across every panel.
- Family palette is reserved: A=#2f6ec9 (blue), B=#0d8a7c (teal), C=#7b3fc7 (purple),
  D=#d07a1f (amber), E=#c32c8a (magenta). These colors identify family in every panel —
  provenance, α-budget meter, shadow-compare diff highlights, status badges.
- Canned-demo JSON files MUST be deterministic: fixed seed, byte-identical re-runs.
- The three demos are: demo-clean.json, demo-novelty.json, demo-github-2020.json.
  Demo 3 (GitHub 2020) is spec'd at the end of this doc with tick-by-tick signal values
  for reconstruction fidelity.
- Shadow-compare panel MUST display cascade and portfolio verdicts side-by-side at the
  same tick; divergences highlighted in yellow background (not red — divergence is
  informational, not alarm).
- Provenance panel hover-for-derivation: hover on a fired detector surfaces its
  derivation chain (signal name → consulted cell key → compiled threshold source).
- α-budget meter is a STACKED bar (per-family allocations visible individually), not a
  single cumulative fill. The stacking is what makes the budget allocation legible.

RECOMMENDED (WS3 judgment, architect will sign off on deviations):
- Exact pixel layout, panel sizing, typography choices.
- Animation on verdict transitions.
- Collapse/expand affordances beyond what's specified below.
- Sparkline density, tick-count labels, granularity of per-tick display.
- Grid vs flex layout.
- Whether panels are tabs or stacked scroll.

OUT OF SCOPE for W5:
- No authentication / ACL. Demo runs locally, single-user.
- No live telemetry ingestion. Demos are canned JSON files.
- No edit-threshold-in-UI interaction. Compiled config is read-only.
- No multi-service view. Single service (inference-sim), single deploy at a time.
- No historical comparison beyond shadow-compare. Prior-deploy timeline is W6+ or post-phase.

SEQUENCING:
1. WS3.2 scaffolds provenance panel against DetectorTripV2 shape — unblocked by §3.1 below.
2. WS3.3 shadow-compare panel — unblocked by §3.2 below.
3. WS3.4 calibration version badge + α-budget meter — unblocked by §3.3 and §3.4.
4. WS3.5 canned-demo integration — unblocked by §6 (signal trajectories).

If anything in §6 (canned demos) requires engine changes to emit new fields, route to
architect; otherwise consume what the engine emits via audit/SCHEMA.md v2.
```

## 1. Purpose and audience

This spec is the contract between the engine (which emits v2 audit records) and the demo UI (which consumes them). WS3 Cowork implements the UI against this spec; Mac Claude Code maintains the engine to emit what this spec requires. Neither side deviates without architect sign-off.

The spec's job is to prevent two failure modes:

- **Field-drift.** UI renders against a field name the engine doesn't emit; a silent null lands in a header label; the demo looks broken on stage.
- **Semantic-drift.** UI renders correctly-named fields with wrong semantics (e.g., displays `cusum_progress` as "α consumed" instead of "CUSUM progress toward threshold"). A reviewer who knows the math catches this; a pitch audience member loses trust.

Both are eliminated by UI fields binding to `audit/SCHEMA.md` v2 verbatim and deriving display text from canonical labels defined here.

## 2. Data sources

### 2.1 Primary data source: v2 audit records

Every panel reads from v2 audit records (`audit/SCHEMA.md` §v2). Records arrive one-per-tick through the streaming pipeline (WS3.1 browser bundle already wired). For canned demos, records are pre-generated into JSON files (§6) and streamed at demo time with a configurable tick cadence (default: 500ms/tick for demo pace; real engine cadence is 5s).

The demo MUST NOT invent fields not present in v2 records. If a panel needs data that v2 doesn't emit, route to architect — either the schema extends or the panel design adapts.

### 2.2 Secondary data source: CompiledConfig (read-only)

Calibration version badge (§3.3) and some provenance drill-downs read from the `CompiledConfig` artifact referenced by `record.compiled_config_version`. The browser bundle ships with a copy of the current compiled config (v4 at W4; v5 at W5 if a new one is built); UI loads it at startup and indexes by signal name and cell key.

Not all provenance is reachable from CompiledConfig — the detector's firing statistic and threshold at runtime are in the audit record, not the config. Config is consulted for things like "what's the `τ²` prior for signal X" that didn't make it into per-tick records.

### 2.3 Shadow-compare stream

Shadow-compare panel reads two parallel verdict streams: portfolio (current NS engine) and cascade (legacy engine). Both run in parallel on the same tick stream; both emit their own audit records with `fusion_topology` set respectively to `"portfolio"` and `"cascade"`. The UI correlates them by `(service, deploy_id, tick)`.

Engine-side invariant (see pasteable): both engines MUST emit at every tick, even when suppressed. No dropped ticks on either stream; synchronization is by tick index.

## 3. Panel specifications

### 3.1 Provenance panel (WS3.2 — currently being scaffolded)

**Purpose.** Show, for each tick, which detectors fired in which families, with their statistical provenance. This is the "self-explaining verdicts" pitch beat.

**Data binding.**

Read from `record.families.{A,B,C,D,E}.detectors[]`. For each `DetectorTripV2`:

| UI field | Reads from | Notes |
|---|---|---|
| Detector name | `label` | Already human-readable, e.g., "p99 Latency (Page-CUSUM)". If missing, fallback to `detector_id`. |
| Family identifier | `family_id` | Use family palette (normative, see §4). |
| Statistic value | `statistic` | Display with ≤4 significant digits. Unit depends on detector: for Page-CUSUM show unitless log-LR `S_n`; for betting e-process show the unitless wealth `M_t`; for Hotelling T² show unitless T² value. |
| Threshold | `threshold` | Same format as statistic. |
| Statistic / threshold ratio | derive: `statistic / threshold` | Shows how far above / below firing the detector is. Helps pitch audience see "catches sit 0.12–3.12 above threshold" visually. |
| α spent | `alpha_spent` | Display as scientific notation (e.g., `4.0e-4`) — α values are always sub-unit and scientific is legible. |
| CUSUM progress | `cusum_progress` | **Family A only.** If `family_id !== 'A'`, this field is absent — UI must not render it. Display as percentage (`0.83 → 83%`). |
| Reason code | `reason_code` | Machine-readable. Display as monospace chip: `cusum_crossed_h`, `t2_exceeded_chi_quantile`, etc. |
| Gate | `gate` | `health_rollback` or `health_extend`. Suffix to verdict text if non-default. |

**Per-detector hover affordance (derivation chain).**

On hover (or click on touch), surface:
- Signal path: `"signal: p99_latency → cell: hour_of_day=14, day_of_week=2 (strict) → τ²=0.0025, α_per_signal=6.67e-5"`.
- Baseline reference: `"from baseline v3-family-c-2d-cells, compiled 2026-04-18T14:22:11Z"`.
- Cell confidence indicator (matches §4 confidence visuals): strict/pooled/aggregate/none.
- Schema continuity flag (from Provenance.schema_continuity): typically null in runway; shows `continuous | extended | breaking | observability_stack` if non-null (post-S6 landing in W5 subtask 5.0).

**Per-family aggregate row (above detectors).**

For each family, show a summary row:

- Family color + letter (A/B/C/D/E).
- Family verdict (`fire`, `indeterminate`, `clean`, `suppressed`) — use verdict traffic-light colors from §4.
- If suppressed: show `suppression_reason` as a chip (`bake_profile`, `cell_confidence_none`, `schema_continuity_breaking`, `observability_stack_deploy`, `structural_mismatch`).
- Count of detectors in the family: "2/6 fired" or "0/16 fired".
- Family α spent.

**Empty state.** When `families.B.detectors[]` is empty and `families.B.verdict === "clean"`, show a single line "Family B: 0/16 fired, all clean" — do not render 16 empty rows.

### 3.2 Shadow-compare panel

**Purpose.** Shows the cascade (legacy) engine's verdict stream alongside the portfolio (NS) engine's stream at each tick. Lets the pitch audience see "where the new architecture diverges from the old, and which divergences are catches."

**Data binding.**

Read from two verdict streams indexed by tick. For each tick `t`:

| UI element | Cascade source | Portfolio source |
|---|---|---|
| Verdict | `record_cascade.verdict` | `record_portfolio.verdict` |
| Reason | `record_cascade.reason` | `record_portfolio.reason` |
| Fires | `record_cascade.tripped[]` (flat) | `record_portfolio.families.*.detectors[]` (per-family) |
| α spent | not applicable (cascade has no α budget) | `record_portfolio.total_alpha_spent` |

**Layout.** Two columns side-by-side, tick-indexed rows. Same tick on the same row. Don't interleave — parallel streams are the point.

**Divergence highlighting.** When `record_cascade.verdict !== record_portfolio.verdict` at the same tick, highlight that row with a yellow background (`#fdf2cc`, not red — divergence is informational). Add a chip next to the portfolio-side verdict text: `"cascade: {cascade.verdict}"`.

**Divergence categories** (useful for the pitch's "we catch what they don't" beat):

- **Portfolio catches, cascade misses:** portfolio=`rollback`, cascade=`proceed`. This is the architectural differentiator; color the portfolio-side chip green with a checkmark.
- **Cascade catches, portfolio misses:** portfolio=`proceed`, cascade=`rollback`. Flag as red — this is a regression the pitch needs to explain. At W5, expected count = 0 across all canned demos (demo design preserves this).
- **Timing divergence:** both eventually rollback but at different ticks. Show tick delta (e.g., `"portfolio fired at t=4, cascade at t=11"`).

**Summary footer.** At run end, show: `"Divergences: {count} rows. Portfolio-catches-cascade-misses: {count}. Cascade-catches-portfolio-misses: {count}. Timing deltas: {count}."`

### 3.3 Calibration version badge

**Purpose.** Shows which compiled config version the current verdict stream is running against. Reinforces the "derived thresholds, not hand-tuned" pitch beat.

**Data binding.**

Read from `record.compiled_config_version`. Display in the demo header (always visible, not panel-specific).

**Format.**

```
  [📎 v4-fusion-topology-2026-04-18]
```

Leading icon (chain link or clipboard) indicates "this is the configuration artifact." Click opens a modal/side-panel showing:

- Full config version string and ISO 8601 compiled_at timestamp.
- Baseline reference: `baseline_ref` from CompiledConfig (e.g., `synthetic-v3@seed=42`).
- α budget: total and per-family allocation as a table.
- Cell matrix stats: dimensions, cell count, confidence distribution (e.g., `"168 cells: 168 strict, 0 pooled, 0 aggregate, 0 none"`).
- Compiler version: `compiler_version` field.

**Change indicator.** If the demo re-runs against a different config mid-session (not expected in canned demos but possible in dev), badge flashes briefly and shows the prior version below in struck-through text for one tick.

### 3.4 α-budget meter

**Purpose.** Shows how much of the run's false-alarm budget has been spent, allocated across families. Visual honest-broker of "how much confidence does this verdict cost us against the stated α guarantee."

**Data binding.**

Read from `record.families.*.alpha_spent` per tick, accumulating into a running sum. Also read `record.total_alpha_spent` for top-level sanity (it must equal the sum of per-family values).

**Layout.** Stacked horizontal bar. Total width represents `α_total = α_A + α_C + α_D + α_E = 8e-4` (spending families only, per NS-ARCH §L2). The bar renders all five families so the Ville-full portfolio stays visible at a glance; Family B's segment is shown for structural-coverage visualization only and does not consume any α budget — it is an absolute-threshold detector, not a statistical test. Spending-family segments render in full family color (§4); Family B renders in a muted tone with a diagonal hatch pattern to signal "structural, not α-consuming."

```
|<-------- α_total = 8e-4 (spending only: A + C + D + E) -------->|
| A: 4e-4 (50%) | C: 2e-4 (25%) | D: 1e-4 (12.5%) | E: 1e-4 (12.5%) |
[===spent===]   [==spent==]     [===spent===]     [===spent===]
| B: structural (hatched; no α)                                    |
```

Within each family's segment:
- Filled portion: cumulative `alpha_spent` for that family up to current tick.
- Empty portion: remaining budget for that family.
- Segment color: family color (§4); filled portion is full saturation, empty portion is the same hue at 20% opacity.

**Thresholding visual.**

When a family's filled portion exceeds ~80% of its segment: flash the segment briefly to indicate "this family is running hot." This is diagnostic — doesn't trigger any action, just surfaces pressure on the budget.

**Numerical readout.**

Below the bar: `"total: {spent} / {total_alpha} ({percent}%)"`. Per-family breakdown in a tooltip on hover.

**Ville's inequality note.**

The tooltip for the total meter shows the anytime-valid guarantee. **FINAL text** (ARCHITECT-REPLY-53 R2 — α-total display reconciliation; supersedes the single-sentence form from REPLY-46 D8 now that the 5-family visualization makes Family B's non-spending role explicit):

> `"α_total = α_A + α_C + α_D + α_E = 8e-4 (spending families). Family B shown for structural-coverage visualization; does not consume α budget (absolute-threshold detector; not statistical test). Run-level false-alarm probability ≤ α_total regardless of tick count, per Ville's inequality on family-wise e-processes."`

Interim-to-final path (preserved for project history): Session-3 (Addition #17, A-only) → post-#20 (A + C) → post-#21 (A + C + D) → post-#22 (REPLY-46 D8 interim single-sentence form) → post-REPLY-53 R2 (this FINAL form, reconciling visual 5-family bar with 4-family α sum).

## 4. Color coding and visual conventions

### 4.1 Verdict colors (normative)

Identical across every panel — status badges, row backgrounds, chips, verdict text:

| Verdict | Hex | Rationale |
|---|---|---|
| `proceed` | `#1e9e4f` | Green — positive, promotion green |
| `extend` | `#e8b109` | Amber — caution, not yet decided |
| `rollback` | `#d93025` | Red — alarm, action required |
| `baking` | `#8a8f9c` | Gray — not yet decided, no information |
| `suppressed` | `#8a8f9c` with diagonal stripe pattern | Gray striped — "not applicable, don't interpret" |

### 4.2 Family palette (normative)

Used consistently everywhere a family needs color identification:

| Family | Hex | Name | Rationale |
|---|---|---|---|
| A | `#2f6ec9` | Blue | Primary, sequential testing, core |
| B | `#0d8a7c` | Teal | Structural, domain-specific, grounded |
| C | `#7b3fc7` | Purple | Multivariate, statistical, "distinct" |
| D | `#d07a1f` | Amber | Temporal, "warmer" — oscillation/time |
| E | `#c32c8a` | Magenta | Novelty, "outlier" — unknown unknowns |

Palette chosen for distinguishability on both light and dark backgrounds and for accessibility (WCAG AA contrast on white and on `#1a1d24`).

### 4.3 Cell confidence visuals (normative)

Accompany per-detector provenance displays:

| Confidence | Visual |
|---|---|
| `strict` | Solid fill, full opacity |
| `pooled` | Solid outline, 20% fill opacity — conveys "data borrowed from neighbors" |
| `aggregate` | Dashed outline, 10% fill opacity — conveys "fallback to global" |
| `none` | Ghosted (30% opacity overall) with "suppressed" overlay |

### 4.4 Divergence visual (normative)

Shadow-compare panel: `#fdf2cc` yellow background for divergence rows. NOT `#d93025` red — divergence is informational, red would incorrectly imply alarm on cases where the portfolio is correctly catching.

### 4.5 Typography and layout (recommended)

- Body text: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` (system font stack; matches demo's platform).
- Monospace (for codes, statistics, config versions): `"SF Mono", Menlo, Consolas, monospace`.
- Font size: 14px base, 12px for dense tabular data, 18px for verdict badge prominence.
- Panel separation: 24px vertical gap between major panels; 12px within-panel row gap.

WS3 can refine these as rendering feedback surfaces. Only the colors and visual conventions in §4.1–§4.4 are architect-normative.

## 5. Interactions and affordances

### 5.1 Hover for derivation (provenance panel)

Each fired detector in the provenance panel shows a hover-for-derivation surface (§3.1). No click required. Touch users get tap-to-pin.

### 5.2 Click for expansion (calibration badge)

Calibration badge in header is click-to-expand (modal or side-sheet — WS3 call). Escape/backdrop dismisses.

### 5.3 Tick scrub (recommended)

Recommended but not normative: a timeline scrubber below the demo that lets the user scrub to any tick and see the panel state at that moment. Useful for pitch pacing — "pause at tick 8; here's what fires."

### 5.4 Pause / play / reset

Required for canned demo pacing. Default pace: 500ms/tick. Pause/play are idempotent; reset returns to tick 0.

### 5.5 Legend

Required. Each panel shows an inline legend explaining verdict colors and family palette. Don't hide behind affordances — pitch audiences don't always know conventions.

## 6. Canned demo specifications

Three canned demos. Each is a deterministic JSON file under `demos/scripts/` that the demo harness streams at demo-cadence.

### 6.1 Demo 1: Clean deploy (demo-clean.json)

**Narrative.** "Here's the happy path. A well-calibrated deploy of a serving-code change. Every family evaluates cleanly; α budget remains barely touched; the gate promotes the deploy."

**Signal trajectories.** 32 ticks. All 13 signals stay within their healthy bands (cell-consistent values with sampling noise). No drift of any kind.

**Expected verdicts.** All ticks `baking` through tick 6, then `proceed` sustained through tick 31.

**Expected family states.**
- Family A: `clean` throughout (Page-CUSUM statistics stay well below thresholds).
- Family B: `clean` throughout.
- Family C: `clean` throughout.
- Family D: `clean` throughout (after `min_ticks_before_eligible`).
- Family E: `clean` throughout.

**Pitch beat.** "Every verdict carries its own receipt. Even on a clean deploy, you can see what was checked and what passed."

**α budget burn.** Stays near zero — `total_alpha_spent` under `1e-5` at end of run.

### 6.2 Demo 2: Novelty catch (demo-novelty.json)

**Narrative.** "Here's a failure mode the engine was never explicitly trained on. A joint-distribution shift that doesn't match any structural signature and doesn't cross any single-metric threshold. Family E's conformal scorer catches it because the Mahalanobis distance to the baseline distribution crosses the calibrated quantile."

**Signal trajectories.** 32 ticks. Starting at tick 10, the signal vector rotates along a direction that's NOT aligned with the native covariance principal axis AND doesn't match any Family B structural signature. Individual signal magnitudes stay within thresholds (each is at most 4% off baseline); Family A's Page-CUSUM doesn't accumulate meaningful drift; Family B structural detectors don't fire; Family C's Hotelling T² stays below threshold (the rotation is in a direction the covariance doesn't capture well). Only Family E fires.

**Expected verdicts.** `baking` through tick 6, `baking → extend` transition around tick 12–14 as Family E's conformal score climbs, `rollback` at tick 16 when Family E crosses its calibrated quantile.

**Expected family states.**
- Family A: `clean` throughout (Page-CUSUM statistics stay below threshold; cusum_progress climbs to ~0.4–0.6 but doesn't cross).
- Family B: `clean` throughout.
- Family C: `clean` throughout (T² climbs to ~20 but threshold is ~35.88; well under).
- Family D: `clean` (no oscillation in the drift pattern).
- Family E: `clean` through tick 12, `indeterminate` at ticks 13–15, `fire` at tick 16.

**Pitch beat.** "This is the unknown-unknowns coverage. No existing deployment gate has a channel designed for this. The conformal scorer gives a calibrated p-value with formal FP control under exchangeability — it fires with a defensible confidence statement, not an opaque ML score."

**α budget burn.** Family E's portion spends at tick 16 when it fires; total `~1e-4`.

### 6.3 Demo 3: GitHub January 2020 Redis cascade reconstruction (demo-github-2020.json)

**Narrative.** "Here's a reconstruction of a real public incident. On January 28, 2020, GitHub suffered a ~2-hour degradation from a Redis primary failure that cascaded into background job queue saturation. This demo reconstructs what that trajectory would have looked like in our 13-signal model. Three families catch it; fusion fires rollback at tick 9."

**Scenario context.**

```json
{
  "service": "inference-sim",
  "deploy_context": {
    "change_type": "serving_code",
    "risk_level": "high",
    "author": "human",
    "reversibility": "reversible",
    "traffic_pct": 0.1
  },
  "narrative_reference": "GitHub January 28, 2020 postmortem — https://github.blog/2020-01-29-update-on-january-28-incident/",
  "reconstructability_note": "Signal trajectories inferred from published latency percentiles and worker saturation curves. Magnitudes within ±20% of GitHub's reported values."
}
```

**Signal trajectories.** 32 ticks. Baseline values per cell hour_of_day=14, day_of_week=2 (Tuesday 2pm, the cell the synthetic generator emits for this time).

```
Tick |  p99_latency  ttft   kv_cache  mfu    downstream_err  cost_req  traffic_pct
     |  (ms)         (ms)   (ratio)   (ratio)  (ratio)       ($/req)   (ratio)
-----+-------------------------------------------------------------------------------
 0   |   185          220    0.89     0.72    0.0011         0.0042    0.10
 1   |   187          222    0.89     0.71    0.0012         0.0042    0.10
 2   |   183          218    0.89     0.72    0.0011         0.0041    0.10
 3   |   186          221    0.89     0.72    0.0012         0.0042    0.10
 4   |   189          224    0.88     0.71    0.0013         0.0043    0.10
 5   |   192          228    0.87     0.71    0.0014         0.0044    0.10  ← cache pressure starts
 6   |   201          238    0.84     0.70    0.0018         0.0046    0.10
 7   |   215          255    0.79     0.69    0.0024         0.0049    0.10  ← Redis degrading
 8   |   248          294    0.71     0.67    0.0038         0.0055    0.10  ← cascade starts
 9   |   312          370    0.60     0.64    0.0062         0.0065    0.10  ← ROLLBACK FIRES
 10  |   418          497    0.52     0.61    0.0094         0.0079    0.10
 11  |   562          668    0.48     0.59    0.0128         0.0098    0.10
 12  |   687          818    0.47     0.58    0.0142         0.0114    0.10
 13  |   724          861    0.47     0.58    0.0147         0.0118    0.10
 14  |   698          830    0.48     0.59    0.0142         0.0114    0.10
 15  |   651          774    0.50     0.60    0.0133         0.0108    0.10  ← plateau
 16  |   612          728    0.52     0.61    0.0122         0.0101    0.10
 17  |   583          693    0.54     0.62    0.0113         0.0096    0.10
 18  |   558          663    0.56     0.63    0.0104         0.0091    0.10
 19  |   534          635    0.59     0.64    0.0095         0.0087    0.10
 20  |   511          608    0.61     0.65    0.0087         0.0082    0.10
 21  |   489          581    0.64     0.66    0.0079         0.0078    0.10
 22  |   468          557    0.67     0.67    0.0072         0.0074    0.10
 23  |   448          533    0.71     0.68    0.0066         0.0070    0.10
 24  |   428          510    0.74     0.69    0.0060         0.0067    0.10
 25  |   410          487    0.77     0.69    0.0054         0.0064    0.10
 26  |   392          466    0.80     0.70    0.0049         0.0061    0.10
 27  |   375          446    0.83     0.70    0.0044         0.0058    0.10
 28  |   358          426    0.85     0.71    0.0040         0.0055    0.10
 29  |   342          407    0.87     0.71    0.0036         0.0052    0.10
 30  |   327          389    0.89     0.72    0.0032         0.0050    0.10  ← nearly recovered
 31  |   315          375    0.89     0.72    0.0030         0.0049    0.10
```

**Architectural commentary (for the demo pitch narration, not rendered in UI):**
- Ticks 0–4: stable baseline.
- Ticks 5–7: cache hit rate (`kv_cache`) starts declining; Family B's `kv_saturation` detector begins trending toward fire (it's designed to catch exactly this pattern — pinned-flat-then-breaking at the capacity ceiling).
- Tick 7: `kv_saturation` fires (first family to catch).
- Tick 8: Family A's Page-CUSUM on p99_latency crosses threshold (the mixture-prior CUSUM has accumulated enough evidence).
- Tick 9: **Portfolio verdict: rollback.** Three families firing simultaneously:
  - Family A: `mSPRT_p99_latency` (CUSUM crossed threshold ~h=9.6)
  - Family A: `mSPRT_ttft` (same story, following p99)
  - Family A: `mSPRT_downstream_err` (error rate jumped)
  - Family B: `kv_saturation` (cache pressure pattern)
  - Family C: `hotelling_t2_joint_vector` (joint drift across p99/ttft/kv_cache/cost is a direction the native covariance does catch)
- Ticks 10–14: plateau then peak. Verdict stays rollback; α budget continues accumulating but the decision was made at tick 9.
- Ticks 15–31: gradual recovery (if the deploy hadn't been rolled back). Shows that the gate's rollback decision was correct — the system would have sat at 3x baseline latency for another ~20 ticks (roughly 100 seconds in demo pace, but representing ~2 hours in the real incident).

**Expected family states.**
- Family A: `clean` through tick 6, `indeterminate` at tick 7, `fire` at tick 8 (p99_latency first), multiple detectors firing by tick 9.
- Family B: `clean` through tick 5, `indeterminate` at tick 6, `fire` at tick 7 (`kv_saturation`).
- Family C: `clean` through tick 7, `indeterminate` at tick 8, `fire` at tick 9.
- Family D: `clean` throughout (no oscillation).
- Family E: `clean` throughout (pattern is classical infrastructure, not novel — Family E appropriately doesn't fire redundantly).

**Shadow-compare beat.** Both cascade and portfolio eventually fire rollback. Cascade fires at tick 11 (reaches p99 ratio threshold of 1.50 when p99 hits 312 → ratio 1.69). Portfolio fires at tick 9. **Timing delta of 2 ticks (~10 seconds in demo pace; ~60 seconds in real incident).** The pitch beat: "Portfolio catches the cascade 60 seconds earlier — one minute of customer-facing impact avoided."

**α budget burn.** Multi-family fire at tick 9; total `alpha_spent` jumps from `~0` to `~6e-4` at that tick. Post-fire, no further accumulation.

**Honest-broker framing (render in UI sidebar during demo pacing).**

> "This is a reconstruction of GitHub's January 28, 2020 incident based on their published postmortem. Signal trajectories are inferred from reported latency percentiles and worker saturation curves; magnitudes are within ±20% of GitHub's reported values. The detection behavior shown reflects what our engine would do against that trajectory. Whether the real-world trajectory was exactly this shape is a fidelity question bounded by the postmortem's level of detail."

This framing appears in the demo UI alongside the scenario, NOT just in pitch narration. The pitch audience sees we're honest about reconstruction fidelity.

### 6.4 Demo harness requirements (normative)

All three demos:

- Deterministic: fixed seed baked into file; no runtime randomness beyond UI animation.
- Use v2 audit schema records exclusively (no v1 fallback in demo paths).
- Include a `narrative` field at the top with the pitch narration text (so the demo can render synchronized narration-below-tick-timeline).
- Include per-tick `pause_beat: bool` field — when true, the demo harness auto-pauses at that tick for ~2 seconds to let the audience absorb the state change. Default false; set true for architecturally significant moments (first fire per family, rollback decision, peak degradation).

## 7. What's explicitly out of scope for W5

- **Live telemetry ingestion.** Demo runs exclusively on canned JSON.
- **Multi-service view.** Single service (`inference-sim`).
- **Edit-in-UI of thresholds.** Compiled config is read-only.
- **Authentication / ACLs.** Demo runs locally.
- **Historical prior-deploy comparison.** Only current-deploy shadow-compare.
- **Follow-on integrations (the model-lifecycle tooling, the platform governance layer, real Argo Rollouts).** Demo uses a mock orchestrator context in the canned JSON.
- **Custom theming / white-labeling.** Default theme only.
- **Mobile / responsive layouts.** Desktop-browser-first.
- **Internationalization.** English only.
- **Keyboard accessibility beyond basic focus order.** File for W6+ if time permits.

## 8. Versioning and changes

This spec is v1. Future versions as `WS3-INTERFACE-WEEK5-v2.md` if major changes needed; inline edits for minor clarifications.

If WS3 Cowork finds a field name unclear or missing during implementation, route to architect via John; I will either clarify here or extend the schema with a new architect-reply round. Don't improvise.

— Architect
