// tools/run-shadow-compare.ts — Q60 Slice 1 shadow-compare orchestrator.
//
// For each (substrate × scenario × seed) tuple, runs an FPR + TPR
// sweep via tools/build-report-card.js (--profile mode) and emits a
// per-(substrate × scenario × seed) checkpoint file at
// `runs/validation-reports/profile-report-cards/checkpoints/`. After
// all checkpoints complete, aggregates per-(substrate × scenario)
// report cards + cross-substrate diff + aggregate pitch summary.
//
// V2 incremental emission discipline (architect-required at
// ARCHITECT-REPLY-Q60-SLICE-1-PHASE-1-1-DISPOSITION-V2 §
// Architect-required addition): per-(substrate × scenario × seed)
// checkpoints emit at each completion (NOT batch-emit at end of
// sweep). Mid-sweep crash recovers by resuming from last incomplete
// checkpoint. Load-bearing for B4 Mac mini compute-target operational
// pattern (network disconnect mid-sweep + nohup + Tailscale + V2
// incremental emission); also benefits B1/B2/B3 alternates.
//
// Anti-scope (per Q60 spec):
//   - NO modification to engine/detectors/* runtime code
//     (preserves Q58 + Q59 ADR anti-scope).
//   - NO modification to v5 production validation substrate.
//   - NO new schema-map mappers (Slice 2 scope).
//
// ── Module layout (behavior-preserving split) ────────────────────
// This file was a 1223-line god-file; it now re-exports the public
// surface from cohesive sibling modules. Public exports and runtime
// behavior are unchanged. Importers of `tools/run-shadow-compare`
// continue to see the same names:
//   - _run-shadow-compare-types.ts        : shared types + constants
//   - _run-shadow-compare-exemptions.ts   : Q60/Q66/Q70 exemption logic
//   - _run-shadow-compare-checkpoints.ts  : checkpoint I/O + trial + aggregation
//   - _run-shadow-compare-diff.ts         : cross-substrate ΔFPR diff
//   - _run-shadow-compare-orchestrator.ts : runShadowCompare orchestrator
//   - _run-shadow-compare-cli.ts          : CLI arg parsing + main()

// ── Public re-exports (exact pre-split surface) ──────────────────

export type {
  SweepMode,
  SubstrateRef,
  ShadowCompareOpts,
  PerProfileReportCard,
  ShadowCompareReport,
} from './_run-shadow-compare-types';

export { isSweepModeCalibrationRegimeMatched } from './_run-shadow-compare-exemptions';

export { runShadowCompare } from './_run-shadow-compare-orchestrator';

// ── CLI entrypoint ───────────────────────────────────────────────

import { main } from './_run-shadow-compare-cli';

if (process.argv.some((a) => a === '--substrates')) {
  main();
}
