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

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  mapBurstGPTRows, mapAzureLLMRows, mapMooncakeRows,
  mapHuggingFaceLMSYSArenaRows,
  type BurstGPTRawRow, type AzureLLMRawRow, type MooncakeRawRow,
  type HuggingFaceLMSYSArenaRawRow,
  type BundleRun, type IngestReport,
} from './ingest-real-trace.js';
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
}

const PROVENANCE_BY_DATASET: Record<SupportedDataset, BaselineProvenance> = {
  burstgpt: 'real_burstgpt',
  azure_llm_inference: 'real_azure_llm_inference',
  mooncake: 'real_mooncake',
  huggingface_lmsys_arena: 'real_huggingface_lmsys_arena',
};

/** Family C signal vector (matches engine/detectors/hotelling.ts +
 *  tools/build-report-card.js). Used for manifest emission so the
 *  produced baseline bundle interoperates with calibrate.ts +
 *  build-report-card.js consumers. */
const FAMILY_C_SIGNALS = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
  'corpus_delta', 'traffic_pct',
];

const FAMILY_A_ONLY_SIGNALS = ['eval_score', 'tool_success_rate', 'refusal_rate', 'output_len_p50'];

const ALL_SIGNALS = [...FAMILY_C_SIGNALS, ...FAMILY_A_ONLY_SIGNALS];

// ── Raw-file parsers ─────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  // Minimal CSV split — handles unquoted fields. Real datasets here
  // (BurstGPT + Azure) don't use quoted fields with commas, so the
  // simple split is correct.
  return line.split(',').map((s) => s.trim());
}

function parseBurstGPTCsv(filePath: string, rowLimit?: number): BurstGPTRawRow[] {
  // Schema: Timestamp,Model,Request tokens,Response tokens,Total tokens,Log Type
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n').filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]);
  const idx = {
    timestamp: header.indexOf('Timestamp'),
    model: header.indexOf('Model'),
    requestTokens: header.indexOf('Request tokens'),
    responseTokens: header.indexOf('Response tokens'),
    totalTokens: header.indexOf('Total tokens'),
    logType: header.indexOf('Log Type'),
  };
  if (idx.timestamp < 0 || idx.requestTokens < 0 || idx.responseTokens < 0) {
    throw new Error(
      `BurstGPT CSV header missing required columns: ${JSON.stringify(header)}. `
      + 'Expected Timestamp + Request tokens + Response tokens at minimum.',
    );
  }
  const rows: BurstGPTRawRow[] = [];
  const limit = rowLimit ?? lines.length;
  for (let i = 1; i < lines.length && rows.length < limit; i++) {
    const f = parseCsvLine(lines[i]);
    rows.push({
      timestamp_s: parseFloat(f[idx.timestamp]),
      model: idx.model >= 0 ? f[idx.model] : undefined,
      request_tokens: parseInt(f[idx.requestTokens], 10),
      response_tokens: parseInt(f[idx.responseTokens], 10),
      total_tokens: idx.totalTokens >= 0 ? parseInt(f[idx.totalTokens], 10) : undefined,
      log_type: idx.logType >= 0 ? f[idx.logType] : undefined,
    });
  }
  return rows;
}

function parseAzureLLMCsv(filePath: string, rowLimit?: number): AzureLLMRawRow[] {
  // Schema: TIMESTAMP,ContextTokens,GeneratedTokens
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n').filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]);
  const idx = {
    timestamp: header.indexOf('TIMESTAMP'),
    contextTokens: header.indexOf('ContextTokens'),
    generatedTokens: header.indexOf('GeneratedTokens'),
  };
  if (idx.timestamp < 0 || idx.generatedTokens < 0) {
    throw new Error(
      `Azure LLM CSV header missing required columns: ${JSON.stringify(header)}. `
      + 'Expected TIMESTAMP + GeneratedTokens at minimum.',
    );
  }
  const rows: AzureLLMRawRow[] = [];
  const limit = rowLimit ?? lines.length;
  for (let i = 1; i < lines.length && rows.length < limit; i++) {
    const f = parseCsvLine(lines[i]);
    rows.push({
      // Pass raw CamelCase fields; mapAzureLLMRows normalizes via
      // Phase-1.2 field-aliasing (parseAzureTimestamp handles ISO
      // datetime parsing).
      TIMESTAMP: f[idx.timestamp],
      ContextTokens: idx.contextTokens >= 0 ? parseInt(f[idx.contextTokens], 10) : 0,
      GeneratedTokens: parseInt(f[idx.generatedTokens], 10),
    });
  }
  return rows;
}

