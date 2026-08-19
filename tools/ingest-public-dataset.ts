// tools/ingest-public-dataset.ts — Q60 Slice 1 public-dataset
// ingestion orchestrator.
//
// Per Q60 spec § Q60.2 + § Implementation surface (V1 + V2 amendments).
// Wraps the existing schema-map mappers in tools/ingest-real-trace.ts
// (mapBurstGPTRows + mapAzureLLMRows + mapMooncakeRows +
// mapGroundedSyntheticOverlay) with raw-file parsing + baseline-bundle
// emission so callers can drive `node tools/calibrate.ts --baseline
// runs/baselines/real-<dataset>-v1/` against ingested real-data
// substrates.
//
// Anti-scope (per Q60 spec):
//   - NO new schema-map mappers (Slice 1; HuggingFace + research-paper
//     traces deferred to Slice 2).
//   - NO live customer telemetry; raw datasets live OUTSIDE the repo
//     at caller-supplied paths (Open Q #1; baseline-bundle output IS
//     committable).
//   - NO modification to v5-sequential-e-process.json production
//     validation substrate.
//
// Phase-1.2 schema-drift normalization (architect-required at V1
// disposition, post-Mac-Claude-2 acquisition probe):
//   - BurstGPT actual CSV header: `Timestamp,Model,Request tokens,
//     Response tokens,Total tokens,Log Type` (V1 A1 cost_req-only
//     mapper rewrite handles this).
//   - Azure actual CSV header: `TIMESTAMP,ContextTokens,
//     GeneratedTokens` (mapper accepts both shapes via field-aliasing).
//   - Mooncake actual JSONL: `timestamp` (no `_ms` suffix);
//     `hash_ids: number[]` (mapper accepts both shapes via aliasing).
//
// Behavior-preserving split note: the raw-file parsers, baseline-bundle
// emitter, shared types/constants, and CLI arg-parser were extracted
// verbatim into sibling tools/_ingest-public-dataset-*.ts modules. The
// public import surface of this entrypoint (SupportedDataset, CaveatOpts,
// IngestPublicDatasetOpts, ingestPublicDataset) is unchanged and the CLI
// remains runnable.

import {
  mapBurstGPTRows, mapBurstGPTRowsV2, mapAzureLLMRows, mapMooncakeRows,
  mapHuggingFaceLMSYSArenaRows,
  type BundleRun, type IngestReport,
} from './ingest-real-trace.js';

import {
  type SupportedDataset, type CaveatOpts, type IngestPublicDatasetOpts,
  PROVENANCE_BY_DATASET,
} from './_ingest-public-dataset-types.js';
import {
  parseBurstGPTCsv, parseAzureLLMCsv, parseMooncakeJsonl,
  parseHuggingFaceLMSYSArenaCsv,
} from './_ingest-public-dataset-parsers.js';
import { emitBaselineBundle } from './_ingest-public-dataset-emit.js';
import { parseArgs } from './_ingest-public-dataset-cli.js';

// Re-export the public type surface so existing importers of
// `tools/ingest-public-dataset` keep resolving these names unchanged.
export type { SupportedDataset, CaveatOpts, IngestPublicDatasetOpts };

// ── Main orchestrator ────────────────────────────────────────────

