// test/audit-v2-compat.test.ts — W4 §4.1.h acceptance:
// v1 writer still emits v1 records; v2 writer emits v2 records; neither
// breaks the v1 golden-fixture replay. Exercises the writer directly on
// a small fixture (not the full 160-record replay — that lives in
// test/replay-regression-v2.test.js).
//
// Focus: per-record shape invariants. Strict-additive semantic: every v1
// field present in v2 with identical semantics; v2-only fields additive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createAuditWriter, buildAuditRecord } from '../dist/engine/audit';
import type {
  OrchestrateParams, VerdictResult, HealthResult, DetectorVerdict, FusedVerdict,
  AuditRecordV2,
} from '../dist/engine/types';
import { DETECTOR_REGISTRY } from '../dist/engine/types';

function baseParams(fusionTopology: 'cascade' | 'portfolio'): OrchestrateParams {
  return {
    liveMetrics: {
      p99_latency: 200, ttft: 240, tokens_turn: 430, kv_cache: 0.88, cost_req: 0.0045,
      downstream_err: 0.13, mfu: 0.71, hbm_spill: 0.021, collective_ops: 0.9996,
      corpus_delta: 0.041, traffic_pct: 1.0,
    },
    scenario: {
      id: 'compat-test',
      baseline: {
        p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042,
        downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997,
        corpus_delta: 0.04, traffic_pct: 1.0,
      },
      riskLevel: 'critical', changeType: 'model_weights', author: 'human', timeWindow: 'ok',
      flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
    },
    hoursElapsed: 10, tick: 8, totalTicks: 32,
    fusionTopology,
  };
}

function fireA(signal: string): DetectorVerdict {
  return {
    verdict: 'fire', statistic: 12, threshold: 9.6, alpha_consumed: 6.67e-5,
    alpha_spent: 6.67e-5, reason_code: 'cusum_exceeded_threshold', family: 'A', signal,
  };
}

function portfolioResult(): VerdictResult {
  const hr: HealthResult = {
    rollback: [
      { id: 'family_A_p99_latency', label: 'Family A p99_latency' },
      { id: 'slowbleed', label: 'Slow Bleed (Multi-Metric Drift)' },
    ],
    extend: [],
    warmup: { active: false, suppressedIds: [], grace: false, pct: 100 },
    suppressed: [],
    family_A_shadow: [fireA('p99_latency')],
  };
  const fused: FusedVerdict = {
    verdict: 'rollback',
    firing_families: ['A', 'B'],
    per_family_verdicts: { A: [fireA('p99_latency')], B: [{ id: 'slowbleed', label: 'Slow Bleed (Multi-Metric Drift)' }], C: null, D: null, E: null },
    total_alpha_spent: 6.67e-5,
    fusion_topology: 'portfolio',
    tick: 8,
    deploy_ref: 'compat-test',
    verdict_rationale: 'Rollback triggered: Family A fired on p99_latency; Family B fired on Slow Bleed (Multi-Metric Drift).',
    evidence_outlook: [],
  };
  return {
    verdict: 'rollback',
    reason: 'A.mSPRT_p99_latency: cusum_exceeded_threshold',
    gateResults: { health: hr, fusion: fused },
    healthResult: hr,
    shortCircuit: null,
  };
}

function cascadeResult(): VerdictResult {
  const hr: HealthResult = {
    rollback: [{ id: 'slowbleed', label: 'Slow Bleed (Multi-Metric Drift)' }],
    extend: [],
    warmup: { active: false, suppressedIds: [], grace: false, pct: 100 },
    suppressed: [],
  };
  const fused: FusedVerdict = {
    verdict: 'rollback',
    firing_families: ['B'],
    per_family_verdicts: { A: null, B: [{ id: 'slowbleed', label: 'Slow Bleed (Multi-Metric Drift)' }], C: null, D: null, E: null },
    total_alpha_spent: 0,
    fusion_topology: 'cascade',
    tick: 8,
    deploy_ref: 'compat-test',
    verdict_rationale: 'Rollback triggered: Family B fired on Slow Bleed (Multi-Metric Drift).',
    evidence_outlook: [],
  };
  return {
    verdict: 'rollback',
    reason: 'Slow Bleed (Multi-Metric Drift)',
    gateResults: { health: hr, fusion: fused },
    healthResult: hr,
    shortCircuit: null,
  };
}