function parseMooncakeJsonl(filePath: string, rowLimit?: number): MooncakeRawRow[] {
  // Each line is a JSON object: {"timestamp": ..., "input_length": ...,
  // "output_length": ..., "hash_ids": [...]}
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n').filter((l) => l.trim().length > 0);
  const rows: MooncakeRawRow[] = [];
  const limit = rowLimit ?? lines.length;
  for (let i = 0; i < lines.length && rows.length < limit; i++) {
    const obj = JSON.parse(lines[i]);
    rows.push({
      timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : undefined,
      timestamp_ms: typeof obj.timestamp_ms === 'number' ? obj.timestamp_ms : undefined,
      input_length: obj.input_length ?? 0,
      output_length: obj.output_length ?? 0,
      hash_ids: Array.isArray(obj.hash_ids) ? obj.hash_ids : [],
    });
  }
  return rows;
}

// ── Q62 Slice 2 H1 raw-file parser (HF-only) ─────────────────────

/** RFC-4180 CSV streaming record parser via per-row callback. Handles
 *  quoted fields with embedded commas + newlines + escaped double-
 *  quotes (`""`). Streams per-record via callback to avoid 176MB+
 *  whole-file allocation on large datasets like HF LMSYS Arena
 *  train.csv (lmsys-arena-human-preference-55k 57k rows × ~3KB each).
 *  Caller returns false to short-circuit (e.g., when rowLimit reached). */
