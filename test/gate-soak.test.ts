// test/gate-soak.test.ts — R5 live shadow soak, Task 7 (runtime level):
// GateSessionRuntime + SoakController wiring. Harness pattern from
// test/gate-session-runtime.test.ts (mkdtemp dirs, real
// SessionStore/JsonlLifecycleEventEmitter, `setEvaluateFnForTest` seam)
// plus a hand-written recalibration-store layout (candidates/<id>.json,
// soak.json, a compiled-config fixture) — the q60/recalibration-cli.test.ts
// `makeConfig` pattern.
//
// A deterministic `fakeEvaluateFn` stands in for the real engine so
// disagreement/completion/replay/restart behavior is controllable
// without depending on real detector threshold math (already covered
// elsewhere): the SERVED call always has `compiledConfig: null` in this
// harness (no active.json seeded) and always returns 'extend' regardless
// of metrics; the CANDIDATE (shadow) call always has a non-null
// `compiledConfig` and returns 'rollback' whenever `p99_latency` exceeds
// baseline, else 'extend'. This isolates the tests to the
// SoakController/GateSessionRuntime WIRING this task adds — enrollment,
// non-interference, replay-safety, restart-honesty, completion — which
// is what Tasks 2-3 need driven now (plan Task 7 items 1-5, 7; item 6
// "error isolation" and the review-fix regression tests for mtime-cache
// robustness / same-candidate re-soak are added below, in the R5
// Tasks 4-10 pass).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionStore } from '../service/session/session-store';
import { JsonlLifecycleEventEmitter } from '../service/session/jsonl-lifecycle-emitter';
import { GateSessionRuntime } from '../service/gate-http/_gate-session-runtime';
import type {
  GateRuntimeConfig, BeginSessionRequest, TickRequest,
} from '../service/gate-http/_gate-session-runtime';
import type { VerdictHistoryEntry } from '../service/session/types';
import type { CompiledConfig, OrchestrateParams, VerdictResult } from '../engine/types';
import type {
  CandidateRecord, SoakManifest, SoakSidecar,
} from '../engine/types/recalibration';

const { createAuditWriter } = require('../dist/engine/_audit-writer');

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const BASELINE: Record<string, number> = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

function degradedMetrics(): Record<string, number> {
  return { ...BASELINE, p99_latency: BASELINE.p99_latency * 2.5, ttft: BASELINE.ttft * 2.2 };
}

// ────────────────────────────────────────────────────────────────────
// Deterministic evaluate() stand-in. Keyed only off
// `params.compiledConfig` presence (served: null in this harness;
// candidate: always set once enrolled) and `liveMetrics.p99_latency` —
// isolates these tests from real detector threshold math.
// ────────────────────────────────────────────────────────────────────

function fakeEvaluateFn(): (params: OrchestrateParams) => VerdictResult {
  return (params: OrchestrateParams): VerdictResult => {
    const isCandidate = params.compiledConfig != null;
    const metrics = params.liveMetrics as Record<string, number>;
    const degraded = (metrics.p99_latency ?? 0) > BASELINE.p99_latency;
    const rollback = isCandidate && degraded;
    const verdict = rollback ? 'rollback' : 'extend';
    const families: Array<'A' | 'B' | 'C' | 'D' | 'E'> = rollback ? ['C'] : [];
    return {
      verdict,
      reason: 'gate-soak-test-stub',
      shortCircuit: null,
      gateResults: {
        fusion: {
          verdict,
          firing_families: families,
          per_family_verdicts: {
            A: null, B: null, C: null, D: null, E: null,
          },
          total_alpha_spent: isCandidate ? 0.0007 : 0.0003,
          fusion_topology: 'cascade',
          tick: params.tick,
          deploy_ref: params.scenario.id,
        },
      },
      healthResult: {
        rollback: rollback ? [{ id: 'stub_family_c_shift', label: 'stub' }] : [],
        extend: [],
        warmup: {
          active: false, grace: false, pct: 1, suppressedIds: [],
        },
        suppressed: [],
      },
      failFastState: params.failFastState,
      lifecycleState: params.lifecycleState,
      reversibilityClassification: params.reversibilityClassification,
    } as unknown as VerdictResult;
  };
}

// ────────────────────────────────────────────────────────────────────
// Harness.
// ────────────────────────────────────────────────────────────────────

