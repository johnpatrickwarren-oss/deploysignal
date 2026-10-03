# Pre-registration — offsets and margin floors from each GPU's own pre-window, on the same windows (`2026-10-peer-offsets-gwdg`, T3 replay)

- **Study id:** `2026-10-peer-offsets-gwdg`. Register: knowledge C84/C87 (the designed-null programme,
  step 3); engine ADR 0041 (`PeerRankObservation.offsets` and `.margins`, study `2026-10-peer-offsets-2`
  MET; ADR 0040 REJECTED as registered, its reason corrected); DeploySignal `2026-10-peer-rank-gwdg`
  (26 of 44 healthy windows rolled back against node-mates with a fixed 10% margin).
- **The question.** On the same 44 healthy and 40 incident windows, when each GPU's gap to each node-mate
  and that gap's spread are taken from the GPU's own 96-hour pre-window and declared, how many healthy
  windows roll back, and does anything detect?
- **Tier:** T3 replay, the GWDG dataset as before, no AWS, no authority.
- **Engine:** `dist/detectors/peer-rank.js` with sha256 `6ff4582a0de8bf94fa7059af323dc6707d611fb93e4d3baccc1cefee6f18c848` (engine PR #118, `v0.16.0-pre` candidate,
  unreleased); the harness refuses any other module. DeploySignal still pins `v0.13.0-pre` for the
  running onebox study; the module is loaded from a local checkout as in `2026-10-peer-rank-gwdg`.
- **Status: REGISTERED, NOT RUN.** Committed alone, before the harness.

## 0. Disclosures

- `2026-10-peer-rank-gwdg`'s results are known in detail, including that two GPUs on a node work while
  two idle for a day or more and that the pattern produced rollbacks at the earliest reachable tick.
  This study's design follows from that: whether the pattern is stable from the pre-window into the
  scored window is exactly what it measures, and I do not know the answer.
- The pre-window is the gwdg-gate study's calibration window: 576 ticks (96 h) ending at least 24 h
  before the first event, per unit (`units.json` `calibration.start/end`). It was chosen there for
  the temporal path and is reused unchanged.
- The margin floor's quantile (0.90) and the spec margin (0.10) are declared; a 0.75-quantile arm is
  reported for sensitivity. Nothing is tuned after the run.
- Bars are `2026-09-gwdg-gate`'s, for comparability, as before.

## 1. Data, units, windows, peers

As `2026-10-peer-rank-gwdg` §1 exactly: the gwdg-gate run's `windows.json` (44 null, 40 detection, arm A
rows) and `units.json`; tidy files hashed against `studies/gwdg-gate/SHA256SUMS`; peers = the other GPUs
in the file; seven signals, both directions, 14 tests, Bonferroni threshold 280 (each spec `alpha =
0.05 / 14`); fresh state per window; one window = one session; rollback at the first module fire.

**Offsets and floors**, per unit, per peer j, per signal s, from the unit's calibration window: over the
ticks where both the unit's and peer j's value of s are finite and the peer's is non-zero,
r_t = unit_t / peer_j,t − 1; `offsets[j] = median(r)`; `margins[j] = quantile_q(|r_t − median(r)|)`,
q = 0.90 (arm **FL90**, primary) or 0.75 (arm **FL75**, reported). A pair with fewer than 144 such ticks
(24 h) gets `offsets[j] = NaN` (the module drops that peer for every tick; recorded as
`pairs_dropped`). The spec margin stays `{ relative: 0.10 }`, so the band for peer j is
max(0.10, margins[j]).

**Reported per pair and signal:** the offset and the floor; the share of pairs whose floor exceeds
0.10 (the floor binds), 0.50 and 1.00 (the pair is effectively removed). **Reported per unit:** the
unit's hot/cold rank by `GPU_TEMP` (mean rank among the four over the pre-window and over the scored
window) and whether it changed, as the diagnostic for regime switching.

## 2. Endpoints

- **E1 — false rollback, 44 null windows, FL90.** PASS iff ≤ 0.05; exact upper bound and per-1,000-tick rate reported.
- **E2 — detection, 40 incident windows, FL90.** PASS iff ≥ 0.50.
- **E3 — lead time**, report only, as before; plus fires by whether the unit's hot/cold rank changed.
- **E4 — FL75**, report only.
- **E5 — instrument:** 0 exceptions; hashes verified; the module hash matches; the planted-regression
  check (a unit's `GPU_TEMP` ×3 from tick 50 in one null window fires; unmodified holds) is run and
  printed before the scored run and is not a result.

## 3. Predictions (registered)

- P1: E1 **FAILS, but far below 26**: 3–9 of 44 (0.07–0.20), moderate confidence. Mechanism: the
  two-working-two-idle assignment persists for days (offsets absorb it) but not for a week (the
  scored window begins at least 24 h and up to several days after the pre-window ends), and a GPU
  whose role switches between the two windows is a two-fold gap change no floor from the pre-window
  covers. If E1 passes at ≤ 2 of 44, roles are more stable than I think.
- P2: E2 **FAILS**: 0.20–0.45. Detachment incidents change a GPU's gap to its mates, which this kind can
  see, but the earlier study found no disappearance and many incident windows share the healthy
  windows' structure. If E2 passes, the detections will be before `I` (early fraction above 0.5), and
  I will not be able to tell them from role switches without the hot/cold diagnostic, which §1 reports
  for that reason.
- P3: floors exceed 0.10 on more than half the pairs for temperature and power (the binding case) and
  exceed 1.00 on at least a tenth (pairs effectively removed); FL75 has more rollbacks on both window
  kinds than FL90.
- P4: E5 holds.

## 4. What a result does and does not establish

Three numbers on the same 44 windows, hardware and dates: 0.909 against own history, 0.591 against
node-mates, and this study's against node-mates with each pair's own pre-window gap and spread
declared. That is the comparison the designed-null programme set out to make. It is one dataset, one
peer definition, one pre-window length and one quantile. No authority changes on any outcome.

## 5. NOT EXECUTABLE

A hash mismatch; the module hash not the pinned one; exceptions in more than 5% of windows; fewer than
40 null or 36 detection windows with at least one scorable pair on at least one signal.
