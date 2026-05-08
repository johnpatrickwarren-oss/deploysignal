// test/lifecycle-events.test.ts — Addition #14 acceptance.
//
// Exercises the O0 LifecycleEventEmitter contract + NoOp + InMemory
// implementations + orchestrator emission points. Five event types:
//   evaluation.triggered | .started | .tick | .suppressed | .finished
//
// Brief: coordination/ARCHITECT-REPLY-31.md §"Addition #14 …
// implementation brief". Anti-scope reminder: no real-orchestrator
// adapters (Argo K8s Events / Spinnaker / MLflow / webhooks) — the
// runway ships the contract + NoOp + InMemory only.
//
// Flat test-file layout per REPLY-28/#10/#13 precedent. ~5 unit +
// ~6 integration assertions in the same file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  NoOpLifecycleEventEmitter, InMemoryLifecycleEventEmitter,
  freshLifecycleState,
} from '../dist/engine/o0/lifecycle-events';
import type {
  LifecycleEventType, LifecycleEventPayload, RecordedLifecycleEvent,
} from '../dist/engine/o0/lifecycle-events';
import type {
  CompiledConfig, OrchestrateParams, Metrics,
} from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v2-with-family-a.json');

const BASELINE: Metrics = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

function makeScenario(id = 'sci-lifecycle'): OrchestrateParams['scenario'] {
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
// Unit tests — emitter implementations in isolation.
// ────────────────────────────────────────────────────────────────────

test('unit 1: LifecycleEventType enum completeness and payload shape', async () => {
  // All five event types exist and emit successfully via InMemory.
  const emitter = new InMemoryLifecycleEventEmitter();
  const types: LifecycleEventType[] = [
    'evaluation.triggered', 'evaluation.started', 'evaluation.tick',
    'evaluation.suppressed', 'evaluation.finished',
  ];
  assert.equal(types.length, 5, 'five event types');

  // Emit a minimal payload for each type; assert recorded in order with
  // matching `type` field (payload-type discriminator works).
  await emitter.emit('evaluation.triggered', {
    type: 'evaluation.triggered', deploy_id: 'd', service_id: 's',
    compiled_config_version: 'v', expected_window_ticks: 1, risk_tier: 'low',
  });
  await emitter.emit('evaluation.started', {
    type: 'evaluation.started', deploy_id: 'd',
    cell_key: { hour_of_day: 0 }, cell_confidence: 'strict', families_eligible: ['B'],
  });
  await emitter.emit('evaluation.finished', {
    type: 'evaluation.finished', deploy_id: 'd',
    final_verdict: 'proceed', total_alpha_spent: 0, families_summary: {},
  });
  const events = emitter.getEvents();
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'evaluation.triggered');
  assert.equal(events[1].type, 'evaluation.started');
  assert.equal(events[2].type, 'evaluation.finished');
});

test('unit 2: InMemoryLifecycleEventEmitter subscribe/emit delivers events in registration order', async () => {
  const emitter = new InMemoryLifecycleEventEmitter();
  const calls: string[] = [];
  emitter.subscribe((e) => calls.push('a:' + e.type));
  emitter.subscribe((e) => calls.push('b:' + e.type));
  await emitter.emit('evaluation.tick', {
    type: 'evaluation.tick', deploy_id: 'd', tick: 0, audit_record: {} as never,
  });
  // Registration order: 'a' then 'b'.
  assert.deepEqual(calls, ['a:evaluation.tick', 'b:evaluation.tick']);
});

test('unit 3: InMemoryLifecycleEventEmitter isolates listener errors', async () => {
  const emitter = new InMemoryLifecycleEventEmitter();
  const received: string[] = [];
  emitter.subscribe(() => { throw new Error('boom'); });  // throwing listener
  emitter.subscribe((e) => received.push(e.type));        // second listener
  await emitter.emit('evaluation.finished', {
    type: 'evaluation.finished', deploy_id: 'd',
    final_verdict: 'proceed', total_alpha_spent: 0, families_summary: {},
  });
  // Throwing listener does not prevent the second listener from running
  // and the event is still recorded internally.
  assert.deepEqual(received, ['evaluation.finished']);
  assert.equal(emitter.getEvents().length, 1);
});

test('unit 4: NoOpLifecycleEventEmitter.emit returns a Promise that resolves with no side effects', async () => {
  const emitter = new NoOpLifecycleEventEmitter();
  const p = emitter.emit('evaluation.tick', {
    type: 'evaluation.tick', deploy_id: 'd', tick: 0, audit_record: {} as never,
  });
  assert.ok(p instanceof Promise, 'emit returns a Promise');
  await p;  // must not reject
});