interface Harness {
  storeDir: string;
  baselineHistoryDir: string;
  serviceId: string;
  store: SessionStore;
  emitter: JsonlLifecycleEventEmitter;
  auditWriter: ReturnType<typeof createAuditWriter>;
  runtime: GateSessionRuntime;
}

function makeHarness(overrides: Partial<GateRuntimeConfig> = {}): Harness {
  const storeDir = tmpRoot('ds-gate-soak-store-');
  const baselineHistoryDir = tmpRoot('ds-gate-soak-baseline-');
  const serviceId = overrides.serviceId ?? 'svc-a';
  const store = SessionStore.init(storeDir, serviceId);
  const emitter = new JsonlLifecycleEventEmitter(path.join(storeDir, serviceId, 'events.jsonl'));
  const auditWriter = createAuditWriter({ dir: path.join(storeDir, serviceId, 'audit'), service: serviceId });
  const cfg: GateRuntimeConfig = {
    storeDir, baselineHistoryDir, serviceId,
    mode: 'enforce', failPolicy: 'fail_closed',
    totalTicksDefault: 8, sessionTtlSeconds: 3600,
    ...overrides,
  };
  const runtime = new GateSessionRuntime(cfg, store, emitter, auditWriter);
  return {
    storeDir, baselineHistoryDir, serviceId, store, emitter, auditWriter, runtime,
  };
}

function beginReq(overrides: Partial<BeginSessionRequest> = {}): BeginSessionRequest {
  return {
    deploy_ref: 'deploy-ref-1',
    requested_at_ts: 1_700_000_000,
    scenario: { baseline: BASELINE },
    ...overrides,
  };
}

function tickReq(emittedAtTs: number, metrics: Record<string, number> = BASELINE): TickRequest {
  return { emitted_at_ts: emittedAtTs, metrics };
}

function redactRecordedAt(e: VerdictHistoryEntry): Omit<VerdictHistoryEntry, 'recorded_at'> {
  const { recorded_at: _recorded_at, ...rest } = e;
  return rest;
}

// ────────────────────────────────────────────────────────────────────
// Recalibration-store fixture (hand-written, per plan Task 7 harness
// note — no dependency on tools/recalibrate/*, mirrors
// service/session/active-calibration.ts's read-side file contract).
// ────────────────────────────────────────────────────────────────────

function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

function stubCandidateConfig(version: string): CompiledConfig {
  return {
    version,
    compiler_version: '0.3.0',
    compiled_at: '2026-07-01T00:00:00.000Z',
    baseline_ref: 'synthetic-v1@seed=42',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, C: 2e-4 } },
    family_c_signals: ['p99_latency'],
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{ key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' }],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 185, baseline_sigma_squared: 100, tau_squared: 100, delta_min: 5,
            },
          },
        },
        family_C: { mean_vector: [185], covariance: [[100]] },
      },
    },
  } as CompiledConfig;
}

interface SoakFixture {
  candidateId: string;
  serviceDir: string;
  manifestPath: string;
  configPath: string;
}

function seedSoak(
  baselineHistoryDir: string,
  serviceId: string,
  opts: { candidateId?: string; targetTicks?: number; requestedAtTs?: number } = {},
): SoakFixture {
  const candidateId = opts.candidateId ?? 'cand-soak-1';
  const serviceDir = path.join(baselineHistoryDir, serviceId);
  const configPath = path.join(serviceDir, 'compiled-configs', `${candidateId}.json`);
  writeJson(configPath, stubCandidateConfig(`${candidateId}@seed=1`));

  const candidateRecord: CandidateRecord = {
    schema_version: '1',
    service_id: serviceId,
    candidate_id: candidateId,
    proposed_baseline_version: `${candidateId}@seed=1`,
    current_baseline_version: 'v0@seed=0',
    direction_classification: 'mixed',
    per_signal_direction: {},
    suggested_reason_codes: [],
    shadow_mode_validated_at: '2026-07-01T00:00:00.000Z',
    timeout_at: '2026-12-01T00:00:00.000Z',
    status: 'candidate',
    review_status: 'reviewable',
    creation_reason: 'operator_manual',
    created_at: '2026-07-01T00:00:00.000Z',
    source_window: {
      start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', n_samples: 100, excluded_windows_applied: 0,
    },
    compiled_config_path: configPath,
    outcome: null,
    history: [],
  };
  writeJson(path.join(serviceDir, 'candidates', `${candidateId}.json`), candidateRecord);

  const manifest: SoakManifest = {
    schema_version: '1',
    candidate_id: candidateId,
    requested_at: new Date((opts.requestedAtTs ?? 1_700_000_000) * 1000).toISOString(),
    requested_by: 'test-operator',
    window: { target_ticks: opts.targetTicks ?? 200 },
    status: 'requested',
  };
  const manifestPath = path.join(serviceDir, 'soak.json');
  writeJson(manifestPath, manifest);

  return {
    candidateId, serviceDir, manifestPath, configPath,
  };
}