// ────────────────────────────────────────────────────────────────────
test('audit-v2-compat: cascade topology still produces v1 records', () => {
  const rec = buildAuditRecord(baseParams('cascade'), cascadeResult(), null);
  assert.equal(rec.schema_version, '1');
  // v1 surface preserved.
  assert.ok('tripped' in rec);
  assert.equal(rec.tripped[0].id, 'slowbleed');
  // v2 fields absent.
  assert.ok(!('families' in rec));
  assert.ok(!('fusion_topology' in rec));
});

test('audit-v2-compat: portfolio topology produces v2 records with all new top-level fields', () => {
  const rec = buildAuditRecord(baseParams('portfolio'), portfolioResult(), null) as AuditRecordV2;
  assert.equal(rec.schema_version, '2');
  assert.equal(rec.fusion_topology, 'portfolio');
  assert.ok('compiled_config_version' in rec);
  assert.ok('families' in rec);
  assert.ok('reversibility' in rec);
  assert.ok('reversibility_source' in rec);
  assert.ok('total_alpha_spent' in rec);
  // v1 surface still present (strict-additive).
  assert.ok('tripped' in rec);
  assert.ok('inputs' in rec);
  assert.ok('baseline' in rec);
  assert.ok('scenario_ctx' in rec);
});

test('audit-v2-compat: v2 flattened tripped[] uses canonical detector_ids', () => {
  const rec = buildAuditRecord(baseParams('portfolio'), portfolioResult(), null) as AuditRecordV2;
  // Family A p99 was emitted as family_A_p99_latency in rollback; v2 flatten
  // projects it as mSPRT_p99_latency.
  const aTrip = rec.tripped.find((t) => t.id === 'mSPRT_p99_latency');
  assert.ok(aTrip, `expected mSPRT_p99_latency in tripped; got ${JSON.stringify(rec.tripped.map((t) => t.id))}`);
  // Family B canonical id slowbleed unchanged.
  const bTrip = rec.tripped.find((t) => t.id === 'slowbleed');
  assert.ok(bTrip);
  // Synthetic v1 id should NOT be present.
  const synthetic = rec.tripped.find((t) => t.id === 'family_A_p99_latency');
  assert.equal(synthetic, undefined);
});

test('audit-v2-compat: families block carries per-detector trips with provenance', () => {
  const rec = buildAuditRecord(baseParams('portfolio'), portfolioResult(), null) as AuditRecordV2;
  const fa = rec.families.A;
  assert.equal(fa.verdict, 'fire');
  assert.equal(fa.detectors.length, 1);
  assert.equal(fa.detectors[0].detector_id, 'mSPRT_p99_latency');
  assert.ok(fa.detectors[0].provenance);
  assert.equal(fa.detectors[0].provenance.covariate_freshness, 0);
  // cusum_progress is Family-A-only.
  assert.ok(typeof fa.detectors[0].cusum_progress === 'number');
  assert.ok(fa.detectors[0].cusum_progress! > 1, 'cusum_progress should exceed 1 on a fire');
  // alpha_consumed must not leak on v2 records.
  assert.equal((fa.detectors[0] as any).alpha_consumed, undefined);
});

test('audit-v2-compat: Family B trips have no cusum_progress', () => {
  const rec = buildAuditRecord(baseParams('portfolio'), portfolioResult(), null) as AuditRecordV2;
  const fb = rec.families.B;
  assert.equal(fb.verdict, 'fire');
  for (const det of fb.detectors) {
    assert.equal(det.cusum_progress, undefined, `Family B ${det.detector_id} leaked cusum_progress`);
  }
});

test('audit-v2-compat: every emitted detector_id is in the registry', () => {
  const rec = buildAuditRecord(baseParams('portfolio'), portfolioResult(), null) as AuditRecordV2;
  const all: Record<string, ReadonlySet<string>> = {
    A: new Set(DETECTOR_REGISTRY.A),
    B: new Set(DETECTOR_REGISTRY.B),
    C: new Set(DETECTOR_REGISTRY.C),
    D: new Set(DETECTOR_REGISTRY.D),
    E: new Set(DETECTOR_REGISTRY.E),
  };
  for (const fam of ['A', 'B', 'C', 'D', 'E'] as const) {
    for (const det of rec.families[fam].detectors) {
      assert.ok(all[fam].has(det.detector_id),
        `unknown_detector_id: ${fam}.${det.detector_id}`);
    }
  }
});