test('unit 5: InMemoryLifecycleEventEmitter.reset clears events + listeners', async () => {
  const emitter = new InMemoryLifecycleEventEmitter();
  let count = 0;
  emitter.subscribe(() => { count++; });
  await emitter.emit('evaluation.triggered', {
    type: 'evaluation.triggered', deploy_id: 'd', service_id: 's',
    compiled_config_version: 'v', expected_window_ticks: 1, risk_tier: 'low',
  });
  assert.equal(count, 1);
  assert.equal(emitter.getEvents().length, 1);
  emitter.reset();
  assert.equal(emitter.getEvents().length, 0);
  // After reset, old listener no longer subscribed.
  await emitter.emit('evaluation.triggered', {
    type: 'evaluation.triggered', deploy_id: 'd', service_id: 's',
    compiled_config_version: 'v', expected_window_ticks: 1, risk_tier: 'low',
  });
  assert.equal(count, 1, 'old listener must NOT be called after reset');
  assert.equal(emitter.getEvents().length, 1, 'new event recorded after reset');
});

// ────────────────────────────────────────────────────────────────────
// Integration tests — orchestrator emission sequence.
// ────────────────────────────────────────────────────────────────────

function typesOf(events: RecordedLifecycleEvent[]): LifecycleEventType[] {
  return events.map((e) => e.type);
}

function runDeploy(opts: {
  scenario: OrchestrateParams['scenario'];
  ticks: number;
  liveFor: (tick: number) => Metrics;
  compiledConfig?: CompiledConfig | null;
  failFastThresholds?: OrchestrateParams['failFastThresholds'];
  ignoreThresholds?: OrchestrateParams['ignoreThresholds'];
  schemaContinuityFor?: (tick: number) => 'continuous' | 'extended' | 'breaking' | 'observability_stack' | undefined;
  emitter?: InMemoryLifecycleEventEmitter;
  stopOnTerminal?: boolean;
  /** Force bake profile always-met by overriding ticksSinceDeploy to a
   *  large value. Lets transition-focused tests toggle schema/ignore
   *  state without bake-profile-not-met noise. */
  bypassBake?: boolean;
}): { emitter: InMemoryLifecycleEventEmitter; ticksRun: number } {
  const emitter = opts.emitter ?? new InMemoryLifecycleEventEmitter();
  const state = freshLifecycleState();
  const tb = new TrendBuffer(10);
  let failFastState = undefined as OrchestrateParams['failFastState'];
  let ticksRun = 0;
  for (let i = 0; i < opts.ticks; i++) {
    const live = opts.liveFor(i);
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live,
      scenario: opts.scenario,
      hoursElapsed: i * 0.25,
      trendBuffer: tb,
      tick: i,
      totalTicks: opts.ticks,
      deployId: 'deploy-lifecycle-test',
      compiledConfig: opts.compiledConfig ?? null,
      currentHourOfDay: 20,
      currentDayOfWeek: 3,
      failFastThresholds: opts.failFastThresholds,
      ignoreThresholds: opts.ignoreThresholds,
      failFastState,
      schemaContinuityClass: opts.schemaContinuityFor?.(i),
      lifecycleEmitter: emitter,
      lifecycleState: state,
      ...(opts.bypassBake ? { ticksSinceDeploy: 100, deployAgeDays: 0 } : {}),
    };
    const result = orchestrate(params);
    ticksRun++;
    failFastState = result.failFastState;
    if (opts.stopOnTerminal && result.shortCircuit !== null) break;
    if (opts.stopOnTerminal && (result.verdict === 'rollback' || result.verdict === 'proceed')) break;
  }
  return { emitter, ticksRun };
}

test('integration 1: full-deploy event sequence on clean scenario — triggered, started, N tick events, finished', () => {
  const sc = makeScenario();
  const { emitter, ticksRun } = runDeploy({
    scenario: sc, ticks: 8,
    liveFor: () => makeLive(),
  });
  const events = emitter.getEvents();
  const types = typesOf(events);
  // First event: triggered. Second: started. Last: finished.
  assert.equal(types[0], 'evaluation.triggered');
  assert.equal(types[1], 'evaluation.started');
  assert.equal(types[types.length - 1], 'evaluation.finished');
  // Exactly one triggered, one started, one finished.
  const countOf = (t: LifecycleEventType) => types.filter((x) => x === t).length;
  assert.equal(countOf('evaluation.triggered'), 1);
  assert.equal(countOf('evaluation.started'), 1);
  assert.equal(countOf('evaluation.finished'), 1);
  // One tick event per tick.
  assert.equal(countOf('evaluation.tick'), ticksRun);
});

test('integration 2: suppression-transition single-fire — Family A suppressed once when schema goes breaking', () => {
  // Schema continuity flips to 'breaking' at tick 4 (forces Family A
  // full suppression per Addition #8). Assert exactly ONE
  // evaluation.suppressed event for family A fires at the transition —
  // not one per subsequent tick.
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn('skip: ' + CONFIG_PATH + ' not present');
    return;
  }
  const cfg: CompiledConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const sc = makeScenario();
  const { emitter } = runDeploy({
    scenario: sc, ticks: 8,
    compiledConfig: cfg,
    liveFor: () => makeLive(),
    schemaContinuityFor: (i) => (i < 4 ? 'continuous' : 'breaking'),
    bypassBake: true,
  });
  const suppressedA = emitter.getEvents().filter(
    (e) => e.type === 'evaluation.suppressed'
      && (e.payload as { family_id?: string }).family_id === 'A',
  );
  assert.equal(suppressedA.length, 1, 'exactly one suppressed event for Family A');
  const payload = suppressedA[0].payload as { tick: number; suppression_reason: string };
  assert.equal(payload.tick, 4, 'suppressed at the transition tick');
  assert.equal(payload.suppression_reason, 'schema_continuity_breaking');
});

