// tools/recalibrate.ts — Addition #15 baseline-maintenance lifecycle CLI
// (slim facade, matching the tools/calibrate.ts / tools/run-shadow-
// compare.ts pattern: public re-exports + an argv-gated auto-run main()).
//
// CLI:
//   node tools/recalibrate.ts init --service <id> [--root <dir>] \
//     [--timeout-days 14] [--unchanged-epsilon-rel 0.01]
//   node tools/recalibrate.ts propose --service <id> \
//     --candidate-id <id> --candidate-config <path.json> \
//     --creation-reason drift_detected|calendar_safety_net|operator_manual \
//     --source-window-start <iso> --source-window-end <iso> \
//     --source-window-samples <n> [--drift-output <path.json>] [--now <iso>]
//   node tools/recalibrate.ts refresh --service <id> --bundle-dir <dir> \
//     [--window trailing-<Nd> | --window-start <iso> --window-end <iso> | --full-bundle] \
//     [--alpha <x>] [--families A,B,C,D,E] [--candidate-id <id>] \
//     [--creation-reason operator_manual|calendar_safety_net] [--out-dir <dir>] \
//     [--now <iso>] [--dry-run] [--root <dir>]
//   node tools/recalibrate.ts shadow --service <id> --candidate-id <id> \
//     --scenarios <s1,s2,...> --seeds <42,43,...> [--output-dir <dir>] \
//     [--dry-run] [--baseline-dir <dir>] [--now <iso>]
//   node tools/recalibrate.ts list --service <id> [--now <iso>]
//   node tools/recalibrate.ts show --service <id> --candidate-id <id>
//   node tools/recalibrate.ts approve --service <id> --candidate-id <id> \
//     --reviewer <id> --reason-code <code> [--now <iso>]
//   node tools/recalibrate.ts reject --service <id> --candidate-id <id> \
//     --reviewer <id> --reason-code <code> [--now <iso>]
//   node tools/recalibrate.ts check --service <id> [--now <iso>]
//   node tools/recalibrate.ts rollback --service <id> --version <id> \
//     --reviewer <id> --reason-code <code> [--now <iso>]
//
// `shadow` (Task 9, tools/recalibrate/_recalibrate-shadow.ts) wraps the
// EXISTING tools/run-shadow-compare.ts Q60 orchestrator with active +
// candidate SubstrateRefs; 'reviewable' is reachable ONLY via that path.

export {
  runInit, runPropose, runShadow, runList, runShow, runApprove, runReject, runCheck, runRollback,
  parseArgv, main, USAGE_TEXT,
} from './recalibrate/_recalibrate-cli';
export type {
  HandlerResult, InitArgs, ProposeArgs, ShadowArgs, DecisionArgs, RollbackArgs, ParsedArgv,
} from './recalibrate/_recalibrate-cli';
export {
  RecalibrationStore, JsonlLifecycleEventEmitter, RecalibrationStoreSchemaError,
} from './recalibrate/_recalibrate-store';
export type {
  StoreMeta, ActivePointer, PromotionEntry, ExclusionWindow, StoredEvent, InitOptions, PromoteOptions,
} from './recalibrate/_recalibrate-store';
export { sweepTimeouts, checkCalendarSafetyNet } from './recalibrate/_recalibrate-sweep';
export type { SweepResult, CalendarSafetyNetResult } from './recalibrate/_recalibrate-sweep';
export { buildProposedCandidate } from './recalibrate/_recalibrate-candidate';
export type { ProposeInput, ProposeOutcome, ProposeSourceWindow } from './recalibrate/_recalibrate-candidate';
export { runCandidateShadow } from './recalibrate/_recalibrate-shadow';
export type { RunCandidateShadowOptions, RunCandidateShadowResult } from './recalibrate/_recalibrate-shadow';
// R2 Task 8 — `refresh` (Task 7 orchestrator) + Task 6's pure selection
// module public surface.
export { runRefresh } from './recalibrate/_recalibrate-refresh';
export type { RefreshArgs } from './recalibrate/_recalibrate-refresh';
export { resolveWindow, selectBundleWindow } from './recalibrate/_recalibrate-refresh-select';
export type {
  RefreshWindow, SelectionReport, ExcludedSpanReport,
} from './recalibrate/_recalibrate-refresh-select';

import { main } from './recalibrate/_recalibrate-cli';

const RECALIBRATE_SUBCOMMANDS = ['init', 'propose', 'refresh', 'shadow', 'list', 'show', 'approve', 'reject', 'check', 'rollback'];
if (RECALIBRATE_SUBCOMMANDS.includes(process.argv[2])) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