function streamRfc4180Records(filePath: string, onRecord: (row: string[]) => boolean): void {
  const buf = Buffer.alloc(64 * 1024);  // 64KB read chunks
  const fd = fs.openSync(filePath, 'r');
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let prevWasQuote = false;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      const chunk = buf.toString('utf8', 0, bytesRead);
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (inQuotes) {
          if (ch === '"') {
            // Possible escaped quote — peek next char.
            if (i + 1 < chunk.length) {
              if (chunk[i + 1] === '"') {
                cell += '"';
                i++;
              } else {
                inQuotes = false;
              }
            } else {
              // Quote at chunk boundary: defer decision to next chunk.
              prevWasQuote = true;
            }
          } else if (prevWasQuote) {
            // Previous chunk ended on a quote in inQuotes; this char
            // resolves it. If this char is also " → escaped quote.
            if (ch === '"') {
              cell += '"';
            } else {
              inQuotes = false;
              i--;  // re-process this char in the !inQuotes branch
            }
            prevWasQuote = false;
          } else {
            cell += ch;
          }
        } else {
          if (ch === '"') {
            inQuotes = true;
          } else if (ch === ',') {
            row.push(cell);
            cell = '';
          } else if (ch === '\n' || ch === '\r') {
            // CRLF: skip the \n if previous was \r and we're at chunk boundary.
            if (ch === '\r' && i + 1 < chunk.length && chunk[i + 1] === '\n') i++;
            row.push(cell);
            cell = '';
            if (row.length > 1 || row[0] !== '') {
              if (!onRecord(row)) return;
            }
            row = [];
          } else {
            cell += ch;
          }
        }
      }
    }
    // Final cell + row (no trailing newline).
    if (cell.length > 0 || row.length > 0) {
      row.push(cell);
      if (row.length > 1 || row[0] !== '') {
        onRecord(row);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** HuggingFace LMSYS Arena CSV parser (post-Q62 LS-1 schema-drift
 *  H1 redraft). Expected format: CSV with header
 *  `id,model_a,model_b,prompt,response_a,response_b,winner_model_a,
 *  winner_model_b,winner_tie` (verified empirically at
 *  lmsys/lmsys-arena-human-preference-55k train.csv 176MB; per Q62 LS-1
 *  Phase 1.2 schema-drift diagnostic). */
function parseHuggingFaceLMSYSArenaCsv(
  filePath: string, rowLimit?: number,
): HuggingFaceLMSYSArenaRawRow[] {
  const rows: HuggingFaceLMSYSArenaRawRow[] = [];
  const limit = rowLimit ?? Infinity;
  let header: string[] | null = null;
  let idx: Record<string, number> = {};
  streamRfc4180Records(filePath, (record) => {
    if (header === null) {
      header = record.map((s) => s.trim());
      idx = {
        id: header.indexOf('id'),
        model_a: header.indexOf('model_a'),
        model_b: header.indexOf('model_b'),
        prompt: header.indexOf('prompt'),
        response_a: header.indexOf('response_a'),
        response_b: header.indexOf('response_b'),
        winner_model_a: header.indexOf('winner_model_a'),
        winner_model_b: header.indexOf('winner_model_b'),
        winner_tie: header.indexOf('winner_tie'),
      };
      if (idx.winner_model_a < 0 || idx.winner_model_b < 0 || idx.winner_tie < 0
          || idx.prompt < 0 || idx.response_a < 0 || idx.response_b < 0) {
        throw new Error(
          `HuggingFace LMSYS Arena CSV header missing required columns: ${JSON.stringify(header)}. `
          + 'Expected id, model_a, model_b, prompt, response_a, response_b, winner_model_a, '
          + 'winner_model_b, winner_tie per lmsys-arena-human-preference-55k schema (Q62 LS-1 H1).',
        );
      }
      return true;  // continue
    }
    if (rows.length >= limit) return false;  // short-circuit
    rows.push({
      id: idx.id >= 0 ? record[idx.id] : '',
      model_a: record[idx.model_a],
      model_b: record[idx.model_b],
      prompt: record[idx.prompt],
      response_a: record[idx.response_a],
      response_b: record[idx.response_b],
      winner_model_a: parseInt(record[idx.winner_model_a], 10) === 1,
      winner_model_b: parseInt(record[idx.winner_model_b], 10) === 1,
      winner_tie: parseInt(record[idx.winner_tie], 10) === 1,
    });
    return rows.length < limit;
  });
  return rows;
}

// ── Baseline bundle emitter ──────────────────────────────────────

interface BaselineManifest {
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

function emitBaselineBundle(
  outputDir: string,
  bundleRuns: BundleRun[],
  meta: {
    baseline_provenance: BaselineProvenance;
    caveat_filters_applied: string[];
    tick_seconds: number;
  },
): void {
  fs.mkdirSync(outputDir, { recursive: true });

  // Compute n_runs + ticks_per_run from the runs (max length).
  let ticksPerRun = 0;
  const tenants = new Set<string>();
  for (const run of bundleRuns) {
    tenants.add(run.tenant_id);
    for (const sig of Object.keys(run.signal_series)) {
      const len = run.signal_series[sig].length;
      if (len > ticksPerRun) ticksPerRun = len;
    }
  }

  // Determine which signals are populated across the runs.
  const populatedSignals = new Set<string>();
  for (const run of bundleRuns) {
    for (const sig of Object.keys(run.signal_series)) {
      populatedSignals.add(sig);
    }
  }

  // Manifest.json: same shape as synthetic-v1 manifest.
  // Derive synthetic 168-cell hour_of_day_x_day_of_week mapping per
  // tick index when the upstream mapper hasn't already attached one.
  // Real-trace timestamps are elapsed-seconds anchored at trace start,
  // not wall-clock; the calibrator's diurnal cell partition is a sample-
  // bucketing aid (variance estimation across 168 cells), not a model of
  // real diurnality, so a synthetic anchor at Sunday 00:00:00 is
  // sufficient and consistent across substrates.
  const tickSeconds = meta.tick_seconds;
  for (const run of bundleRuns) {
    const len = Object.values(run.signal_series)[0]?.length ?? 0;
    if (!run.hour_of_day) {
      const hod = new Array<number>(len);
      const dow = new Array<number>(len);
      for (let t = 0; t < len; t++) {
        const sec = t * tickSeconds;
        hod[t] = Math.floor(sec / 3600) % 24;
        dow[t] = Math.floor(sec / 86400) % 7;
      }
      run.hour_of_day = hod;
      run.day_of_week = dow;
    }
  }

  const manifest: BaselineManifest = {
    version: `${meta.baseline_provenance}-v1`,
    generated_at: new Date().toISOString(),
    seed: 0,  // real-data ingestion is deterministic by source data
    cell_dim: 'hour_of_day_x_day_of_week',
    n_runs: bundleRuns.length,
    ticks_per_run: ticksPerRun,
    tenants: tenants.size,
    signals: ALL_SIGNALS,  // canonical signal-set; populated subset stamped via signal_series
    baseline_provenance: meta.baseline_provenance,
    caveat_filters_applied: meta.caveat_filters_applied,
  };
  fs.writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  // bundle.jsonl: one JSON object per run.
  const lines = bundleRuns.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(path.join(outputDir, 'bundle.jsonl'), lines + '\n');

  // README.md: provenance + caveats note.
  const readme = `# Real-data baseline bundle: ${meta.baseline_provenance}\n\n`
    + `Generated: ${manifest.generated_at}\n\n`
    + `Source: Q60 Slice 1 ingestion via tools/ingest-public-dataset.ts.\n\n`
    + `## Caveat filters applied\n\n`
    + meta.caveat_filters_applied.map((f) => `- ${f}`).join('\n')
    + `\n\n## Signals populated\n\n`
    + Array.from(populatedSignals).map((s) => `- ${s}`).join('\n')
    + '\n';
  fs.writeFileSync(path.join(outputDir, 'README.md'), readme);
}

// ── Main orchestrator ────────────────────────────────────────────

export function ingestPublicDataset(opts: IngestPublicDatasetOpts): IngestReport {
  const { dataset, rawDataPath, outputBaselineDir, rowLimit } = opts;
  const caveatOpts = opts.caveatOpts ?? {};

  let run: BundleRun;
  let filtersApplied: string[];

  if (dataset === 'burstgpt') {
    const rows = parseBurstGPTCsv(rawDataPath, rowLimit);
    const result = mapBurstGPTRows(rows, {
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

interface CliArgs {
  dataset: SupportedDataset;
  rawDataPath: string;
  outputBaselineDir: string;
  rowLimit?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--dataset':
        if (v !== 'burstgpt' && v !== 'azure_llm_inference' && v !== 'mooncake'
            && v !== 'huggingface_lmsys_arena') {
          throw new Error(
            `--dataset must be one of: burstgpt | azure_llm_inference | mooncake | `
            + `huggingface_lmsys_arena (Q62 Slice 2 H1; alpaserve + deepspeed_fastgen DROPPED); got ${v}`,
          );
        }
        out.dataset = v;
        i++;
        break;
      case '--raw-data-path':
        out.rawDataPath = v;
        i++;
        break;
      case '--output-baseline-dir':
        out.outputBaselineDir = v;
        i++;
        break;
      case '--row-limit':
        out.rowLimit = parseInt(v, 10);
        i++;
        break;
      case '--cost-per-input-token':
        out.costPerInputToken = parseFloat(v);
        i++;
        break;
      case '--cost-per-output-token':
        out.costPerOutputToken = parseFloat(v);
        i++;
        break;
      default:
        if (k.startsWith('--')) throw new Error(`Unknown flag: ${k}`);
    }
  }
  if (!out.dataset || !out.rawDataPath || !out.outputBaselineDir) {
    throw new Error(
      'Required flags: --dataset {burstgpt|azure_llm_inference|mooncake} '
      + '--raw-data-path <path> --output-baseline-dir <dir>. '
      + 'Optional: --row-limit <N> --cost-per-input-token <usd> '
      + '--cost-per-output-token <usd> (BurstGPT cost_req derivation).',
    );
  }
  return out as CliArgs;
}

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
