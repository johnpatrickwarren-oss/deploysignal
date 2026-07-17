// test/session-lifecycle-emitter.test.ts — Task 4 (WS4 session-durability-argo
// plan): JsonlLifecycleEventEmitter, the durable implementation of
// engine/o0/lifecycle-events.ts's LifecycleEventEmitter contract.
//
// Persists the EXISTING o0 event union verbatim — this file does NOT
// extend LifecycleEventType (Addition #15, unlanded, extends it in
// parallel on its own branch; not touching it here is what keeps this
// merge-conflict-free, per OQ-6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { JsonlLifecycleEventEmitter } from '../service/session/jsonl-lifecycle-emitter';
import {
  freshLifecycleState,
} from '../dist/engine/o0/lifecycle-events';
import type {
  LifecycleDeployState, LifecycleEventPayload, LifecycleEventType,
} from '../dist/engine/o0/lifecycle-events';
import type { CompiledConfig, OrchestrateParams, Metrics } from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ds-lifecycle-jsonl-'));
}

const BASELINE: Metrics = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

function makeScenario(id = 'sci-jsonl-lifecycle'): OrchestrateParams['scenario'] {
  return {
    id,
    riskLevel: 'critical',
    bakeHours: 6,
    author: 'human',
    changeType: 'model_weights',
    timeWindow: 'ok',
    flags: {
      security: false, artifact_content: false, provenance: false,
      contract: false, toolchain: false, zeta: true, approval: true,
    },
    baseline: BASELINE,
  };
}

function makeLive(overrides: Partial<Metrics> = {}): Metrics {
  return { ...BASELINE, ...overrides };
}

// ────────────────────────────────────────────────────────────────────
// Unit tests — the emitter in isolation.
// ────────────────────────────────────────────────────────────────────

test('unit: all five evaluation.* payload shapes round-trip through readAll()', async () => {
  const dir = tmpDir();
  const emitter = new JsonlLifecycleEventEmitter(path.join(dir, 'events.jsonl'));

  const payloads: Array<[LifecycleEventType, LifecycleEventPayload]> = [
    ['evaluation.triggered', {
      type: 'evaluation.triggered', deploy_id: 'd', service_id: 's',
      compiled_config_version: 'v', expected_window_ticks: 3, risk_tier: 'low',
    }],
    ['evaluation.started', {
      type: 'evaluation.started', deploy_id: 'd',
      cell_key: { hour_of_day: 0 }, cell_confidence: 'strict', families_eligible: ['B'],
    }],
    ['evaluation.tick', {
      type: 'evaluation.tick', deploy_id: 'd', tick: 0, audit_record: { tick: 0 } as never,
    }],
    ['evaluation.suppressed', {
      type: 'evaluation.suppressed', deploy_id: 'd', tick: 1, family_id: 'A',
      suppression_reason: 'schema_continuity_breaking',
    }],
    ['evaluation.finished', {
      type: 'evaluation.finished', deploy_id: 'd',
      final_verdict: 'proceed', total_alpha_spent: 0.0001, families_summary: {},
    }],
  ];
  for (const [t, p] of payloads) {
    await emitter.emit(t, p);
  }

  const lines = emitter.readAll();
  assert.equal(lines.length, 5);
  for (let i = 0; i < payloads.length; i++) {
    assert.equal(lines[i].type, payloads[i][0]);
    assert.deepEqual(lines[i].payload, payloads[i][1]);
    assert.ok(lines[i].at, 'each line carries an ISO timestamp');
    assert.ok(!Number.isNaN(Date.parse(lines[i].at)), 'at is a valid ISO date string');
  }

  const status = emitter.status();
  assert.deepEqual(status, { errors: 0, last_error: null, healthy: true });
});

test('unit: emit() never rejects on an unwritable path; status().errors surfaces the failure', async () => {
  const dir = tmpDir();
  const blocker = path.join(dir, 'blocker-file');
  fs.writeFileSync(blocker, 'x');
  // Parent of the events file is a FILE, not a directory — mkdirSync
  // inside the constructor throws ENOTDIR, and any subsequent emit()
  // would also fail if it got that far.
  const badPath = path.join(blocker, 'events.jsonl');

  const emitter = new JsonlLifecycleEventEmitter(badPath);
  await assert.doesNotReject(emitter.emit('evaluation.triggered', {
    type: 'evaluation.triggered', deploy_id: 'd', service_id: 's',
    compiled_config_version: 'v', expected_window_ticks: 1, risk_tier: 'low',
  }));

  const status = emitter.status();
  assert.ok(status.errors >= 1, 'status().errors >= 1');
  assert.ok(status.last_error, 'status().last_error populated');
  assert.equal(status.healthy, false);

  assert.deepEqual(emitter.readAll(), [], 'readAll() on a file that was never written returns []');
});

// ────────────────────────────────────────────────────────────────────
// Integration — wired as params.lifecycleEmitter through a real evaluate() loop.
// ────────────────────────────────────────────────────────────────────

test('integration: 3-tick evaluate() loop persists triggered once, tick x3, finished once, in order', () => {
  const dir = tmpDir();
  const emitter = new JsonlLifecycleEventEmitter(path.join(dir, 'events.jsonl'));
  const state: LifecycleDeployState = freshLifecycleState();
  const tb = new TrendBuffer(10);
  const sc = makeScenario();
  const totalTicks = 3;

  for (let tick = 0; tick < totalTicks; tick++) {
    const live = makeLive();
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live,
      scenario: sc,
      hoursElapsed: tick * 0.25,
      trendBuffer: tb,
      tick,
      totalTicks,
      deployId: 'deploy-jsonl-lifecycle-test',
      compiledConfig: null as unknown as CompiledConfig,
      currentHourOfDay: 20,
      currentDayOfWeek: 3,
      lifecycleEmitter: emitter,
      lifecycleState: state,
    };
    orchestrate(params);
  }

  const lines = emitter.readAll();
  const types = lines.map((l) => l.type);
  assert.equal(types[0], 'evaluation.triggered');
  assert.equal(types[1], 'evaluation.started');
  assert.equal(types[types.length - 1], 'evaluation.finished');

  const countOf = (t: LifecycleEventType) => types.filter((x) => x === t).length;
  assert.equal(countOf('evaluation.triggered'), 1);
  assert.equal(countOf('evaluation.started'), 1);
  assert.equal(countOf('evaluation.tick'), 3);
  assert.equal(countOf('evaluation.finished'), 1);

  // Order: triggered, started, tick, tick, tick, finished.
  assert.deepEqual(types, [
    'evaluation.triggered', 'evaluation.started',
    'evaluation.tick', 'evaluation.tick', 'evaluation.tick',
    'evaluation.finished',
  ]);

  // evaluation.tick lines carry the full audit_record (not a stub).
  const tickLines = lines.filter((l) => l.type === 'evaluation.tick');
  for (const line of tickLines) {
    const payload = line.payload as unknown as { audit_record: Record<string, unknown> };
    assert.ok(payload.audit_record, 'tick payload carries audit_record');
    assert.ok(Object.keys(payload.audit_record).length > 3, 'audit_record is a full record, not a stub');
  }

  assert.equal(emitter.status().healthy, true);
});
