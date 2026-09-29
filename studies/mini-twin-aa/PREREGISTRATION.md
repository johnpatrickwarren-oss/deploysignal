# Pre-registration — the twin gate's `sign` kind as an A/A on same-cluster core pairs of the mac mini (`2026-09-mini-twin-aa`, tier T3, single box)

- **Study id:** `2026-09-mini-twin-aa`
- **What it serves:** the randomized twin (engine ADR 0036) is the one DeploySignal design whose
  validity does not rest on a fitted baseline, and its open question is the pairing premise, "no
  arm-level effect on any tick", which has been tested only on synthetic arms (T1) and on two
  identical local processes (T2). Its registered real-service A/A (T3, `studies/twin-aa-real`) waits
  on the AWS environment. This study asks the premise of real hardware now: two cores of the same
  cluster on one Apple-silicon box, with no core pinning, compared tick by tick by the twin's
  `sign` construction under no intervention. John ordered it on 2026-09-29 ("register the twin
  sign-kind A/A on the mini slot pairs").
- **Tier:** T3 for a single-box, per-pair claim only. The pilot's registration
  (`knowledge/methodology/pages/mac-mini-pilot-use-2026-09-04`) rules out any fleet, FDR or deploy
  claim from this box, and this study makes none. It is **not** the real-service A/A: there are no
  requests, no router, no versions; a core pair is a stand-in for a canary/control pair whose only
  shared cause is the box.
- **Repo:** deploysignal `main` `ddbf133` (branch `wt/mini-twin-aa`, worktree). **Engine:**
  `@johnpatrickwarren-oss/deploysignal-engine` v0.12.2-pre, resolved
  `0434afcdc7a4716788dc81427295c6c4cd14e019`. The gate is DeploySignal's own twin wrapper
  (`engine/gates/_health-twin.ts`, `freshTwinArm` / `stepTwinArm` over the engine's
  `per-shard/twin-gate.ts`), the code path a `mode: "twin"` session runs. Node v25.9.0.
- **Status: REGISTERED, NOT RUN.** A later change is an amendment, appended and dated, before the run.

## 0. Disclosures

- (a) Seen before registration, none a study result: the raw stream's field list and cadence
  (43 fields, 1 Hz, 14 per-core `c<i>_res` / `c<i>_mhz` series plus cluster and package series), the
  per-day line counts of the ten local files, two sample lines, and Tessera's bundle tool's
  comment that the box is an M4 Pro with 4 E-cores and 10 P-cores whose cluster membership it
  infers by correlation. No detector has been run on the data in this session.
- (b) The substrate is the **pre-gap passive stream already on this laptop**
  (`../tessera/runs/mini-data/2026-07-04.ndjson` to `2026-07-13.ndjson`, ten files, 650,840 lines),
  frozen by `SHA256SUMS` in this directory and verified before any window runs. Nothing is pulled
  from the mini; no file on the mini is opened. These days precede the 56-day tick gate and the
  Phase 2 campaign; they are an uninterrupted no-intervention stream, which is what an A/A needs,
  and they are not the registered C78/C81 substrate (Phase 2b), which this study does not touch.
- (c) Cluster membership is taken from the spec's layout, not inferred: E-cluster `c0`–`c3`,
  P0-cluster `c4`–`c8`, P1-cluster `c9`–`c13` (the raw lines show `c4`–`c8` zero together with
  `p0_res` and `c9`–`c13` moving with `p1_res`). If the run's first ten minutes contradict this
  (a listed core's `mhz` correlating better with another cluster's series), the study is NOT
  EXECUTABLE rather than re-paired.
- (d) What "exchangeable" means here: macOS assigns runnable threads to cores without pinning, so
  under no intervention two cores of one cluster see the same offered load through the same
  scheduler. Persistent scheduler preference (a first core filled before its neighbour) is exactly
  the persistent arm-level state ADR 0036 names as the premise's failure mode; this study measures
  whether it is present at this tick scale.
- (e) The mini measures itself: the collector, its writer, and any remote-access session are
  real load on some core. The pilot page's hygiene rule (probe and access windows excised) cannot
  be applied to pre-gap days that have no journal. Disclosed; nothing is excised.
- (f) Determinism: the harness draws no random numbers and writes no wall-clock value into a
  tracked artifact; the engine's paired bet is deterministic.

## 1. Substrate and tick

Raw samples at 1 Hz. **Study tick: 10 s**; a tick's value for core `i` is the mean of `c<i>_res`
(active residency, per cent) over the raw samples whose `floor(t / 10)` is the tick; a tick with no
raw sample is **missing** for every pair. Ticks run over the union of the ten files' time range.

## 2. Pairs and arms

**Arm S (same cluster), six pairs:** (`c0`,`c1`), (`c2`,`c3`) in the E-cluster; (`c4`,`c5`),
(`c6`,`c7`) in P0; (`c9`,`c10`), (`c11`,`c12`) in P1. The first-named core is the canary.

**Arm X (cross-lane control), one pair:** (`c0`,`c9`), an E-core against a P-core. The premise
fails here by construction (different core types, different scheduler roles); the arm exists to
show the instrument rejects a pair it should reject. Report only.

**Metric:** one `sign` metric per pair, `id: core_res`, `worse: 'higher'` (the direction is a
label; an A/A is symmetric), `tolerance: 0.15` (the `twin-generic` profile's value).

## 3. Windows and the gate

Consecutive, non-overlapping windows of **360 ticks (1 h)** from the first tick. A window is
scorable iff at least 180 of its ticks are present; others are listed and not scored. Each scorable
window is a fresh twin run: `freshTwinArm` with `canary_weight 0.5`, `alpha_rollback 0.05`,
`alpha_proceed 0.05`, `alpha_srm 0.001`, `max_ticks 360`, then `stepTwinArm` once per tick with
`canaryRequests 1`, `controlRequests 1` and the observation `{ canary: x_i, control: x_j }` on a
present tick, or `canaryRequests 0`, `controlRequests 0` and no observation on a missing tick (the
engine's `skip`, no wealth change: no traffic, no penalty). Ties (`x_i === x_j`, including both
idle at 0) are the engine's ties: counted, no evidence. Outcome per window: the first terminal
verdict (`rollback`, `proceed`, `invalid_experiment`) or `inconclusive` at `max_ticks`; the tick
of the terminal verdict; `used`, `ties`, `skipped` counts.

## 4. Endpoints

- **E1 — false-rollback rate, per pair and pooled over arm S.** PASS iff rollbacks / scorable
  windows ≤ **0.05** (the gate's own α_rollback, the bound it claims under the premise). Reported:
  the one-sided 95% Clopper–Pearson upper bound, the per-pair rates, the median rollback tick.
- **E2 — outcome mix (report only):** per pair, the shares `proceed`, `inconclusive`, `rollback`,
  `invalid_experiment`; the tie share (`ties / (used + ties)`); the skipped share.
- **E3 — arm X (report only):** its rollback rate and median rollback tick.
- **E4 — instrument:** hashes verified, zero harness exceptions, at least 100 scorable windows.

## 5. Predictions

- P1: **E1 FAILS pooled over arm S**, and fails on at least the two pairs that include a cluster's
  first core (`c0`,`c1`) and (`c4`,`c5`): the scheduler fills cores in a stable order, which is
  persistent arm-level state, and one hour at 10 s resolution is long enough for the sign wealth to
  cross at α 0.05 when P(canary worse) sits a few points off ½. Point figure: pooled rate ≥ 0.20.
  Risk stated in advance: if placement is symmetric at this scale, arm S passes and the premise
  holds on real hardware for a pair with no traffic asymmetry; that is the more useful outcome and
  the one this registration is written to be able to report.
- P2: arm X rolls back in at least 0.90 of scorable windows, with a median rollback tick under 60.
- P3: idle clusters tie heavily: the P0 pairs' tie share exceeds 0.50 and a majority of their
  windows end `inconclusive` rather than `proceed` or `rollback`.
- P4: E4 holds.

## 6. Instrument checks and NOT-EXECUTABLE conditions

Smoke before the run, not scored: (i) one window of (`c0`,`c1`) with `+20` added to the canary's
residency on every present tick ends `rollback`; (ii) one window of (`c0`,`c1`) with the two cores'
values swapped tick by tick gives the mirror verdict of the unmodified window (the construction is
symmetric); (iii) the unmodified window reports `used + ties + skipped === 360`.

- A hash mismatch on any file read: NOT EXECUTABLE before any window runs.
- Fewer than 100 scorable windows: NOT EXECUTABLE.
- The cluster layout of §0(c) contradicted by the first ten minutes: NOT EXECUTABLE.
- A harness exception in a window voids it and is counted; more than 5% voided: NOT EXECUTABLE.
- A void run is preserved and reported with its computed numbers beside the void.

## 7. What this can and cannot show

No authority moves. `TWIN_ARM_AUTHORITY` stays `'advisory'` whatever the result; the real-service
A/A remains the named condition for any authority ADR. A pass on arm S is the first real-hardware
evidence that the twin's pairing premise can hold for units with no traffic asymmetry; a fail
localises the premise's failure to persistent placement state on one box, at one tick scale, and
says what a real service would have to rule out. Arm X is a control on the instrument, not a
finding about cores.

## 8. Not measured

Requests, routing, the `rate` kind, the sample-ratio guard under real routing (the counts are
constants here), any tolerance but 0.15, any tick but 10 s, any window but 1 h, the post-gap days
on the mini, the Phase 2 interventions, `core_mhz` or any metric but residency, cross-cluster
pairs other than (`c0`,`c9`), and the missingness penalty (missing ticks are skipped, not
penalised).
