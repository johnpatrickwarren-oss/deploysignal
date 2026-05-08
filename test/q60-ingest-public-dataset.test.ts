// test/q60-ingest-public-dataset.test.ts — Q60 Slice 1 Phase 1
// public-dataset ingestion orchestrator tests. Per Q60 spec § Tests
// describe block 1.
//
// Sample fixtures inline (small CSVs/JSONL); full datasets stay
// external (~50MB BurstGPT + ~720KB Azure + ~4.4MB Mooncake at
// /Users/johnwarren/Desktop/q60-raw-data/) per spec § Anti-scope
// (NO bundled raw datasets in repo).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ingestPublicDataset } from '../tools/ingest-public-dataset';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'q60-ingest-test-'));
}

function writeFixture(content: string, ext: string): string {
  const f = path.join(tmpdir(), `fixture.${ext}`);
  fs.writeFileSync(f, content);
  return f;
}

// ── BurstGPT V1 A1 cost_req-only mapper ──────────────────────────

test('q60 ingestion: BurstGPT V1 A1 cost_req-only signal coverage', () => {
  const csv = [
    'Timestamp,Model,Request tokens,Response tokens,Total tokens,Log Type',
    '0,ChatGPT,100,50,150,API log',
    '6,ChatGPT,200,100,300,Conversation log',
    '12,ChatGPT,150,75,225,API log',
  ].join('\n');
  const fixturePath = writeFixture(csv, 'csv');
  const outDir = tmpdir();

  const report = ingestPublicDataset({
    dataset: 'burstgpt',
    rawDataPath: fixturePath,
    outputBaselineDir: outDir,
    caveatOpts: {
      tokens_to_cost_per_request: (req, res) => req * 0.00003 + res * 0.00006,
      tick_seconds: 5,
    },
  });

  assert.equal(report.source, 'real_burstgpt');
  // V1 A1: cost_req-only.
  assert.deepEqual(report.signals_populated, ['cost_req']);
  assert.ok(report.filters_applied.includes('burstgpt_v1_a1:cost_req_only_scope'));
  assert.ok(report.filters_applied.includes('burstgpt_no_p99_latency:elapsed_ms_field_absent_in_actual_csv'));

  // Manifest + bundle artifacts emitted.
  assert.ok(fs.existsSync(path.join(outDir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'bundle.jsonl')));
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.baseline_provenance, 'real_burstgpt');
  assert.equal(manifest.n_runs, 1);
  // 3 rows at timestamps 0,6,12 with tick_seconds=5 → 3 ticks
  // (tick 0 = [0,5), tick 1 = [5,10), tick 2 = [10,15)).
  assert.equal(manifest.ticks_per_run, 3);
});

test('q60 ingestion: BurstGPT without pricing multiplier → empty signal_series', () => {
  const csv = [
    'Timestamp,Model,Request tokens,Response tokens,Total tokens,Log Type',
    '0,ChatGPT,100,50,150,API log',
  ].join('\n');
  const report = ingestPublicDataset({
    dataset: 'burstgpt',
    rawDataPath: writeFixture(csv, 'csv'),
    outputBaselineDir: tmpdir(),
  });
  assert.equal(report.source, 'real_burstgpt');
  // No tokens_to_cost_per_request → cost_req not derived.
  assert.deepEqual(report.signals_populated, []);
  assert.ok(report.filters_applied.includes('burstgpt_no_pricing_multiplier:cost_req_undefined'));
});

// ── Azure LLM Inference (Phase-1.2 schema-drift normalization) ────

