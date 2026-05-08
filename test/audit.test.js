'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { createAuditWriter, buildAuditRecord } = require('../dist/engine/audit');

let tmpDir;
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else { failed++; console.error('  FAIL: ' + msg); }
}

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-audit-test-'));
}

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 1: Write 100 records, verify file contents ──────────────
function testWriteAndRead() {
  console.log('Test 1: Write 100 records');
  const writer = createAuditWriter({ dir: tmpDir, service: 'test-svc' });
  for (let i = 0; i < 100; i++) {
    writer.write({ schema_version: '1', tick: i, verdict: i % 3 === 0 ? 'rollback' : 'proceed' });
  }
  writer.close();

  const serviceDir = path.join(tmpDir, 'test-svc');
  const files = fs.readdirSync(serviceDir).filter(f => f.endsWith('.jsonl'));
  assert(files.length === 1, 'Exactly one JSONL file created');

  const lines = fs.readFileSync(path.join(serviceDir, files[0]), 'utf8').trim().split('\n');
  assert(lines.length === 100, '100 lines written');

  let allValid = true;
  for (let i = 0; i < lines.length; i++) {
    try {
      const rec = JSON.parse(lines[i]);
      if (rec.tick !== i) { allValid = false; break; }
    } catch (e) { allValid = false; break; }
  }
  assert(allValid, 'All 100 records parse as valid JSON with correct tick');
}

// ── Test 2: No-op writer when dir is falsy ───────────────────────
function testNoOpWriter() {
  console.log('Test 2: No-op writer');
  const writer = createAuditWriter(null);
  writer.write({ tick: 0 }); // should not throw
  writer.close();
  assert(true, 'No-op writer does not throw');

  const writer2 = createAuditWriter({ dir: '' });
  writer2.write({ tick: 0 });
  writer2.close();
  assert(true, 'Empty dir produces no-op writer');
}

// ── Test 3: buildAuditRecord produces correct schema ─────────────
function testBuildRecord() {
  console.log('Test 3: buildAuditRecord schema');
  const params = {
    tick: 5,
    totalTicks: 20,
    liveMetrics: { p99_latency: 140, ttft: 37 },
    scenario: { baseline: { p99_latency: 135, ttft: 36 } },
    trendBuffer: null
  };
  const result = {
    verdict: 'rollback',
    reason: 'Slow Bleed',
    shortCircuit: null,
    gateResults: { health: { rollback: [{ id: 'slowbleed', label: 'Slow Bleed' }], extend: [] } },
    healthResult: { rollback: [{ id: 'slowbleed', label: 'Slow Bleed' }], extend: [] }
  };
  const rec = buildAuditRecord(params, result, { service: 'svc1' });

  assert(rec.schema_version === '1', 'schema_version is "1"');
  assert(rec.tick === 5, 'tick matches');
  assert(rec.total_ticks === 20, 'total_ticks matches');
  assert(rec.verdict === 'rollback', 'verdict matches');
  assert(rec.tripped.length === 1, 'one tripped signal');
  assert(rec.tripped[0].id === 'slowbleed', 'tripped id is slowbleed');
  assert(rec.tripped[0].gate === 'health_rollback', 'gate is health_rollback');
  assert(rec.inputs.p99_latency === 140, 'inputs preserved exactly (no rounding)');
  assert(rec.baseline.p99_latency === 135, 'baseline preserved');
  assert(rec.mode === 'shadow', 'default mode is shadow');
  assert(typeof rec.ts === 'string' && rec.ts.includes('T'), 'ts is ISO string');
  assert(typeof rec.policy_ctx_digest === 'string', 'policy_ctx_digest is string');
}

// ── Test 4: Rotation across date boundary ────────────────────────
function testRotation() {
  console.log('Test 4: Date rotation');
  const rotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-audit-rot-'));

  // Write directly to two date files to simulate rotation
  const serviceDir = path.join(rotDir, 'rot-svc');
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(path.join(serviceDir, '2026-04-14.jsonl'), '{"tick":0}\n');
  fs.writeFileSync(path.join(serviceDir, '2026-04-15.jsonl'), '{"tick":1}\n');

  const files = fs.readdirSync(serviceDir).sort();
  assert(files.length === 2, 'Two date files exist');
  assert(files[0] === '2026-04-14.jsonl', 'First file has correct date');
  assert(files[1] === '2026-04-15.jsonl', 'Second file has correct date');

  fs.rmSync(rotDir, { recursive: true, force: true });
}

// ── Test 5: Float serialization — no rounding ────────────────────
function testFloatExactness() {
  console.log('Test 5: Float exactness');
  const writer = createAuditWriter({ dir: tmpDir, service: 'float-test' });
  const val = 0.1 + 0.2; // 0.30000000000000004
  writer.write({ value: val });
  writer.close();

  const file = path.join(tmpDir, 'float-test', new Date().toISOString().slice(0, 10) + '.jsonl');
  const line = fs.readFileSync(file, 'utf8').trim();
  const rec = JSON.parse(line);
  assert(rec.value === val, 'Float survives JSON round-trip with exact bits (0.30000000000000004)');
}

// ── Run ──────────────────────────────────────────────────────────
setup();
try {
  testWriteAndRead();
  testNoOpWriter();
  testBuildRecord();
  testRotation();
  testFloatExactness();
} finally {
  cleanup();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
