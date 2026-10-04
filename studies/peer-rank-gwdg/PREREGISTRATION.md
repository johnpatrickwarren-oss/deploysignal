# Pre-registration — the rank-among-peers kind on real GPU telemetry (`2026-10-peer-rank-gwdg`, T3 replay)

- **Study id:** `2026-10-peer-rank-gwdg`. Register: knowledge `WORKLIST.md` C84/C87 (the designed-null
  programme, step 2); engine ADR 0039 (`detectors/peer-rank.ts`, study `2026-10-peer-rank`, T1, ship
  rule MET at engine `af805e8`); DeploySignal study `2026-09-gwdg-gate` (`studies/gwdg-gate`), whose
  units and windows this study reuses unchanged.
- **The question.** On the same 44 healthy windows where the temporal path rolled back 40 (Family A
  alone, 0.909) against each GPU's own history, what does a comparison against the GPU's three
  node-mates at the same time do? And on the same 40 incident windows, does it detect?
- **Tier:** T3 replay on real telemetry (the GWDG GPU node dataset, Zenodo `10.5281/zenodo.19052367`,
  local copy at `../tessera/runs/gwdg-data/…`, hashes as `studies/gwdg-gate/results/run-20260929T012317Z/bundles.SHA256SUMS`'
  source files); no AWS; no authority.
- **Engine:** `detectors/peer-rank.ts` at engine commit `af805e8` (`v0.15.0-pre` candidate, PR #116,
  unreleased). DeploySignal pins `v0.13.0-pre` for the running onebox study and cannot be re-pinned
  until it closes; this harness therefore loads the kind from a local checkout of the engine at that
  commit (`ENGINE_DIST`), records the checkout's sha and `dist/detectors/peer-rank.js` hash in the
  manifest, and refuses to run if the sha differs. A consumer re-pin is not part of this study.
- **Status: REGISTERED, NOT RUN.** Committed alone, before the harness.

## 0. Disclosures

- The temporal path's results on these windows are known (`studies/gwdg-gate/REPORT.md`: E1 FAIL
  40/44 arm A, 42/44 arm AC; E2 34/40 and 35/40; most detections on the incident day or at metric
  disappearance). This study's bars are the same as that study's, for comparability, and were not
  chosen after looking at the peer kind on this data: no peer comparison has been computed on it.
- Peers here are node-mates. A node-level incident degrades all four GPUs together, and a
  comparison among them sees nothing; detection may therefore be low for reasons that have nothing
  to do with the kind's validity. Stated before the run; §4 scores it anyway.
- The direction of "worse" is not known per signal for a detachment incident (a dying GPU may run
  hot and draw more power, or drop out and draw none). Both directions are tested per signal, 16
  one-sided tests, Bonferroni 16.
- The margin (10% relative) is a declared guess at the spread between healthy node-mates. A 5% arm
  is run and reported for sensitivity; neither is tuned after the run.

## 1. Data, units, windows

Exactly the `2026-09-gwdg-gate` run `run-20260929T012317Z`: its `units.json` (eligibility) and
`windows.json` (44 null windows, 40 detection windows, arm A rows) are read and used as the window
list; the harness re-derives nothing. Tidy files are loaded with `studies/gwdg-gate/harness/lib.mjs`
`loadTidy` (the eight study signals plus XID), hashed against that run's recorded sums.

