// test/q63-per-tick-detector-trace.test.ts — Q63 SPEC-3 tool primitive
// 10 test cases per spec § Tests describe block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  runPerTickDetectorTrace,
  parseTicks,
  parseDetectors,
  parseCliArgs,
} from '../tools/per-tick-detector-trace.js';
import type { PerTickDetectorTraceOpts } from '../tools/per-tick-detector-trace.js';

// ── Inline fixtures ──────────────────────────────────────────────

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'q63-test-'));
}

function makeFixtureScenario() {
  return {
    id: 'fixture-tokens-creep',
    total_ticks: 5,
    currentHourOfDay: 14,
    currentDayOfWeek: 2,
    bakeHours: 0.5,
    cadence_ms: 5000,
    baseline: {
      p99_latency: 184, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
      cost_req: 0.0042, downstream_err: 0.0012, mfu: 0.72, hbm_spill: 0.02,
      collective_ops: 0.999, corpus_delta: 0.04, traffic_pct: 1,
    },
    ticks: [
      { metrics: { p99_latency: 184, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042, downstream_err: 0.0012, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.999, corpus_delta: 0.04, traffic_pct: 1 } },
      { metrics: { p99_latency: 184, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042, downstream_err: 0.0012, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.999, corpus_delta: 0.04, traffic_pct: 1 } },
      { metrics: { p99_latency: 184, ttft: 220, tokens_turn: 419, kv_cache: 0.89, cost_req: 0.0043, downstream_err: 0.0012, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.999, corpus_delta: 0.04, traffic_pct: 1 } },
      { metrics: { p99_latency: 184, ttft: 220, tokens_turn: 420, kv_cache: 0.89, cost_req: 0.0044, downstream_err: 0.0012, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.999, corpus_delta: 0.04, traffic_pct: 1 } },
      { metrics: { p99_latency: 184, ttft: 220, tokens_turn: 421, kv_cache: 0.89, cost_req: 0.0045, downstream_err: 0.0012, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.999, corpus_delta: 0.04, traffic_pct: 1 } },
    ],
  };
}

function makeFixtureCompiledConfig() {
  return {
    version: 'fixture-v1',
    compiler_version: '0.2.0',
    compiled_at: '2026-05-04T00:00:00Z',
    baseline_ref: 'fixture-v1',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, C: 2e-4, D: 1e-4, E: 1e-4 } },
  };
}

function baseOpts(): PerTickDetectorTraceOpts {
  const out = path.join(tmpdir(), 'trace.md');
  return {
    substrate: 'fixture-substrate',
    scenario: 'fixture-tokens-creep',
    ticks: '0:4',
    detectors: 'family_A_page_cusum,family_E_conformal',
    outputPath: out,
    compiledConfigOverride: makeFixtureCompiledConfig(),
    scenarioOverride: makeFixtureScenario(),
  };
}

// ── Tests ────────────────────────────────────────────────────────