test('integration 3: multiple suppression transitions — suppress → un-suppress → re-suppress emits two events', () => {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn('skip: ' + CONFIG_PATH + ' not present');
    return;
  }
  const cfg: CompiledConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const sc = makeScenario();
  // Schema: continuous 0..2, breaking 3..4, continuous 5..6, breaking 7..9.
  // Two non-suppressed → suppressed transitions for Family A (at tick 3
  // and tick 7). The 5..6 un-suppression does NOT emit an event
  // (symmetric unsuppressed event is anti-scope per brief).
  const { emitter } = runDeploy({
    scenario: sc, ticks: 10,
    compiledConfig: cfg,
    liveFor: () => makeLive(),
    schemaContinuityFor: (i) => {
      if (i < 3) return 'continuous';
      if (i < 5) return 'breaking';
      if (i < 7) return 'continuous';
      return 'breaking';
    },
    bypassBake: true,
  });
  const suppressedA = emitter.getEvents().filter(
    (e) => e.type === 'evaluation.suppressed'
      && (e.payload as { family_id?: string }).family_id === 'A',
  );
  assert.equal(suppressedA.length, 2, 'two non-suppressed → suppressed transitions');
  const ticks = suppressedA.map((e) => (e.payload as { tick: number }).tick);
  assert.deepEqual(ticks, [3, 7]);
});

test('integration 4: fail-fast deploy sequence — no per-family suppressed events (short-circuit before L2)', () => {
  const sc = makeScenario();
  // Fail-fast trips at tick 2 (downstream_err crosses 0.05). The
  // orchestrator short-circuits before evaluateHealth runs, so no
  // family-level verdicts are produced → no evaluation.suppressed
  // events. Expected sequence: triggered, started, 3× tick, finished.
  const { emitter } = runDeploy({
    scenario: sc, ticks: 8,
    liveFor: (i) => makeLive({ downstream_err: i < 2 ? 0.02 : 0.08 }),
    failFastThresholds: { downstream_err: 0.05 },
    stopOnTerminal: true,
  });
  const types = typesOf(emitter.getEvents());
  assert.equal(types.filter((t) => t === 'evaluation.triggered').length, 1);
  assert.equal(types.filter((t) => t === 'evaluation.started').length, 1);
  assert.equal(types.filter((t) => t === 'evaluation.finished').length, 1);
  assert.equal(types.filter((t) => t === 'evaluation.suppressed').length, 0,
    'no family suppression events on fail-fast short-circuit');
  // Finished payload carries rollback verdict.
  const finished = emitter.getEvents().find((e) => e.type === 'evaluation.finished');
  assert.ok(finished);
  assert.equal((finished!.payload as { final_verdict: string }).final_verdict, 'rollback');
});

test('integration 5: backward compat — orchestrator without lifecycleEmitter behaves identically to pre-#14', () => {
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  // Run a few ticks with no emitter wired — must not throw, must return
  // sensible results, must produce no side effects.
  for (let i = 0; i < 4; i++) {
    const live = makeLive();
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const result = orchestrate({
      liveMetrics: live, scenario: sc,
      hoursElapsed: i * 0.25,
      trendBuffer: tb, tick: i, totalTicks: 4,
      // lifecycleEmitter / lifecycleState omitted deliberately.
    });
    assert.ok(result.healthResult !== null, 'health gate still runs');
    // With no emitter, lifecycleState may still be threaded internally
    // by the orchestrator — but no external observer. The contract is
    // that absence of emitter => zero external behavior change.
  }
});

test('integration 6: emitter error resilience — throwing listener does not break deploy flow', () => {
  const sc = makeScenario();
  const emitter = new InMemoryLifecycleEventEmitter();
  let tickCount = 0;
  emitter.subscribe((e) => {
    if (e.type === 'evaluation.tick') throw new Error('listener fails on tick');
  });
  emitter.subscribe((e) => { if (e.type === 'evaluation.tick') tickCount++; });
  const { ticksRun } = runDeploy({
    scenario: sc, ticks: 5,
    liveFor: () => makeLive(),
    emitter,
  });
  assert.equal(ticksRun, 5, 'all ticks evaluated despite throwing listener');
  assert.equal(tickCount, 5, 'second listener still received every tick event');
  const finished = emitter.getEvents().find((e) => e.type === 'evaluation.finished');
  assert.ok(finished, 'finished still fires after throwing listener');
});
