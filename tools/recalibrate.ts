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
//   node tools/recalibrate.ts exclusions suggest --service <id> \
//     [--sessions-root runs/sessions] [--pad-minutes 30] [--now <iso>] [--root <dir>]
//   node tools/recalibrate.ts exclusions apply --service <id> \
//     (--ids i1,i2 | --all) --declared-by <id> [--now <iso>] [--root <dir>]
//   node tools/recalibrate.ts exclusions list --service <id> [--root <dir>]
//   node tools/recalibrate.ts soak start  --service <id> \
//     --candidate-id <id> --requested-by <id> [--target-ticks 200] \
//     [--max-duration-seconds <n>] [--root <dir>] [--now <iso>]
//   node tools/recalibrate.ts soak status --service <id> [--root <dir>] [--now <iso>]
//   node tools/recalibrate.ts soak stop   --service <id> \
//     --candidate-id <id> --reviewer <id> [--root <dir>] [--now <iso>]
//
// `shadow` (Task 9, tools/recalibrate/_recalibrate-shadow.ts) wraps the
// EXISTING tools/run-shadow-compare.ts Q60 orchestrator with active +
// candidate SubstrateRefs; 'reviewable' is reachable ONLY via that path.
//
// `exclusions` (R3, tools/recalibrate/_recalibrate-exclusions.ts +
// _recalibrate-exclusions-cli.ts) derives SUGGESTED exclusion windows
// from DeploySignal's OWN durable records (session store + this store's
// events.jsonl) — never an external incident feed (hard boundary,
// approved disposition). SUGGEST-ONLY: `suggest` only ever writes
// exclusion-suggestions.json; only `exclusions apply`, with an explicit
// operator `--declared-by`, promotes a suggestion into a real
// exclusion-windows.json entry the readiness gate enforces.
// `soak` (R5, tools/recalibrate/_recalibrate-soak.ts +
// _recalibrate-soak-cli.ts) drives a LIVE shadow soak of a candidate
// CompiledConfig against real traffic via service/gate-http's
// SoakController — ADDITIONAL evidence only (R-Q4: complements, never
// replaces, replay shadow validation; never gates reviewable).

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
export {
  soakManifestPath, soakSidecarPath, readSoakManifest, writeSoakManifest, readSoakSidecar,
  foldSoakEvidence, soakEvidenceLines, formatSoakSidecarSummary,
} from './recalibrate/_recalibrate-soak';
export {
  SOAK_USAGE_TEXT, runSoakStart, runSoakStatus, runSoakStop, soakMain,
} from './recalibrate/_recalibrate-soak-cli';
export type { SoakStartArgs, SoakStopArgs } from './recalibrate/_recalibrate-soak-cli';
// R2 Task 8 — `refresh` (Task 7 orchestrator) + Task 6's pure selection
// module public surface.
export { runRefresh } from './recalibrate/_recalibrate-refresh';
export type { RefreshArgs } from './recalibrate/_recalibrate-refresh';
export { resolveWindow, selectBundleWindow } from './recalibrate/_recalibrate-refresh-select';
export type {
  RefreshWindow, SelectionReport, ExcludedSpanReport,
} from './recalibrate/_recalibrate-refresh-select';
// R3 — exclusion-window inference public surface.
export {
  scanSessionStore, scanRecalEvents, mergeSuggestions, deriveSuggestedExclusions,
} from './recalibrate/_recalibrate-exclusions';
export type { SuggestedExclusion, DeriveExclusionsInput } from './recalibrate/_recalibrate-exclusions';
export {
  readSuggestionsFile, writeSuggestionsFile,
  runExclusionsSuggest, runExclusionsApply, runExclusionsList,
  EXCLUSIONS_USAGE_TEXT, exclusionsMain,
} from './recalibrate/_recalibrate-exclusions-cli';
export type { ExclusionsSuggestArgs, ExclusionsApplyArgs } from './recalibrate/_recalibrate-exclusions-cli';

import { main } from './recalibrate/_recalibrate-cli';

const RECALIBRATE_SUBCOMMANDS = ['init', 'propose', 'refresh', 'shadow', 'list', 'show', 'approve', 'reject', 'check', 'rollback', 'exclusions', 'soak'];
if (RECALIBRATE_SUBCOMMANDS.includes(process.argv[2])) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
