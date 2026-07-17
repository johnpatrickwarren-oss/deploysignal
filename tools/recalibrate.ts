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
// `shadow` is not available here — plan §C Task 9
// (tools/recalibrate/_recalibrate-shadow.ts) owns shadow-mode
// validation; 'reviewable' is reachable ONLY via that path.

export {
  runInit, runPropose, runList, runShow, runApprove, runReject, runCheck, runRollback,
  parseArgv, main, USAGE_TEXT,
} from './recalibrate/_recalibrate-cli';
export type {
  HandlerResult, InitArgs, ProposeArgs, DecisionArgs, RollbackArgs, ParsedArgv,
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

import { main } from './recalibrate/_recalibrate-cli';

const RECALIBRATE_SUBCOMMANDS = ['init', 'propose', 'list', 'show', 'approve', 'reject', 'check', 'rollback'];
if (RECALIBRATE_SUBCOMMANDS.includes(process.argv[2])) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