test('q60 ingestion: Azure LLM Inference parses CamelCase header + ISO timestamp', () => {
  const csv = [
    'TIMESTAMP,ContextTokens,GeneratedTokens',
    '2023-11-16 18:15:46.6805900,374,44',
    '2023-11-16 18:15:48.0000000,396,109',
    '2023-11-16 18:15:54.0000000,500,80',
  ].join('\n');
  const report = ingestPublicDataset({
    dataset: 'azure_llm_inference',
    rawDataPath: writeFixture(csv, 'csv'),
    outputBaselineDir: tmpdir(),
  });
  assert.equal(report.source, 'real_azure_llm_inference');
  // ContextTokens caveat: arrival-only; cost_req NEVER emitted.
  assert.deepEqual(report.signals_populated, ['tokens_turn']);
  assert.ok(report.filters_applied.includes('azure_context_tokens_arrival_only:drop_from_cost_req'));
});

// ── Mooncake (Phase-1.2 schema-drift normalization) ──────────────

test('q60 ingestion: Mooncake parses raw JSONL with `timestamp` + numeric hash_ids', () => {
  // Actual Mooncake JSONL schema (per Phase 1.1 acquisition probe).
  const jsonl = [
    JSON.stringify({ timestamp: 0,    input_length: 100, output_length: 50,
                     hash_ids: [0, 1, 2] }),
    JSON.stringify({ timestamp: 1000, input_length: 200, output_length: 100,
                     hash_ids: [0, 3, 1] }),
    JSON.stringify({ timestamp: 6000, input_length: 150, output_length: 75,
                     hash_ids: [4, 5, 6] }),
  ].join('\n');
  const report = ingestPublicDataset({
    dataset: 'mooncake',
    rawDataPath: writeFixture(jsonl, 'jsonl'),
    outputBaselineDir: tmpdir(),
  });
  assert.equal(report.source, 'real_mooncake');
  assert.ok(report.signals_populated.includes('kv_cache'));
  assert.ok(report.signals_populated.includes('tokens_turn'));
  assert.ok(report.filters_applied.includes('mooncake_window:1hour_single'));
  assert.ok(report.filters_applied.includes('mooncake_scope:family_b_kv_cache_only_not_family_d'));
});

// ── Bundle output shape ──────────────────────────────────────────

test('q60 ingestion: emits manifest.json + bundle.jsonl + README.md', () => {
  const csv = [
    'Timestamp,Model,Request tokens,Response tokens,Total tokens,Log Type',
    '0,ChatGPT,100,50,150,API log',
  ].join('\n');
  const outDir = tmpdir();
  ingestPublicDataset({
    dataset: 'burstgpt',
    rawDataPath: writeFixture(csv, 'csv'),
    outputBaselineDir: outDir,
    caveatOpts: {
      tokens_to_cost_per_request: () => 0.01,
    },
  });
  assert.ok(fs.existsSync(path.join(outDir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'bundle.jsonl')));
  assert.ok(fs.existsSync(path.join(outDir, 'README.md')));
});

// ── Row-limit ────────────────────────────────────────────────────

test('q60 ingestion: row-limit caps ingested rows', () => {
  const lines = ['Timestamp,Model,Request tokens,Response tokens,Total tokens,Log Type'];
  for (let i = 0; i < 100; i++) {
    lines.push(`${i * 6},ChatGPT,10,20,30,API log`);
  }
  const csv = lines.join('\n');
  const report = ingestPublicDataset({
    dataset: 'burstgpt',
    rawDataPath: writeFixture(csv, 'csv'),
    outputBaselineDir: tmpdir(),
    rowLimit: 10,
    caveatOpts: { tokens_to_cost_per_request: () => 0.01 },
  });
  // 10 rows × 6s spacing / 5s per tick = ~12 ticks (10 rows span 0..54s).
  assert.ok(report.n_ticks_total <= 15);  // upper-bound check
});

// ── Unsupported dataset ─────────────────────────────────────────

test('q60 ingestion: unknown dataset throws', () => {
  assert.throws(() => {
    ingestPublicDataset({
      // @ts-expect-error — testing the error path with an invalid dataset.
      dataset: 'unknown_dataset',
      rawDataPath: '/dev/null',
      outputBaselineDir: tmpdir(),
    });
  }, /Unsupported dataset/);
});