A unit is (file, GPU); its **peers are the other GPUs in the same file** (three, where all four
report). A tick is scorable for a signal when the unit's value and at least one peer's value are
finite at that timestamp; otherwise it is counted (`missing` if the unit's value is absent,
`skipped` if no peer's is) and not scored.

**Disappearance** (report only): the first tick in a window at which every study signal of the unit
is absent while at least two peers report all of theirs, if that persists for 6 consecutive ticks.

## 2. The kind, as run

Per unit and window, 16 `PeerRankSpec`s: for each of the eight signals, `worse: 'higher'` and
`worse: 'lower'`, `tolerance 0.1`, `alpha 0.05`, margin per arm: **M10** `{ relative: 0.10 }`
(primary), **M5** `{ relative: 0.05 }` (reported). Fresh state per window. Per tick, each spec is
stepped with `{ unit, peers }` for its signal. **Rollback** at the first tick at which any spec's
rollback e-value ≥ 16 / 0.05 = 320 (Bonferroni over the 16 tests at α 0.05, one window = one
session); the firing specs and their signals and directions are recorded. A window with no
rollback ends `hold`. No proceed verdict is scored (the proceed side is recorded).

## 3. Endpoints

- **E1 — false rollback on the 44 null windows, arm M10.** PASS iff rollbacks / 44 ≤ 0.05 (the gwdg-gate
  bar). Reported: the exact 95% upper bound and the rate per 1,000 ticks (12,672 null ticks).
- **E2 — detection on the 40 detection windows, arm M10.** PASS iff rollbacks / 40 ≥ 0.50.
- **E3 — lead time**, report only: per detected unit `fire_tick − I` in hours and, where XID is
  nonzero, `fire_tick − xid_first_tick`; the share of detections at or after the disappearance tick.
- **E4 — arm M5**, report only: both rates beside M10's.
- **E5 — instrument:** zero harness exceptions in scored windows; the engine sha and the peer-rank
  module hash recorded; every window's tick count equals the gwdg-gate record's.

## 4. Predictions (registered)

- P1: E1 **FAILS narrowly**: 3–7 of 44 (0.07–0.16), moderate confidence. Mechanism: node-mates under a
  scheduler are not exchangeable over a one-to-four-day window (one GPU idle while three work), and a
  10% relative margin on utilisation and clocks will not absorb a GPU that sits at 0 while its mates
  run. If E1 passes at ≤ 2 of 44, the peer null is far stronger than I expect on this hardware.
- P2: E2 **FAILS**: 0.25–0.50, because a detachment incident is node-level in at least some files and
  because the kind cannot score a GPU whose signals have disappeared (the disappearance tick will be
  at or before most of the temporal path's fires). If E2 passes, the detections will be before `I`
  more often than the temporal path's were (early fraction above 0.5).
- P3: M5 has at least twice M10's false rollbacks and at most 1.5× its detections.
- P4: E5 holds.

## 5. What a result does and does not establish

Whichever way E1 goes, the number sits beside 0.909 for the same windows, hardware and dates, and
that comparison is the point: it is the first measurement of "peers at the same time" against "own
history" as a null on real telemetry. It is one dataset, one peer definition (node-mates), one
margin, and 44 windows: the bound on a rate is about 8% at best. It says nothing about the
service-level comparator (the twin), about staged rollouts, or about any fleet whose peers do not
share a workload. No authority changes on any outcome.

## 6. NOT EXECUTABLE

A hash mismatch on any tidy file or on the two gwdg-gate records; the engine checkout's sha not
`af805e8`; a harness exception in more than 5% of windows; fewer than 40 null or 36 detection
windows scorable (at least one scorable tick on at least one signal).

## Amendment 1 — 2026-10-03, before the harness (seven signals, not eight)

`2026-09-gwdg-gate`'s Amendment 1 removed `DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL`; its `lib.mjs`
`SIGNALS` carries seven. §0, §2 and §3 above read "eight signals, 16 tests, 320": they are **seven
signals, 14 one-sided tests, Bonferroni threshold 14 / 0.05 = 280**. The tidy-file hashes are checked
against `studies/gwdg-gate/SHA256SUMS` (the study's freeze file), not the bundle sums named in the
header. No bar or prediction changes.

## Amendment 2 — 2026-10-03, before the harness runs (the engine pin is the module, not the checkout)

The engine checkout on this machine is at the `v0.15.0-pre` release commit, whose
`dist/detectors/peer-rank.js` is byte-identical to `af805e8`'s. The pin is restated as: the harness
refuses to run unless `af805e8` is an ancestor of the checkout's HEAD **and**
`dist/detectors/peer-rank.js` has sha256 `b7901965efb891a0c60d6bbdd8383e7192a051e71979c27c31c8f56c6f97114c` (the file as committed at `af805e8`). Both are
recorded in the manifest. No other change.

## Amendment 3 — 2026-10-03, after a void run, before the scored run (the Bonferroni threshold)

`run-20261003T131943Z` is **void: instrument defect**, preserved unscored at
`results/void-20261003T131943Z-instrument-defect/`. `stepPeerRank` fires and becomes terminal at its own
`1/alpha`; the harness set `alpha 0.05` per spec and applied the Bonferroni threshold 280 outside the
module, so every e-process froze at about 20–30 and 280 was unreachable: 0 of 44 and 0 of 40 were
not measurements. Found by the instrument check (§ Disclosures: a planted ×3 on a unit's GPU temperature
with mean x = 1.00 over 288 ticks did not fire). Correction: each spec carries `alpha = 0.05 / 14`, so
the module's own threshold is 280 and the window's rollback is the module's fire. No bar, cell or
prediction changes; the scored run follows this amendment.
