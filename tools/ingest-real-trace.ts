// tools/ingest-real-trace.ts — REPLY-52 D2 real-data schema-map layer.
//
// Per-source mapping functions that translate raw third-party trace
// rows into DS's per-run signal_series shape (same format as
// synthetic-v1 bundles). Structural translation only — NO runtime
// dataset integration here (datasets live outside the repo; caller
// feeds pre-parsed rows). Caveat-filtering baked into the mapping
// per REPLY-52 §D2 (service_error filtering, model-version
// segmentation, Mooncake 1-hour window constraints).
//
// Design invariants:
//   - Pure functions on pre-parsed row arrays; no file I/O on raw
//     trace data. (Callers handle file reads with their own
//     source-appropriate parser.)
//   - Each source maps to a BundleRun shape: tenant_id +
//     signal_series + (hour_of_day[] + day_of_week[]) parallel
//     arrays. Consumer feeds BundleRun[] to gen-synthetic-baseline
//     style emitter.
//   - grounded_synthetic source derives cost_req + quality signals
//     from raw tokens × pricing × judge-model distributions; flagged
//     via CompiledConfig.baseline_provenance='grounded_synthetic'.
//
// This module is a re-export barrel: the per-source mappers were
// split into cohesive sibling modules (tools/_ingest-real-trace-*.ts)
// for maintainability. The public import surface here is unchanged —
// all types + functions remain importable from `tools/ingest-real-
// trace`.

import type { BaselineProvenance } from '../engine/types';

export type { BundleRun, IngestReport } from './_ingest-real-trace-types.js';

export type {
  BurstGPTRawRow,
  BurstGPTIngestOpts,
} from './_ingest-real-trace-burstgpt.js';
export { mapBurstGPTRows } from './_ingest-real-trace-burstgpt.js';

export type { AzureLLMRawRow } from './_ingest-real-trace-azure.js';
export { mapAzureLLMRows } from './_ingest-real-trace-azure.js';

export type { MooncakeRawRow } from './_ingest-real-trace-mooncake.js';
export { mapMooncakeRows } from './_ingest-real-trace-mooncake.js';

export type { GroundedSyntheticInputs } from './_ingest-real-trace-grounded.js';
export { mapGroundedSyntheticOverlay } from './_ingest-real-trace-grounded.js';

export type {
  HuggingFaceLMSYSArenaRawRow,
  HuggingFaceLMSYSArenaIngestOpts,
} from './_ingest-real-trace-huggingface.js';
export { mapHuggingFaceLMSYSArenaRows } from './_ingest-real-trace-huggingface.js';

/** Source identifiers matching CompiledConfig.baseline_provenance.
 *  Exported for CLI dispatch + test coverage. */
export const SUPPORTED_SOURCES: BaselineProvenance[] = [
  'real_burstgpt',
  'real_azure_llm_inference',
  'real_mooncake',
  'grounded_synthetic',
  // Q62 Slice 2 H1 (HF-only narrowing per architect H1 disposition;
  // real_alpaserve + real_deepspeed_fastgen DROPPED post Q62 LS-1
  // schema-drift CRITICAL on both datasets; tagged Phase-3.d Slice 2.b).
  'real_huggingface_lmsys_arena',
];
