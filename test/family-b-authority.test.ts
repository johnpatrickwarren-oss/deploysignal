// test/family-b-authority.test.ts — FAMILY_B_AUTHORITY (2026-09-27): Family B holds and never rolls
// back beside a compiled statistical family; `structural_detectors.enabled: false` runs no rule;
// the policy gates (POLICY_GATE_IDS) keep their effect and are never counted as Family B.
//
// Trigger: `compound_lat` (Family B) fires when p99_latency and ttft both sit ≥1.12× baseline with a
// low-variance trend buffer. The v2 config compiles Family A cells beside `family_B`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  CompiledConfig, HealthResult, Metrics, Baseline, VerdictResult, AuditRecordV2, OrchestrateParams,
} from '../dist/engine/types';
import { evaluateHealth } from '../dist/engine/gates/health';
import { structuralMode, familyBHolds } from '../dist/engine/gates/_health-structural';
import { fuseVerdict } from '../dist/engine/verdict';
import { buildAuditRecord } from '../dist/engine/audit';
import { FAMILY_B_AUTHORITY, POLICY_GATE_IDS } from '../dist/engine/guarantees';

const engine = require('../shared');
const { TrendBuffer } = engine;

const ROOT = path.resolve(__dirname, '..');
const cfgFile = (name: string): CompiledConfig =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'runs', 'compiled-configs', name), 'utf8'));
const WITH_A = cfgFile('v2-with-family-a.json');
const B_ONLY = cfgFile('v1-legacy-equivalent.json');
const B_OFF = (() => { const c = cfgFile('v2-with-family-a.json'); delete (c as { family_B?: unknown }).family_B; return c; })();

const FLAGS = { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true };
const POLICY = { thresholds: {}, warmup: { active: false, suppressedIds: [], grace: false, pct: 100 } };
const BASE = { p99_latency: 200, ttft: 100 } as unknown as Baseline;
const LIVE = { p99_latency: 261, ttft: 131 } as unknown as Metrics;

function risenBuffer() {
  const tb = new TrendBuffer(10);
  for (let i = 0; i < 8; i++) { tb.push('p99_latency', 260 + (i % 2)); tb.push('ttft', 130 + (i % 2)); }
  return tb;
}

function health(cfg: CompiledConfig | undefined, flags: Record<string, unknown> = FLAGS): HealthResult {
  return evaluateHealth(LIVE, BASE, flags as never, JSON.parse(JSON.stringify(POLICY)), risenBuffer(),
    cfg ? { compiledConfig: cfg } : undefined);
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test('FAMILY_B_AUTHORITY is hold_only; the policy gates are the five flag rules', () => {
  assert.equal(FAMILY_B_AUTHORITY, 'hold_only');
  assert.deepEqual([...POLICY_GATE_IDS].sort(), ['artifact', 'contract', 'provenance', 'security', 'toolchain']);
});

test('structuralMode: no config and B-only keep rollback; B beside a statistical family holds; no family_B is off', () => {
  assert.equal(structuralMode(undefined), 'rollback');
  assert.equal(structuralMode(null), 'rollback');
  assert.equal(structuralMode(B_ONLY), 'rollback');
  assert.equal(structuralMode(WITH_A), 'hold');
  assert.equal(structuralMode(B_OFF), 'off');
});

test('no compiled config: compound_lat still rolls back (control)', () => {
  const hr = health(undefined);
  assert.ok(ids(hr.rollback).includes('compound_lat'));
  assert.deepEqual(familyBHolds(hr), []);
});

test('hold: compound_lat goes to extend[] and family_B_holds, never rollback[]', () => {
  const hr = health(WITH_A);
  assert.ok(!ids(hr.rollback).includes('compound_lat'), `rollback=${JSON.stringify(ids(hr.rollback))}`);
  assert.ok(ids(hr.extend).includes('compound_lat'));
  assert.deepEqual(ids(familyBHolds(hr)), ['compound_lat']);
});

test('off: no Family B rule runs; a policy gate still rolls back', () => {
  const hr = health(B_OFF, { ...FLAGS, provenance: true });
  assert.ok(!ids(hr.rollback).includes('compound_lat') && !ids(hr.extend).includes('compound_lat'));
  assert.deepEqual(ids(hr.rollback).filter((id) => !id.startsWith('family_')), ['provenance']);
  assert.deepEqual(familyBHolds(hr), []);
});

test('hold: a policy gate still rolls back beside a Family B hold', () => {
  const hr = health(WITH_A, { ...FLAGS, security: true });
  assert.ok(ids(hr.rollback).includes('security'));
  assert.ok(!ids(hr.rollback).includes('compound_lat'));
});

const WARM = { active: false, suppressedIds: [], grace: false, pct: 100 };

test('fusion: a policy gate alone rolls back without counting as Family B', () => {
  const hr: HealthResult = { rollback: [{ id: 'provenance', label: 'Provenance/Hash' }], extend: [], warmup: WARM, suppressed: [] };
  const f = fuseVerdict(hr, { topology: 'portfolio', tick: 3, totalTicks: 32, deployRef: 't' });
  assert.equal(f.verdict, 'rollback');
  assert.deepEqual(f.firing_families, []);
  assert.equal(f.per_family_verdicts.B, null);
  assert.match(f.verdict_rationale!, /policy gate\(s\): Provenance\/Hash/);
});

test('fusion: a Family B hold extends, never rolls back, and the rationale says so once', () => {
  const hold = { id: 'compound_lat', label: 'Compound Latency' };
  const hr = { rollback: [], extend: [hold], warmup: WARM, suppressed: [], family_B_holds: [hold] } as HealthResult;
  const f = fuseVerdict(hr, { topology: 'portfolio', tick: 3, totalTicks: 32, deployRef: 't' });
  assert.equal(f.verdict, 'extend');
  assert.deepEqual(f.firing_families, []);
  const b = f.evidence_outlook!.find((e) => e.family_id === 'B')!;
  assert.match(b.note, /Family B holding on Compound Latency/);
  assert.equal(f.verdict_rationale!.split('Compound Latency').length - 1, 1, f.verdict_rationale);
});

test('audit: a hold is Family B indeterminate with no detectors', () => {
  const hr = health(WITH_A);
  const fused = fuseVerdict(hr, { topology: 'portfolio', tick: 8, totalTicks: 32, deployRef: 't' });
  const result = { verdict: fused.verdict, reason: 'hold', gateResults: { health: hr, fusion: fused }, healthResult: hr, shortCircuit: null } as VerdictResult;
  const params = {
    liveMetrics: LIVE, scenario: { id: 't', baseline: BASE, riskLevel: 'critical', changeType: 'model_weights', author: 'human', timeWindow: 'ok', flags: FLAGS },
    hoursElapsed: 10, tick: 8, totalTicks: 32, fusionTopology: 'portfolio', compiledConfig: WITH_A,
  } as unknown as OrchestrateParams;
  const rec = buildAuditRecord(params, result, null) as AuditRecordV2;
  assert.equal(rec.families.B.verdict, 'indeterminate');
  assert.deepEqual(rec.families.B.detectors, []);
});