test('audit-v2-compat: writer routes v1 on cascade and v2 on portfolio into same sink', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-compat-'));
  const writer = createAuditWriter({ dir: tmpDir, service: 'test', rotateDaily: false });
  writer.write(buildAuditRecord(baseParams('cascade'), cascadeResult(), { service: 'test' }));
  writer.write(buildAuditRecord(baseParams('portfolio'), portfolioResult(), { service: 'test' }));
  writer.close();
  // Find JSONL file.
  const files: string[] = [];
  (function walk(d: string) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.jsonl')) files.push(p);
    }
  })(tmpDir);
  assert.ok(files.length >= 1, 'writer emitted no JSONL output');
  const lines = fs.readFileSync(files[0], 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const [l1, l2] = lines.map((l) => JSON.parse(l));
  assert.equal(l1.schema_version, '1');
  assert.equal(l2.schema_version, '2');
  assert.equal(l2.fusion_topology, 'portfolio');
  assert.ok('families' in l2);
});

test('audit-v2-compat: v2 records strip in-process-only fields (family_*_shadow, fusion)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-strip-'));
  const writer = createAuditWriter({ dir: tmpDir, service: 'test', rotateDaily: false });
  writer.write(buildAuditRecord(baseParams('portfolio'), portfolioResult(), { service: 'test' }));
  writer.close();
  const files: string[] = [];
  (function walk(d: string) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.jsonl')) files.push(p);
    }
  })(tmpDir);
  const line = fs.readFileSync(files[0], 'utf8').trim();
  const rec = JSON.parse(line);
  // In-process projections should not leak into on-disk record.
  assert.equal(rec.gate_results?.health?.family_A_shadow, undefined);
  assert.equal(rec.gate_results?.fusion, undefined);
  // Canonical surface present.
  assert.equal(rec.families.A.verdict, 'fire');
});

// ── W5 §T3 round-trip invariants ────────────────────────────────────────
//
// audit/SCHEMA.md v2 §"Backward compatibility — the one invariant" promises:
//   1. v1 reader against a v2 record sees every v1 field with identical
//      semantics; new v2 fields are ignored without throwing.
//   2. v2 reader against a v1 record treats missing v2 fields as null /
//      absent — no NPEs, fallback paths must hold.
//
// These tests pin both directions to the JSONL-on-disk surface, since
// that is the actual cross-version contract a downstream consumer sees.

/** Minimal v1-shape projector — strict subset of fields a v1-only consumer
 *  would read, with the same semantics as schema v1. Throws on missing
 *  required keys; that's the test signal — a v2 record dropped into a
 *  v1 reader must satisfy every required field. */
function readAsV1(rec: any): {
  schema_version: string; ts: string; service: string; tick: number;
  total_ticks: number; hours_elapsed: number; verdict: string; reason: string;
  short_circuit: string | null;
  tripped: Array<{ id: string; label: string; gate: string }>;
  inputs: any; baseline: any; scenario_ctx: any;
  trend_snapshot: any; policy_ctx_digest: string; mode: string; gate_results: any;
} {
  const required = [
    'schema_version', 'ts', 'service', 'tick', 'total_ticks', 'hours_elapsed',
    'verdict', 'reason', 'tripped', 'inputs', 'baseline', 'scenario_ctx',
    'trend_snapshot', 'policy_ctx_digest', 'mode', 'gate_results',
  ];
  for (const k of required) {
    if (!(k in rec)) throw new Error(`v1 reader: required field '${k}' missing`);
  }
  // short_circuit may be null; presence (key exists) is required.
  if (!('short_circuit' in rec)) throw new Error("v1 reader: 'short_circuit' missing");
  if (!Array.isArray(rec.tripped)) throw new Error("v1 reader: 'tripped' not an array");
  for (const t of rec.tripped) {
    if (typeof t.id !== 'string') throw new Error("v1 reader: trip.id not a string");
    if (typeof t.label !== 'string') throw new Error("v1 reader: trip.label not a string");
    if (typeof t.gate !== 'string') throw new Error("v1 reader: trip.gate not a string");
  }
  return rec;
}