function sidecarPath(fixture: SoakFixture): string {
  return path.join(fixture.serviceDir, 'soak', `${fixture.candidateId}.state.json`);
}

function readSidecar(fixture: SoakFixture): SoakSidecar {
  return JSON.parse(fs.readFileSync(sidecarPath(fixture), 'utf8')) as SoakSidecar;
}

function readTicksJsonl(fixture: SoakFixture): unknown[] {
  const p = path.join(fixture.serviceDir, 'soak', `${fixture.candidateId}.ticks.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

function readEvents(fixture: SoakFixture): Array<{ type: string; payload: Record<string, unknown>; at: string }> {
  const p = path.join(fixture.serviceDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

// ────────────────────────────────────────────────────────────────────
// 1. Non-interference: served output identical with soak on/off.
// ────────────────────────────────────────────────────────────────────

test('non-interference: served TickResult + runtime snapshot + verdicts.jsonl are byte-identical whether soak is active or not', () => {
  const evalFn = fakeEvaluateFn();

  const without = makeHarness({ totalTicksDefault: 6 });
  without.runtime.setEvaluateFnForTest(evalFn);
  const { record: r1 } = without.runtime.begin(beginReq());
  const resultsWithout = [];
  for (let i = 0; i < 4; i++) {
    const metrics = i >= 2 ? degradedMetrics() : BASELINE;
    resultsWithout.push(without.runtime.ingestTick(r1.session_id, tickReq(1_700_000_000 + i * 30, metrics)));
  }
  const snapWithout = without.runtime.getRuntimeStateSnapshotForTest(r1.session_id);
  const verdictsWithout = without.store.readVerdictHistory(r1.session_id).map(redactRecordedAt);
  without.runtime.close();

  const withSoak = makeHarness({ totalTicksDefault: 6 });
  const fixture = seedSoak(withSoak.baselineHistoryDir, withSoak.serviceId, { targetTicks: 50 });
  withSoak.runtime.setEvaluateFnForTest(evalFn);
  const { record: r2 } = withSoak.runtime.begin(beginReq());
  const resultsWith = [];
  for (let i = 0; i < 4; i++) {
    const metrics = i >= 2 ? degradedMetrics() : BASELINE;
    resultsWith.push(withSoak.runtime.ingestTick(r2.session_id, tickReq(1_700_000_000 + i * 30, metrics)));
  }
  const snapWith = withSoak.runtime.getRuntimeStateSnapshotForTest(r2.session_id);
  const verdictsWith = withSoak.store.readVerdictHistory(r2.session_id).map(redactRecordedAt);
  withSoak.runtime.close();

  assert.deepEqual(resultsWith, resultsWithout, 'served TickResult sequence must be identical');
  assert.deepEqual(snapWith, snapWithout, 'served in-memory accumulator state must be identical');
  assert.deepEqual(verdictsWith, verdictsWithout, 'durable verdicts.jsonl (minus wall-clock recorded_at) must be identical');

  // Sanity: soak was genuinely active in the "with" run (not a vacuous
  // comparison) — it shadow-evaluated every tick and accumulated stats.
  const sidecar = readSidecar(fixture);
  assert.equal(sidecar.stats.ticks_observed, 4);
  assert.equal(sidecar.stats.coverage.sessions_enrolled, 1);
});

// ────────────────────────────────────────────────────────────────────
// 2. Disagreement accumulation.
// ────────────────────────────────────────────────────────────────────

test('disagreement accumulation: degraded metrics under a tight candidate config produce candidate_only would-be-rollback, per-family and alpha split', () => {
  const h = makeHarness({ totalTicksDefault: 8 });
  const fixture = seedSoak(h.baselineHistoryDir, h.serviceId, { targetTicks: 50 });
  h.runtime.setEvaluateFnForTest(fakeEvaluateFn());

  const { record } = h.runtime.begin(beginReq());
  for (let i = 0; i < 4; i++) {
    const metrics = i >= 1 ? degradedMetrics() : BASELINE; // ticks 1,2,3 degraded
    h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000 + i * 30, metrics));
  }
  h.runtime.close();

  const sidecar = readSidecar(fixture);
  assert.equal(sidecar.stats.ticks_observed, 4);
  assert.equal(sidecar.stats.coverage.sessions_enrolled, 1);
  assert.equal(sidecar.stats.disagreement.total_compared, 4);
  assert.equal(sidecar.stats.disagreement.verdict_disagreements, 3);
  assert.deepEqual(sidecar.stats.disagreement.by_pair, { 'extend->rollback': 3 });
  assert.deepEqual(sidecar.stats.disagreement.would_be_rollback, { active_only: 0, candidate_only: 3, both: 0 });
  assert.equal(sidecar.stats.per_family.C.candidate_fires, 3);
  assert.equal(sidecar.stats.per_family.C.active_fires, 0);
  assert.ok(sidecar.stats.alpha_spent.candidate_total > sidecar.stats.alpha_spent.active_total);

  const ticks = readTicksJsonl(fixture);
  assert.equal(ticks.length, 4);
});

// ────────────────────────────────────────────────────────────────────
// 3. Replay double-count protection.
// ────────────────────────────────────────────────────────────────────

test('replay protection: a replayed tick never reaches the soak controller — sidecar and ticks.jsonl are byte-identical before/after', () => {
  const h = makeHarness({ totalTicksDefault: 8 });
  const fixture = seedSoak(h.baselineHistoryDir, h.serviceId, { targetTicks: 50 });
  h.runtime.setEvaluateFnForTest(fakeEvaluateFn());
  const { record } = h.runtime.begin(beginReq());

  const first = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000, BASELINE));
  assert.equal(first.replayed, false);
  const sidecarBefore = readSidecar(fixture);
  const ticksBefore = readTicksJsonl(fixture);

  const replay = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000, BASELINE));
  assert.equal(replay.replayed, true);

  const sidecarAfter = readSidecar(fixture);
  const ticksAfter = readTicksJsonl(fixture);
  assert.deepEqual(sidecarAfter, sidecarBefore, 'a replay must not mutate the sidecar');
  assert.deepEqual(ticksAfter, ticksBefore, 'a replay must not append a second ticks.jsonl line');

  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// 4. Mid-stream fairness.
// ────────────────────────────────────────────────────────────────────

test('mid-stream fairness: a session already ticking when soak.json appears is skipped (counted once); a fresh session enrolls', () => {
  const h = makeHarness({ totalTicksDefault: 10 });
  h.runtime.setEvaluateFnForTest(fakeEvaluateFn());

  const { record: earlySession } = h.runtime.begin(beginReq());
  h.runtime.ingestTick(earlySession.session_id, tickReq(1_700_000_000, BASELINE)); // tick 0, soak not active yet

  const fixture = seedSoak(h.baselineHistoryDir, h.serviceId, { targetTicks: 50 });

  h.runtime.ingestTick(earlySession.session_id, tickReq(1_700_000_030, BASELINE)); // entry tick 1: mid-stream

  const sidecarAfterSkip = readSidecar(fixture);
  assert.equal(sidecarAfterSkip.stats.coverage.sessions_skipped_midstream, 1);
  assert.equal(sidecarAfterSkip.stats.coverage.sessions_enrolled, 0);
  assert.equal(sidecarAfterSkip.stats.ticks_observed, 0, 'a skipped session contributes no accumulated ticks');

  const { record: freshSession } = h.runtime.begin(beginReq({ deploy_ref: 'deploy-ref-2', requested_at_ts: 1_700_000_100 }));
  h.runtime.ingestTick(freshSession.session_id, tickReq(1_700_000_100, BASELINE)); // entry tick 0: enrolls

  const sidecarAfterEnroll = readSidecar(fixture);
  assert.equal(sidecarAfterEnroll.stats.coverage.sessions_enrolled, 1);
  assert.equal(sidecarAfterEnroll.stats.coverage.sessions_skipped_midstream, 1);
  assert.equal(sidecarAfterEnroll.stats.ticks_observed, 1);

  // A further tick on the same (already-skipped) early session must
  // never enroll or be counted as skipped a second time.
  h.runtime.ingestTick(earlySession.session_id, tickReq(1_700_000_130, BASELINE));
  const sidecarFinal = readSidecar(fixture);
  assert.equal(sidecarFinal.stats.coverage.sessions_skipped_midstream, 1, 'skip is recorded once, not per-tick');
  assert.equal(sidecarFinal.stats.coverage.sessions_enrolled, 1);

  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// 5. Restart honesty.
// ────────────────────────────────────────────────────────────────────

test('restart honesty: sidecar retains flushed stats across a restart and gains exactly one service_restart void entry; a fresh session keeps accumulating into the same sidecar', () => {
  const storeDir = tmpRoot('ds-gate-soak-restart-store-');
  const baselineHistoryDir = tmpRoot('ds-gate-soak-restart-baseline-');
  const serviceId = 'svc-a';
  const fixture = seedSoak(baselineHistoryDir, serviceId, { targetTicks: 50 });

  const store = SessionStore.init(storeDir, serviceId);
  const emitter = new JsonlLifecycleEventEmitter(path.join(storeDir, serviceId, 'events.jsonl'));
  const auditWriter = createAuditWriter(null);
  const cfg: GateRuntimeConfig = {
    storeDir, baselineHistoryDir, serviceId,
    mode: 'enforce', failPolicy: 'fail_closed', totalTicksDefault: 8, sessionTtlSeconds: 3600,
  };

  const runtime1 = new GateSessionRuntime(cfg, store, emitter, auditWriter);
  runtime1.setEvaluateFnForTest(fakeEvaluateFn());
  const { record } = runtime1.begin(beginReq());
  runtime1.ingestTick(record.session_id, tickReq(1_700_000_000, BASELINE));
  runtime1.ingestTick(record.session_id, tickReq(1_700_000_030, degradedMetrics()));
  runtime1.close();

  const sidecarBeforeRestart = readSidecar(fixture);
  assert.equal(sidecarBeforeRestart.stats.ticks_observed, 2);
  assert.equal(sidecarBeforeRestart.voids.length, 0);
  assert.equal(sidecarBeforeRestart.status, 'accumulating');

  const runtime2 = new GateSessionRuntime(cfg, store, emitter, auditWriter);
  runtime2.setEvaluateFnForTest(fakeEvaluateFn());

  const sidecarAfterRestart = readSidecar(fixture);
  assert.equal(sidecarAfterRestart.voids.length, 1, 'construction must append exactly one restart-honesty void entry');
  assert.equal(sidecarAfterRestart.voids[0].reason, 'service_restart');
  assert.equal(sidecarAfterRestart.stats.ticks_observed, 2, 'flushed pre-restart stats survive');
  assert.equal(sidecarAfterRestart.stats.coverage.sessions_enrolled, 1);

  runtime2.sweepOnBoot();
  const { record: freshRecord } = runtime2.begin(beginReq({ deploy_ref: 'deploy-ref-2', requested_at_ts: 1_700_000_100 }));
  runtime2.ingestTick(freshRecord.session_id, tickReq(1_700_000_100, BASELINE));

  const sidecarFinal = readSidecar(fixture);
  assert.equal(sidecarFinal.stats.ticks_observed, 3, 'a fresh session keeps accumulating into the SAME per-candidate sidecar');
  assert.equal(sidecarFinal.stats.coverage.sessions_enrolled, 2);
  assert.equal(sidecarFinal.voids.length, 1, 'no additional void entries from a clean second construction');

  runtime2.close();
});

// ────────────────────────────────────────────────────────────────────
// 6. Completion at target_ticks.
// ────────────────────────────────────────────────────────────────────

test('completion: sidecar reaches status complete at target_ticks and exactly one recalibration.soak_completed event is appended; further ticks are ignored', () => {
  const h = makeHarness({ totalTicksDefault: 10 });
  const fixture = seedSoak(h.baselineHistoryDir, h.serviceId, { targetTicks: 3 });
  h.runtime.setEvaluateFnForTest(fakeEvaluateFn());
  const { record } = h.runtime.begin(beginReq());

  for (let i = 0; i < 3; i++) {
    h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000 + i * 30, BASELINE));
  }

  const sidecarAt3 = readSidecar(fixture);
  assert.equal(sidecarAt3.status, 'complete');
  assert.ok(sidecarAt3.completed_at);
  assert.equal(sidecarAt3.stats.ticks_observed, 3);

  const completions = readEvents(fixture).filter((e) => e.type === 'recalibration.soak_completed');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].payload.candidate_id, fixture.candidateId);
  assert.equal(completions[0].payload.ticks_observed, 3);

  // Tick 4+ (session stays active: totalTicksDefault 10) must be ignored
  // by the soak side — no re-accumulation, no re-emit.
  h.runtime.ingestTick(record.session_id, tickReq(1_700_000_090, BASELINE));
  const sidecarAt4 = readSidecar(fixture);
  assert.deepEqual(sidecarAt4, sidecarAt3);
  const eventsAfter = readEvents(fixture).filter((e) => e.type === 'recalibration.soak_completed');
  assert.equal(eventsAfter.length, 1);

  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// 7. Error isolation (plan Task 7 item 6 — deferred from the initial
// Tasks 1-3 runtime pass, added now).
// ────────────────────────────────────────────────────────────────────

/** Variant of fakeEvaluateFn where the CANDIDATE (shadow) side always
 *  throws, regardless of metrics — stands in for "a candidate whose
 *  config makes evaluate() throw" (plan Task 7 item 6 note: a per-call
 *  seam that throws only on the second evaluateFn call per tick isn't
 *  possible with the shared `setEvaluateFnForTest` seam, so this
 *  isolates the failure to whichever call carries a non-null
 *  `compiledConfig` — i.e. always the shadow call in this harness, never
 *  the served call). */
function fakeEvaluateFnCandidateThrows(): (params: OrchestrateParams) => VerdictResult {
  return (params: OrchestrateParams): VerdictResult => {
    if (params.compiledConfig != null) {
      throw new Error('gate-soak-test: candidate evaluate stub failure');
    }
    return {
      verdict: 'extend',
      reason: 'gate-soak-test-stub',
      shortCircuit: null,
      gateResults: {
        fusion: {
          verdict: 'extend',
          firing_families: [],
          per_family_verdicts: {
            A: null, B: null, C: null, D: null, E: null,
          },
          total_alpha_spent: 0.0003,
          fusion_topology: 'cascade',
          tick: params.tick,
          deploy_ref: params.scenario.id,
        },
      },
      healthResult: {
        rollback: [],
        extend: [],
        warmup: {
          active: false, grace: false, pct: 1, suppressedIds: [],
        },
        suppressed: [],
      },
      failFastState: params.failFastState,
      lifecycleState: params.lifecycleState,
      reversibilityClassification: params.reversibilityClassification,
    } as unknown as VerdictResult;
  };
}

test('error isolation: an unloadable candidate compiled_config_path leaves soak permanently inactive; served ticks are unaffected', () => {
  const h = makeHarness({ totalTicksDefault: 8 });
  const fixture = seedSoak(h.baselineHistoryDir, h.serviceId, { targetTicks: 50 });
  fs.writeFileSync(fixture.configPath, '{ not valid json');
  h.runtime.setEvaluateFnForTest(fakeEvaluateFn());

  const { record } = h.runtime.begin(beginReq());
  const results = [];
  for (let i = 0; i < 3; i++) {
    const metrics = i >= 1 ? degradedMetrics() : BASELINE;
    results.push(h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000 + i * 30, metrics)));
  }
  h.runtime.close();

  for (const r of results) {
    assert.equal(r.verdict, 'extend', 'served path (no active.json in this harness) never rolls back');
    assert.equal(r.error, undefined, 'a shadow-side activation failure must never surface on the served TickResult');
  }
  assert.equal(fs.existsSync(sidecarPath(fixture)), false, 'an unloadable candidate config means soak never activates -> no sidecar is ever created');
});

test('error isolation: a shadow-side evaluate() throw never surfaces in the served TickResult; only candidate_errored_ticks increments', () => {
  const h = makeHarness({ totalTicksDefault: 8 });
  const fixture = seedSoak(h.baselineHistoryDir, h.serviceId, { targetTicks: 50 });
  h.runtime.setEvaluateFnForTest(fakeEvaluateFnCandidateThrows());

  const { record } = h.runtime.begin(beginReq());
  const results = [];
  for (let i = 0; i < 3; i++) {
    results.push(h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000 + i * 30, BASELINE)));
  }
  h.runtime.close();

  for (const r of results) {
    assert.equal(r.verdict, 'extend');
    assert.equal(r.error, undefined, 'a shadow-side throw must never surface as a served-tick error');
  }

  const sidecar = readSidecar(fixture);
  assert.equal(sidecar.stats.ticks_observed, 3, 'the soak controller still observed every tick');
  assert.equal(sidecar.stats.coverage.candidate_errored_ticks, 3);
  assert.equal(sidecar.stats.coverage.active_errored_ticks, 0);
  assert.equal(sidecar.stats.disagreement.total_compared, 0, 'an errored candidate tick is never compared');
});

// ────────────────────────────────────────────────────────────────────
// 8. Review fix 1 — mtime-cache robustness (same-instant manifest
// rewrite must still be detected via the content identity check).
// ────────────────────────────────────────────────────────────────────

test('mtime-cache robustness: a same-instant manifest rewrite (identical mtimeMs + size) is still detected via the content identity check', () => {
  const h = makeHarness({ totalTicksDefault: 10 });
  const fixtureA = seedSoak(h.baselineHistoryDir, h.serviceId, {
    candidateId: 'cand-soak-1', targetTicks: 50, requestedAtTs: 1_700_000_000,
  });
  h.runtime.setEvaluateFnForTest(fakeEvaluateFn());

  const { record: sessionA } = h.runtime.begin(beginReq());
  h.runtime.ingestTick(sessionA.session_id, tickReq(1_700_000_000, BASELINE));
  assert.equal(readSidecar(fixtureA).stats.ticks_observed, 1);

  const manifestPath = fixtureA.manifestPath;
  const statBefore = fs.statSync(manifestPath);

  // Rewrite soak.json to point at a DIFFERENT candidate id of the SAME
  // length ('cand-soak-1' -> 'cand-soak-2', 11 chars each) with the same
  // `requested_at`, so the new manifest's JSON byte length is identical
  // to the old one's — then force fs.utimesSync to make the mtime match
  // too. This reproduces the exact edge case a pure (mtimeMs) or even
  // (mtimeMs, size) comparison alone would miss.
  const fixtureB = seedSoak(h.baselineHistoryDir, h.serviceId, {
    candidateId: 'cand-soak-2', targetTicks: 50, requestedAtTs: 1_700_000_000,
  });
  const statAfterRewrite = fs.statSync(manifestPath);
  assert.equal(statAfterRewrite.size, statBefore.size, 'precondition: the rewritten manifest is byte-identical in length');
  // Pass raw fractional seconds (not a `Date`, which truncates to
  // millisecond precision) so the forced mtime matches statBefore.mtimeMs
  // exactly, not just to the nearest millisecond.
  const forcedSeconds = statBefore.mtimeMs / 1000;
  fs.utimesSync(manifestPath, forcedSeconds, forcedSeconds);
  const statForced = fs.statSync(manifestPath);
  assert.equal(statForced.mtimeMs, statBefore.mtimeMs, 'precondition: mtimeMs now matches the pre-rewrite manifest exactly');

  // A fresh session ticking now must enroll into candidate B's sidecar
  // (the manifest DID change, despite identical mtimeMs + size) — not
  // candidate A's.
  const { record: sessionB } = h.runtime.begin(beginReq({ deploy_ref: 'deploy-ref-2', requested_at_ts: 1_700_000_100 }));
  h.runtime.ingestTick(sessionB.session_id, tickReq(1_700_000_100, BASELINE));
  h.runtime.close();

  const sidecarB = readSidecar(fixtureB);
  assert.equal(sidecarB.stats.ticks_observed, 1, 'the new manifest (same mtime+size) was still picked up');
  assert.equal(sidecarB.stats.coverage.sessions_enrolled, 1);

  const sidecarAAfter = readSidecar(fixtureA);
  assert.equal(sidecarAAfter.stats.ticks_observed, 1, 'candidate A stopped accumulating once the manifest switched to candidate B');
});

// ────────────────────────────────────────────────────────────────────
// 9. Review fix 2 — same-candidate re-soak (a completed sidecar must
// not be a dead end for a genuinely newer soak request).
// ────────────────────────────────────────────────────────────────────

test('same-candidate re-soak: a newer manifest for an already-completed candidate archives the old sidecar and starts a fresh accumulation', () => {
  const h = makeHarness({ totalTicksDefault: 10 });
  const fixture = seedSoak(h.baselineHistoryDir, h.serviceId, {
    candidateId: 'cand-resoak', targetTicks: 2, requestedAtTs: 1_700_000_000,
  });
  h.runtime.setEvaluateFnForTest(fakeEvaluateFn());

  const { record: firstSoak } = h.runtime.begin(beginReq());
  h.runtime.ingestTick(firstSoak.session_id, tickReq(1_700_000_000, BASELINE));
  h.runtime.ingestTick(firstSoak.session_id, tickReq(1_700_000_030, BASELINE));

  const completedSidecar = readSidecar(fixture);
  assert.equal(completedSidecar.status, 'complete');
  assert.equal(completedSidecar.stats.ticks_observed, 2);

  // A new soak.json for the SAME candidate id, requested strictly after
  // the completed sidecar's own started_at.
  seedSoak(h.baselineHistoryDir, h.serviceId, {
    candidateId: 'cand-resoak', targetTicks: 2, requestedAtTs: 1_700_000_200,
  });

  const { record: secondSoak } = h.runtime.begin(beginReq({ deploy_ref: 'deploy-ref-resoak', requested_at_ts: 1_700_000_200 }));
  h.runtime.ingestTick(secondSoak.session_id, tickReq(1_700_000_200, BASELINE));
  h.runtime.close();

  const freshSidecar = readSidecar(fixture);
  assert.equal(freshSidecar.status, 'accumulating');
  assert.equal(freshSidecar.stats.ticks_observed, 1, 're-soak starts a fresh accumulation, not a continuation of the completed one');
  assert.equal(freshSidecar.stats.coverage.sessions_enrolled, 1);

  const soakDir = path.join(fixture.serviceDir, 'soak');
  const archivedSidecars = fs.readdirSync(soakDir).filter(
    (f) => f.startsWith('cand-resoak.state.') && f !== 'cand-resoak.state.json',
  );
  assert.equal(archivedSidecars.length, 1, 'the completed sidecar was archived under a started_at-suffixed name');
  const archived = JSON.parse(fs.readFileSync(path.join(soakDir, archivedSidecars[0]), 'utf8'));
  assert.equal(archived.status, 'complete');
  assert.equal(archived.stats.ticks_observed, 2, 'the archived sidecar retains the completed soak\'s full evidence');
});

test('same-candidate re-soak: a manifest that is NOT newer than the completed sidecar leaves soak inactive (no dead-end regression, no spurious archive)', () => {
  const h = makeHarness({ totalTicksDefault: 10 });
  const fixture = seedSoak(h.baselineHistoryDir, h.serviceId, {
    candidateId: 'cand-resoak-2', targetTicks: 2, requestedAtTs: 1_700_000_000,
  });
  h.runtime.setEvaluateFnForTest(fakeEvaluateFn());

  const { record } = h.runtime.begin(beginReq());
  h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000, BASELINE));
  h.runtime.ingestTick(record.session_id, tickReq(1_700_000_030, BASELINE));
  const completedSidecar = readSidecar(fixture);
  assert.equal(completedSidecar.status, 'complete');

  // Re-write the SAME manifest verbatim (requested_at unchanged, i.e.
  // NOT newer than the completed sidecar's started_at) — must not
  // reactivate or archive anything.
  seedSoak(h.baselineHistoryDir, h.serviceId, {
    candidateId: 'cand-resoak-2', targetTicks: 2, requestedAtTs: 1_700_000_000,
  });
  fs.utimesSync(fixture.manifestPath, new Date(), new Date());

  const { record: laterSession } = h.runtime.begin(beginReq({ deploy_ref: 'deploy-ref-resoak-2', requested_at_ts: 1_700_000_500 }));
  h.runtime.ingestTick(laterSession.session_id, tickReq(1_700_000_500, BASELINE));
  h.runtime.close();

  const sidecarAfter = readSidecar(fixture);
  assert.deepEqual(sidecarAfter, completedSidecar, 'a non-newer manifest for a completed candidate must not reactivate or mutate the sidecar');

  const soakDir = path.join(fixture.serviceDir, 'soak');
  const archivedSidecars = fs.readdirSync(soakDir).filter(
    (f) => f.startsWith('cand-resoak-2.state.') && f !== 'cand-resoak-2.state.json',
  );
  assert.equal(archivedSidecars.length, 0, 'no archive happens without a genuinely newer soak request');
});
