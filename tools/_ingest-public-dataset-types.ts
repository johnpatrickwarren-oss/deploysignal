// tools/_ingest-public-dataset-types.ts — Q60 Slice 1 public-dataset
// ingestion: shared types + constants (extracted verbatim from
// tools/ingest-public-dataset.ts during a behavior-preserving split).

import type { BaselineProvenance } from '../engine/types';

export type SupportedDataset =
  | 'burstgpt'
  | 'azure_llm_inference'
  | 'mooncake'
  // Q62 Slice 2 H1 (HF-only narrowing per architect H1 disposition).
  | 'huggingface_lmsys_arena';

/** Caller-supplied caveat options forwarded to mappers. */
export interface CaveatOpts {
  /** BurstGPT pricing multiplier (V1 A1: required for cost_req
   *  derivation; without this, BurstGPT signal_series stays empty). */
  tokens_to_cost_per_request?: (
    request_tokens: number, response_tokens: number,
  ) => number;
  /** Tick cadence in seconds; default 5. */
  tick_seconds?: number;
  /** Synthetic tenant_id override (Azure + Mooncake aggregate by
   *  default; BurstGPT 'burstgpt-aggregate' default per V1 A1). */
  tenant_id?: string;
  // ── Q62 Slice 2 H1 caveat options (HF-only) ───────────────────────
  /** HuggingFace LMSYS Arena: model-family segmentation
   *  (gpt-3.5/gpt-4/claude-3/all). */
  model_segment?: 'gpt-3.5' | 'gpt-4' | 'claude-3' | 'all';
  /** HuggingFace LMSYS Arena: reject judge-tie rows (default true). */
  reject_judge_disagreement?: boolean;
  /** HuggingFace LMSYS Arena: per-model pricing function. */
  hf_tokens_to_cost_per_request?: (
    model: string, prompt_tokens: number, response_tokens: number,
  ) => number;
}

export interface IngestPublicDatasetOpts {
  dataset: SupportedDataset;
  /** Path to the raw dataset file (CSV for BurstGPT + Azure; JSONL
   *  for Mooncake). Resolved by caller; not bundled in repo. */
  rawDataPath: string;
  /** Output directory for the emitted baseline bundle (manifest.json
   *  + bundle.jsonl). Created if missing. */
  outputBaselineDir: string;
  caveatOpts?: CaveatOpts;
  /** Optional limit on the number of raw rows ingested. Useful for
   *  test-fixture mode + smoke testing on full datasets. Default:
   *  ingest all rows. */
  rowLimit?: number;
  /** C37 (2026-08-18): route BurstGPT to the v2 full-tick-range mapper. */
  burstgptV2?: boolean;
  /** C37: dataset-identity lines for the bundle README (URL, revision, sha256). */
  provenanceLines?: string[];
}

export const PROVENANCE_BY_DATASET: Record<SupportedDataset, BaselineProvenance> = {
  burstgpt: 'real_burstgpt',
  azure_llm_inference: 'real_azure_llm_inference',
  mooncake: 'real_mooncake',
  huggingface_lmsys_arena: 'real_huggingface_lmsys_arena',
};

/** Family C signal vector (matches engine/detectors/hotelling.ts +
 *  tools/build-report-card.js). Used for manifest emission so the
 *  produced baseline bundle interoperates with calibrate.ts +
 *  build-report-card.js consumers. */
export const FAMILY_C_SIGNALS = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
  'corpus_delta', 'traffic_pct',
];

export const FAMILY_A_ONLY_SIGNALS = ['eval_score', 'tool_success_rate', 'refusal_rate', 'output_len_p50'];

export const ALL_SIGNALS = [...FAMILY_C_SIGNALS, ...FAMILY_A_ONLY_SIGNALS];

export interface BaselineManifest {
  version: string;
  generated_at: string;
  seed: number;
  cell_dim: 'hour_of_day' | 'hour_of_day_x_day_of_week' | null;
  n_runs: number;
  ticks_per_run: number;
  tenants: number;
  signals: string[];
  baseline_provenance: BaselineProvenance;
  caveat_filters_applied: string[];
}