export function ingestPublicDataset(opts: IngestPublicDatasetOpts): IngestReport {
  const { dataset, rawDataPath, outputBaselineDir, rowLimit } = opts;
  const caveatOpts = opts.caveatOpts ?? {};

  let run: BundleRun;
  let filtersApplied: string[];

  if (dataset === 'burstgpt') {
    const rows = parseBurstGPTCsv(rawDataPath, rowLimit);
    // C37 (2026-08-18): --burstgpt-v2 routes to the full-tick-range mapper.
    const mapper = opts.burstgptV2 ? mapBurstGPTRowsV2 : mapBurstGPTRows;
    const result = mapper(rows, {
      tick_seconds: caveatOpts.tick_seconds,
      tenant_id: caveatOpts.tenant_id,
      tokens_to_cost_per_request: caveatOpts.tokens_to_cost_per_request,
    });
    run = result.run;
    filtersApplied = result.filters_applied;
  } else if (dataset === 'azure_llm_inference') {
    const rows = parseAzureLLMCsv(rawDataPath, rowLimit);
    const result = mapAzureLLMRows(rows, {
      tick_seconds: caveatOpts.tick_seconds,
      tenant_id: caveatOpts.tenant_id,
    });
    run = result.run;
    filtersApplied = result.filters_applied;
  } else if (dataset === 'mooncake') {
    const rows = parseMooncakeJsonl(rawDataPath, rowLimit);
    const result = mapMooncakeRows(rows, {
      tick_seconds: caveatOpts.tick_seconds,
      tenant_id: caveatOpts.tenant_id,
    });
    run = result.run;
    filtersApplied = result.filters_applied;
  } else if (dataset === 'huggingface_lmsys_arena') {
    const rows = parseHuggingFaceLMSYSArenaCsv(rawDataPath, rowLimit);
    const result = mapHuggingFaceLMSYSArenaRows(rows, {
      model_segment: caveatOpts.model_segment,
      reject_judge_disagreement: caveatOpts.reject_judge_disagreement,
      tokens_to_cost_per_request: caveatOpts.hf_tokens_to_cost_per_request,
      tick_seconds: caveatOpts.tick_seconds,
      tenant_id: caveatOpts.tenant_id,
    });
    run = result.run;
    filtersApplied = result.filters_applied;
  } else {
    throw new Error(
      `Unsupported dataset: ${dataset}. Supported: burstgpt | azure_llm_inference | mooncake `
      + '| huggingface_lmsys_arena (Q62 Slice 2 H1; alpaserve + deepspeed_fastgen DROPPED at H1).',
    );
  }

  emitBaselineBundle(outputBaselineDir, [run], {
    baseline_provenance: PROVENANCE_BY_DATASET[dataset],
    caveat_filters_applied: filtersApplied,
    tick_seconds: caveatOpts.tick_seconds ?? 5,
    version: opts.burstgptV2 ? `${PROVENANCE_BY_DATASET[dataset]}-v2` : undefined,
    provenance_lines: opts.provenanceLines,
  });

  // Compute total ticks for the report.
  let nTicksTotal = 0;
  for (const sig of Object.keys(run.signal_series)) {
    if (run.signal_series[sig].length > nTicksTotal) {
      nTicksTotal = run.signal_series[sig].length;
    }
  }

  return {
    source: PROVENANCE_BY_DATASET[dataset],
    n_runs: 1,  // single aggregate run per dataset; tenant-segmentation deferred to Slice 2
    n_ticks_total: nTicksTotal,
    signals_populated: Object.keys(run.signal_series),
    filters_applied: filtersApplied,
  };
}

// ── CLI entrypoint ───────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const caveatOpts: CaveatOpts = {};
  if (args.costPerInputToken !== undefined && args.costPerOutputToken !== undefined) {
    const cIn = args.costPerInputToken;
    const cOut = args.costPerOutputToken;
    // BurstGPT 2-arg signature (request_tokens, response_tokens).
    caveatOpts.tokens_to_cost_per_request = (req, res) => req * cIn + res * cOut;
    // HF 3-arg signature (model, prompt_tokens, response_tokens) — same
    // pricing model; HF mapper uses this distinct entry per CaveatOpts.
    caveatOpts.hf_tokens_to_cost_per_request = (_model, prompt, response) => prompt * cIn + response * cOut;
  }
  console.log(`[ingest-public-dataset] dataset=${args.dataset} raw=${args.rawDataPath}`);
  const report = ingestPublicDataset({
    dataset: args.dataset,
    rawDataPath: args.rawDataPath,
    outputBaselineDir: args.outputBaselineDir,
    caveatOpts,
    rowLimit: args.rowLimit,
    burstgptV2: args.burstgptV2,
    provenanceLines: args.provenanceLine,
  });
  console.log(`[ingest-public-dataset]   source=${report.source}`);
  console.log(`[ingest-public-dataset]   n_runs=${report.n_runs} n_ticks_total=${report.n_ticks_total}`);
  console.log(`[ingest-public-dataset]   signals_populated=${report.signals_populated.join(',')}`);
  console.log(`[ingest-public-dataset]   filters_applied=`);
  for (const f of report.filters_applied) console.log(`[ingest-public-dataset]     - ${f}`);
  console.log(`[ingest-public-dataset] wrote ${args.outputBaselineDir}`);
}

// Auto-run main() in CLI mode only (not when imported as a module
// from tests). Guard on `--dataset` flag presence so the check is
// independent of module system (CJS vs ESM). Mirrors the pattern in
// tools/calibrate.ts.
if (process.argv.some((a) => a === '--dataset')) {
  main();
}