/** Minimal v2-shape projector — accesses v2-only fields with safe-default
 *  fallbacks so a v2 reader against a v1 record still works without NPEs. */
function readAsV2Tolerant(rec: any): {
  schema_version: string;
  fusion_topology: string | null;
  families: any | null;
  reversibility: string | null;
  reversibility_source: string | null;
  total_alpha_spent: number | null;
  compiled_config_version: string | null;
} {
  return {
    schema_version: rec.schema_version,
    fusion_topology: rec.fusion_topology ?? null,
    families: rec.families ?? null,
    reversibility: rec.reversibility ?? null,
    reversibility_source: rec.reversibility_source ?? null,
    total_alpha_spent: rec.total_alpha_spent ?? null,
    compiled_config_version: rec.compiled_config_version ?? null,
  };
}

function writeAndParse(record: any): any {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-roundtrip-'));
  const writer = createAuditWriter({ dir: tmpDir, service: 'test', rotateDaily: false });
  writer.write(record);
  writer.close();
  const files: string[] = [];
  (function walk(d: string) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.jsonl')) files.push(p);
    }
  })(tmpDir);
  const line = fs.readFileSync(files[0], 'utf8').trim();
  return JSON.parse(line);
}

test('audit-v2-compat: T3a — v1 reader against v2 record sees all required v1 fields, ignores unknowns', () => {
  const v2Record = buildAuditRecord(baseParams('portfolio'), portfolioResult(), { service: 'test' });
  const onDisk = writeAndParse(v2Record);
  // Sanity — confirm it really is a v2 record.
  assert.equal(onDisk.schema_version, '2');

  // The v1 reader must not throw and must see identical-semantics for every
  // v1 field. Spot-check the structurally important ones.
  const v1View = readAsV1(onDisk);
  assert.equal(v1View.verdict, 'rollback');
  assert.equal(v1View.short_circuit, null);
  assert.ok(v1View.tripped.length > 0, 'v1 reader expects tripped[] populated on a fire');
  // Tripped projection uses canonical detector_id; the v1 reader doesn't
  // care which IDs it sees, only that the entries parse as TripEntry shape.
  for (const t of v1View.tripped) {
    assert.ok(t.id.length > 0);
    assert.ok(t.gate === 'health_rollback' || t.gate === 'health_extend');
  }
});

test('audit-v2-compat: T3b — v2 reader against v1 record treats missing v2 fields as null', () => {
  const v1Record = buildAuditRecord(baseParams('cascade'), cascadeResult(), { service: 'test' });
  const onDisk = writeAndParse(v1Record);
  assert.equal(onDisk.schema_version, '1');

  // v2 tolerant read should not throw; v2-only fields come back null.
  const v2View = readAsV2Tolerant(onDisk);
  assert.equal(v2View.fusion_topology, null);
  assert.equal(v2View.families, null);
  assert.equal(v2View.reversibility, null);
  assert.equal(v2View.reversibility_source, null);
  assert.equal(v2View.total_alpha_spent, null);
  assert.equal(v2View.compiled_config_version, null);
});

test('audit-v2-compat: T3 — golden v1 fixture is v1-reader-clean and v2-reader-tolerant', () => {
  // Sanity-check the actual on-disk v1 fixture against both readers — this
  // is the contract Phase-1 audit consumers depend on.
  const goldenV1 = path.join(__dirname, 'fixtures', 'audit', 'golden.jsonl');
  if (!fs.existsSync(goldenV1)) return;  // skip if missing (CI clean clone)
  const lines = fs.readFileSync(goldenV1, 'utf8').trim().split('\n');
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.schema_version !== '1') continue;
    // v1-reader sanity (must not throw on its own native records).
    readAsV1(rec);
    // v2 tolerant view: every v2 field must come back null without NPEs.
    const v2View = readAsV2Tolerant(rec);
    assert.equal(v2View.families, null);
    assert.equal(v2View.fusion_topology, null);
  }
});
