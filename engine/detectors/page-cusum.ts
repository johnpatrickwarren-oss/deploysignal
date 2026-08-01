// engine/detectors/page-cusum.ts — Family A co-ship: Page-CUSUM with
// mixture prior + betting-based e-processes (see betting-e-process.ts).
// Both fire independently under a 50/50 α-split of the per-signal
// Bonferroni-corrected budget; Family A fuses via any-fire union.
//
// Per ARCHITECT-REPLY-05.md (2026-04-18) and ARCHITECT-REPLY-34.md
// (2026-04-20, Addition #17 co-ship). The sliding-window mSPRT drafted
// earlier in W2 was a spec gap — cumulative mean has the same pre-drift
// dilution problem for unknown-change-point drifts, and sliding window
// dilutes the statistic even further. Page-CUSUM with mixture prior
// (Page 1954; Lorden 1971; Lai 1995, 2001) is the classical Page-1954
// reset-at-zero CUSUM with Gaussian mixture-prior log-likelihood-ratio
// update; per-deploy Bonferroni-corrected α via excursion theory (not
// anytime-valid Ville-bounded e-process; Howard-Ramdas-McAuliffe-Sekhon
// 2021 anytime-valid variants would use non-resetting mixture
// supermartingale or explicit betting-style e-process construction).
//
// REFACTOR (god-file split): the implementation now lives in cohesive
// sibling modules; this file is a facade that re-exports the EXACT public
// surface so every legacy import path keeps working:
//
//   _page-cusum-types.ts   — shared types/constants (CUSUMState, ...)
//   _page-cusum-core.ts    — classical reset-at-zero CUSUM core
//   _page-cusum-params.ts  — cell matching + per-signal param resolution
//   _page-cusum-shadow.ts  — per-tick shadow evaluators + dispatch wrapper
//
// Math, gating, and emitted verdicts are VERBATIM from the pre-split file;
// no statistical behavior changed. See the submodules for the per-tick
// math and reset/suppression semantics.

// Q2.B.5: Page-CUSUM no longer applies the Q2.A forward transform at
// runtime; consumes raw-space σ² from `empirical_variance_raw`. The
// signal-classes import is retained as a no-op for now in case a future
// revision needs it (and to keep the import-graph stable for downstream
// consumers).
import { transformForClass as _transformForClass } from '@johnpatrickwarren-oss/deploysignal-engine/signal-classes';
void _transformForClass;

export type { CUSUMState, CUSUMStates, CUSUMInput } from './_page-cusum-types';

export {
  freshCUSUM,
  getOrCreateCUSUM,
  updateCUSUM,
  evaluateCUSUM,
} from './_page-cusum-core';

export {
  FAMILY_A_PRIMARY_SIGNALS,
  lookupCellParams,
  trafficGateMin,
} from './_page-cusum-params';

export type { MixtureSupermartingaleStates } from './_page-cusum-shadow';
export {
  evaluateFamilyAShadow,
  evaluateFamilyAShadowMixture,
  evaluateFamilyA,
} from './_page-cusum-shadow';