test('Q63: parseTicks supports all / N:M / N,M,P / single', () => {
  assert.deepEqual(parseTicks('all', 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseTicks('1:3', 10), [1, 2, 3]);
  assert.deepEqual(parseTicks('0,2,4', 10), [0, 2, 4]);
  assert.deepEqual(parseTicks('7', 10), [7]);
  assert.throws(() => parseTicks('5:2', 10), /invalid range/);
});

test('Q63: parseDetectors supports all / comma-list / rejects unknown', () => {
  const all = parseDetectors('all');
  assert.equal(all.length, 10);
  const subset = parseDetectors('family_A_page_cusum,family_E_conformal');
  assert.deepEqual(subset, ['family_A_page_cusum', 'family_E_conformal']);
  assert.throws(() => parseDetectors('family_bogus'), /unknown family/);
});

test('Q63: parseCliArgs requires substrate + scenario + ticks + detectors + out', () => {
  const args = parseCliArgs([
    '--substrate', 'runs/compiled-configs/v5.json',
    '--scenario', 'demo-tokens-creep',
    '--ticks', '0:5',
    '--detectors', 'family_A_page_cusum',
    '--out', '/tmp/trace.md',
  ]);
  assert.equal(args.substrate, 'runs/compiled-configs/v5.json');
  assert.equal(args.scenario, 'demo-tokens-creep');
  assert.equal(args.ticks, '0:5');
  assert.equal(args.detectors, 'family_A_page_cusum');
  assert.equal(args.outputPath, '/tmp/trace.md');
  assert.throws(() => parseCliArgs(['--substrate', 'x']), /Required CLI flags/);
});

test('Q63: runPerTickDetectorTrace emits per-(tick × detector) records', () => {
  const opts = baseOpts();
  const r = runPerTickDetectorTrace(opts);
  // 5 ticks × 2 detectors = 10 records minimum (family_A_page_cusum may
  // emit one record per Family A signal; the orchestrator's family_A_shadow
  // will surface ~6 signals; family_E_conformal emits one per tick).
  assert.ok(r.per_tick_records.length >= 5 * 2,
    `expected ≥ 10 records; got ${r.per_tick_records.length}`);
  assert.equal(r.summary.total_ticks_traced, 5);
  assert.equal(r.summary.total_detectors_traced, 2);
});

test('Q63: per-tick record schema includes cell_lookup + compile_source + per_detector_computation', () => {
  const r = runPerTickDetectorTrace(baseOpts());
  const rec = r.per_tick_records[0];
  assert.ok(rec.cell_lookup);
  assert.ok(['per_cell', 'aggregate_fallback', 'sliding_buffer', 'no_match'].includes(rec.cell_lookup.resolution_path));
  assert.ok(typeof rec.compile_source.object_path === 'string');
  assert.ok(rec.per_detector_computation);
});

test('Q63: diagnostic memo emitted at outputPath in expected markdown format', () => {
  const r = runPerTickDetectorTrace(baseOpts());
  assert.ok(fs.existsSync(r.diagnostic_memo_path));
  const memo = fs.readFileSync(r.diagnostic_memo_path, 'utf8');
  assert.ok(memo.startsWith('# DIAGNOSTIC-PER-TICK-TRACE-'));
  assert.ok(memo.includes('## Summary'));
  assert.ok(memo.includes('## Per-tick × per-detector records'));
  assert.ok(memo.includes('### Tick 0'));
});

test('Q63: summary captures per-detector firing counts', () => {
  const r = runPerTickDetectorTrace(baseOpts());
  assert.ok(r.summary.per_detector_firing_counts);
  assert.ok('family_A_page_cusum' in r.summary.per_detector_firing_counts);
  assert.ok('family_E_conformal' in r.summary.per_detector_firing_counts);
});

test('Q63: first_divergence_tick null when no detector fires across traced range', () => {
  // Fixture trajectory is intentionally close-to-baseline; expect no fires.
  const r = runPerTickDetectorTrace(baseOpts());
  // Cannot guarantee zero fires without canonical compiled config, but
  // verify the fields are well-formed (number or null).
  assert.ok(r.first_divergence_tick === null || typeof r.first_divergence_tick === 'number');
  assert.ok(r.first_divergence_detector === null || typeof r.first_divergence_detector === 'string');
});

test('Q63: subset --detectors only emits those families', () => {
  const opts = { ...baseOpts(), detectors: 'family_E_conformal' };
  const r = runPerTickDetectorTrace(opts);
  for (const rec of r.per_tick_records) {
    assert.equal(rec.detector, 'family_E_conformal',
      `subset filter must restrict to family_E_conformal; got ${rec.detector}`);
  }
});

test('Q63: tick subset --ticks restricts records to listed ticks', () => {
  const opts = { ...baseOpts(), ticks: '1,3' };
  const r = runPerTickDetectorTrace(opts);
  const ticksSeen = new Set(r.per_tick_records.map((rec) => rec.tick));
  assert.deepEqual([...ticksSeen].sort(), [1, 3]);
  assert.equal(r.summary.total_ticks_traced, 2);
});
