// test/recalibration-invariants.test.ts — Addition #15 baseline-
// maintenance lifecycle, Task 10. Invariant + e2e integration tests
// across the whole propose -> shadow -> {approve|reject|auto_promote|
// timeout} pipeline (Tasks 1-9), exercised against a REAL engine
// evaluation of a real canned-demo degraded stream — not just unit
// fixtures — so a bug that silently disabled detection while a
// recalibration was in flight would actually show up here.
//
// Pattern for the orchestrate/drift-detector plumbing mirrors
// test/demo-drift.test.ts and test/canned-demo-right-reasons.test.ts's
// demo-baseline-maintenance drift check (require('../shared'), engine
// orchestrate + TrendBuffer, cell (14, 2) — v4-fusion-novelty.json's
// calibrated cell, demo-github-2020's currentHourOfDay/currentDayOfWeek)
// — duplicated locally per those files' own "same duplication pattern
// as test/dress-rehearsal.test.ts" convention (test isolation from
// engine-internal refactors of the shared helper).
//
// All shadow validation below runs `--dry-run` (Q60 dry-run stub-emits
// zero firing counts for every substrate -> acceptance gates trivially
// pass), per the q60 test pattern (test/q60-run-shadow-compare.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type { CompiledConfig, OrchestrateParams, AuditRecordV2 } from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');
const { loadDemoScript } = require('../demos/load-demo');
const { evaluateBaselineDrift } = require('../dist/engine/drift/baseline-drift-detector');

import {
  RecalibrationStore, JsonlLifecycleEventEmitter, type ActivePointer,
} from '../tools/recalibrate/_recalibrate-store';
import { InMemoryLifecycleEventEmitter } from '../engine/o0/lifecycle-events';
import {
  runPropose, runShadow, runApprove, runReject, runList, runCheck,
} from '../tools/recalibrate/_recalibrate-cli';
import { validateDeployPinning } from '../engine/recalibration/pinning';
import type { FamilyVerdictV2, DetectorTripV2 } from '../engine/types';

const ROOT = path.resolve(__dirname, '..');
const V4_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');
const DEMOS_DIR = path.join(ROOT, 'demos', 'scripts');

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recalibration-invariants-'));
}

function seedActive(store: RecalibrationStore, pointer: ActivePointer): void {
  fs.writeFileSync(path.join(store.dir, 'active.json'), JSON.stringify(pointer));
}

// ── degraded / improved candidate config builders ────────────────────
//
// Both mutate v4's aggregate_fallback family_A per_signal + family_C
// mean_vector consistently (same multiplier applied wherever a signal
// appears in either block — compareCandidateVsActive's extractSignalMeans
// prefers family_C on overlap, but family_A-only signals like eval_score/
// tool_success_rate must move too) so classification is deterministic
// regardless of which extraction path wins. Verified empirically against
// the real classify.ts/compare.ts modules before being locked in here:
// the degraded builder yields direction_classification 'degradation'
// with zero 'improved' signals; the improved builder yields 'improvement'
// with zero 'degraded' signals (informational signals left unchanged —
// classifySignal degrades an informational signal on ANY move, so
// leaving cost_req/tokens_turn/kv_cache/corpus_delta untouched is
// required to keep the improvement fixture pure).

const FAMILY_C_ORDER = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops', 'corpus_delta', 'traffic_pct',
];

const WORSE_MULTIPLIER: Record<string, number> = {
  p99_latency: 1.3, ttft: 1.3, tokens_turn: 1.1, kv_cache: 1.1, cost_req: 1.5,
  downstream_err: 2.0, mfu: 0.7, hbm_spill: 1.3, collective_ops: 0.9, corpus_delta: 1.2,
  traffic_pct: 1, eval_score: 0.7, tool_success_rate: 0.7,
};

const BETTER_MULTIPLIER: Record<string, number> = {
  p99_latency: 0.85, ttft: 0.85, downstream_err: 0.5, hbm_spill: 0.8,
  eval_score: 1.15, tool_success_rate: 1.1, mfu: 1.1, collective_ops: 1.05,
  tokens_turn: 1, kv_cache: 1, cost_req: 1, corpus_delta: 1, traffic_pct: 1,
};

function mutatedCandidateConfig(
  active: CompiledConfig, version: string, multipliers: Record<string, number>,
): CompiledConfig {
  const cfg = JSON.parse(JSON.stringify(active)) as CompiledConfig;
  cfg.version = version;
  const famA = cfg.baseline_cells!.aggregate_fallback.family_A!.per_signal as Record<string, { baseline_mean: number }>;
  for (const sig of Object.keys(famA)) {
    const mult = multipliers[sig];
    if (mult !== undefined) famA[sig].baseline_mean *= mult;
  }
  const mv = cfg.baseline_cells!.aggregate_fallback.family_C!.mean_vector;
  FAMILY_C_ORDER.forEach((sig, idx) => {
    const mult = multipliers[sig];
    if (mult !== undefined) mv[idx] *= mult;
  });
  return cfg;
}

function degradedCandidateConfig(active: CompiledConfig, version: string): CompiledConfig {
  return mutatedCandidateConfig(active, version, WORSE_MULTIPLIER);
}

function improvedCandidateConfig(active: CompiledConfig, version: string): CompiledConfig {
  return mutatedCandidateConfig(active, version, BETTER_MULTIPLIER);
}

// ── minimal portfolio-mode demo runner (test/demo-drift.test.ts's
//    runDemo, trimmed to what this file needs) ───────────────────────

interface DemoTick { metrics: Record<string, number>; pause_beat?: boolean }
interface CannedDemo {
  id: string;
  baseline: Record<string, number>;
  ticks: DemoTick[];
  riskLevel: string; changeType: string; author: string; timeWindow: string;
  flags: Record<string, unknown>; bakeHours: number;
  currentHourOfDay: number; currentDayOfWeek: number;
  expected_outcome: { verdict: string; portfolio_first_rollback_tick?: number };
}

interface PortfolioRunResult {
  finalVerdict: string;
  firstRollbackTick: number | null;
  anyFamilyFired: boolean;
}

function runPortfolioDemo(d: CannedDemo, cfg: CompiledConfig): PortfolioRunResult {
  const tb = new TrendBuffer(10);
  let firstRollback: number | null = null;
  let anyFamilyFired = false;
  for (let t = 0; t < d.ticks.length; t++) {
    const live = d.ticks[t].metrics;
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live as never,
      scenario: {
        baseline: d.baseline as never,
        riskLevel: d.riskLevel as never, changeType: d.changeType as never,
        author: d.author as never, timeWindow: d.timeWindow as never,
        flags: d.flags as never, bakeHours: d.bakeHours,
      },
      hoursElapsed: t * (d.bakeHours / d.ticks.length),
      trendBuffer: tb, tick: t, totalTicks: d.ticks.length,
      compiledConfig: cfg,
      currentHourOfDay: d.currentHourOfDay,
      currentDayOfWeek: d.currentDayOfWeek,
      fusionTopology: 'portfolio',
    };
    const res = orchestrate(params);
    const rec = buildAuditRecord(params, res, { service: d.id }) as { families?: Record<string, { verdict: string }> };
    if (rec.families) {
      for (const f of ['A', 'B', 'C', 'D', 'E']) {
        if (rec.families[f]?.verdict === 'fire') anyFamilyFired = true;
      }
    }
    if (res.verdict === 'rollback' && firstRollback === null) firstRollback = t;
  }
  return {
    finalVerdict: firstRollback !== null ? 'rollback' : 'proceed',
    firstRollbackTick: firstRollback,
    anyFamilyFired,
  };
}

function loadV4(): CompiledConfig {
  return JSON.parse(fs.readFileSync(V4_PATH, 'utf8')) as CompiledConfig;
}

function loadGithub2020(): CannedDemo {
  return loadDemoScript(path.join(DEMOS_DIR, 'demo-github-2020.json')) as CannedDemo;
}

/** Drift-fires check shared by invariants #1/#2 (mirrors test/canned-
 *  demo-right-reasons.test.ts's demo-baseline-maintenance drift check). */
function firstDriftFire(v4: CompiledConfig, demo: CannedDemo): { tick: number; output: unknown } {
  const rolling: Array<Record<string, number>> = [];
  for (let t = 0; t < demo.ticks.length; t++) {
    rolling.push(demo.ticks[t].metrics);
    const r = evaluateBaselineDrift(v4, { recentSamples: rolling, cell: { hour_of_day: 14, day_of_week: 2 } });
    if (r?.recalibration_recommended) return { tick: t, output: r };
  }
  throw new Error('firstDriftFire: drift detector never fired on the degraded stream');
}

const VALID_REASON = 'regression';

// ── #1 Rejection-preserves-alarms (load-bearing architectural invariant) ─

test('invariant #1: rejection preserves alarms — active baseline + its detection capability are untouched by a rejected candidate', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-invariant-1');
  const v4 = loadV4();
  const demo = loadGithub2020();

  seedActive(store, {
    schema_version: '1', version_id: v4.version, candidate_id: null,
    compiled_config_path: V4_PATH, baseline_ref: v4.baseline_ref,
    promoted_at: '2026-01-01T00:00:00.000Z', predecessor_version_id: null, promotion_history: [],
  });
  const beforeActiveBytes = fs.readFileSync(path.join(store.dir, 'active.json'), 'utf8');

  // Drift fires (recalibration_recommended) on the degraded stream.
  const drift = firstDriftFire(v4, demo);

  // Sanity: the OLD config fires on this stream BEFORE any of the
  // recalibration flow below runs, so the "still fires after" assertion
  // is a genuine before/after comparison, not a tautology.
  const beforeRun = runPortfolioDemo(demo, v4);
  assert.equal(beforeRun.finalVerdict, 'rollback');
  assert.ok(beforeRun.anyFamilyFired);

  const candidateConfig = degradedCandidateConfig(v4, 'v4-degraded-candidate@seed=99');
  const candidatePath = path.join(root, 'candidate-degraded.json');
  fs.writeFileSync(candidatePath, JSON.stringify(candidateConfig));

  // The REAL CLI-facing emitter (every production `recalibrate.ts`
  // invocation uses this) — needed so the operator_rejected event
  // actually lands in events.jsonl, not just an in-memory test buffer.
  const emitter = new JsonlLifecycleEventEmitter(store);
  const proposeResult = await runPropose(store, emitter, {
    candidateId: 'cand-degrade-1',
    candidateConfigPath: candidatePath,
    creationReason: 'drift_detected',
    sourceWindow: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z', n_samples: 80 },
    driftOutput: drift.output as object,
    now: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(proposeResult.exitCode, 0, proposeResult.lines.join('\n'));
  const proposed = store.readCandidate('cand-degrade-1');
  assert.equal(proposed.direction_classification, 'degradation');
  assert.equal(proposed.review_status, 'pending_shadow');

  const shadowResult = await runShadow(store, emitter, {
    candidateId: 'cand-degrade-1',
    scenarios: ['anthropic_tpu_output_corruption_step_2025_09'],
    seeds: [42],
    outputDir: path.join(store.dir, 'shadow-out'),
    dryRun: true,
    now: '2026-01-02T01:00:00.000Z',
  });
  assert.equal(shadowResult.exitCode, 0, shadowResult.lines.join('\n'));
  assert.equal(store.readCandidate('cand-degrade-1').review_status, 'reviewable');

  const rejectResult = await runReject(store, emitter, {
    candidateId: 'cand-degrade-1', reviewer: 'op-1', reasonCode: VALID_REASON, now: '2026-01-02T02:00:00.000Z',
  });
  assert.equal(rejectResult.exitCode, 0);
  const rejected = store.readCandidate('cand-degrade-1');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.outcome, 'operator_rejected');

  // D3: reject never touches active.json.
  const afterActiveBytes = fs.readFileSync(path.join(store.dir, 'active.json'), 'utf8');
  assert.equal(afterActiveBytes, beforeActiveBytes, 'active.json must be byte-identical after a reject');

  // The load-bearing check: re-resolve the active config THROUGH THE
  // STORE post-rejection and re-run the exact same degraded stream —
  // detectors still fire identically.
  const activeCfgPath = store.readActive()!.compiled_config_path;
  const activeCfg = JSON.parse(fs.readFileSync(activeCfgPath, 'utf8')) as CompiledConfig;
  const afterRun = runPortfolioDemo(demo, activeCfg);
  assert.equal(afterRun.finalVerdict, 'rollback', 'old config must still roll back on the same degraded stream after rejection');
  assert.equal(afterRun.firstRollbackTick, beforeRun.firstRollbackTick, 'fire timing must be unchanged');
  assert.ok(afterRun.anyFamilyFired, 'old config must still fire on the same degraded stream after rejection');

  // Rejection decision lands in the authoritative audit log.
  const events = store.readEvents();
  const rejectedEvent = events.find((e) => e.type === 'recalibration.operator_rejected');
  assert.ok(rejectedEvent, 'expected a recalibration.operator_rejected event in events.jsonl');
});

// ── #2 Timeout default-reject preserves alarms ────────────────────────

test('invariant #2: timeout default-rejection preserves alarms (no operator action)', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-invariant-2');
  const v4 = loadV4();
  const demo = loadGithub2020();

  seedActive(store, {
    schema_version: '1', version_id: v4.version, candidate_id: null,
    compiled_config_path: V4_PATH, baseline_ref: v4.baseline_ref,
    promoted_at: '2026-01-01T00:00:00.000Z', predecessor_version_id: null, promotion_history: [],
  });

  const drift = firstDriftFire(v4, demo);
  const candidateConfig = degradedCandidateConfig(v4, 'v4-degraded-candidate@seed=98');
  const candidatePath = path.join(root, 'candidate-degraded.json');
  fs.writeFileSync(candidatePath, JSON.stringify(candidateConfig));

  // Real CLI-facing emitter — sweepTimeouts's timeout_rejected event
  // must land in events.jsonl, not just an in-memory test buffer.
  const emitter = new JsonlLifecycleEventEmitter(store);
  const proposeNow = '2026-01-02T00:00:00.000Z';
  const proposeResult = await runPropose(store, emitter, {
    candidateId: 'cand-timeout-1',
    candidateConfigPath: candidatePath,
    creationReason: 'drift_detected',
    sourceWindow: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z', n_samples: 80 },
    driftOutput: drift.output as object,
    now: proposeNow,
  });
  assert.equal(proposeResult.exitCode, 0, proposeResult.lines.join('\n'));
  const timeoutAt = store.readCandidate('cand-timeout-1').timeout_at;
  assert.equal(timeoutAt, '2026-01-16T00:00:00.000Z'); // +14 default days

  const shadowResult = await runShadow(store, emitter, {
    candidateId: 'cand-timeout-1',
    scenarios: ['anthropic_tpu_output_corruption_step_2025_09'],
    seeds: [42],
    outputDir: path.join(store.dir, 'shadow-out'),
    dryRun: true,
    now: '2026-01-02T01:00:00.000Z',
  });
  assert.equal(shadowResult.exitCode, 0, shadowResult.lines.join('\n'));
  assert.equal(store.readCandidate('cand-timeout-1').review_status, 'reviewable');

  const beforeActiveBytes = fs.readFileSync(path.join(store.dir, 'active.json'), 'utf8');

  // No operator action — `list` at created+15d (past the +14d default
  // timeout) sweeps the candidate to timeout_rejected first.
  const listResult = await runList(store, emitter, '2026-01-17T00:00:00.000Z');
  assert.equal(listResult.exitCode, 0);

  const timedOut = store.readCandidate('cand-timeout-1');
  assert.equal(timedOut.status, 'rejected');
  assert.equal(timedOut.outcome, 'timeout_rejected');

  const events = store.readEvents();
  const timeoutEvent = events.find((e) => e.type === 'recalibration.timeout_rejected');
  assert.ok(timeoutEvent, 'expected a recalibration.timeout_rejected event in events.jsonl');
  const payload = timeoutEvent!.payload as { escalation?: { escalated: boolean; escalated_to: string } };
  assert.deepEqual(payload.escalation, { escalated: true, escalated_to: 'engineering_leadership' });

  const afterActiveBytes = fs.readFileSync(path.join(store.dir, 'active.json'), 'utf8');
  assert.equal(afterActiveBytes, beforeActiveBytes, 'active.json must be byte-identical after a timeout default-rejection');

  const activeCfgPath = store.readActive()!.compiled_config_path;
  const activeCfg = JSON.parse(fs.readFileSync(activeCfgPath, 'utf8')) as CompiledConfig;
  const afterRun = runPortfolioDemo(demo, activeCfg);
  assert.equal(afterRun.finalVerdict, 'rollback', 'old config must still roll back after a timeout default-rejection');
  assert.ok(afterRun.anyFamilyFired);
});

// ── #3 Pinning e2e ─────────────────────────────────────────────────────

function makeProvenance(baselineVersion: string): DetectorTripV2['provenance'] {
  return {
    cell_key: { hour_of_day: 14 },
    cell_confidence: 'strict',
    variance_inflated: false,
    covariate_freshness: 0,
    baseline_version: baselineVersion,
    schema_continuity: 'continuous',
  };
}

function makeTrip(baselineVersion: string): DetectorTripV2 {
  return {
    family_id: 'A',
    detector_id: 'mSPRT_p99_latency',
    statistic: 12,
    threshold: 9.6,
    alpha_spent: 6.67e-5,
    reason_code: 'cusum_exceeded_threshold',
    gate: 'health_rollback',
    label: 'Family A p99_latency',
    provenance: makeProvenance(baselineVersion),
  };
}

function cleanFamily(): FamilyVerdictV2 {
  return { verdict: 'clean', detectors: [], alpha_spent: 0, suppression_reason: null };
}

function makeDeployRecord(compiledConfigVersion: string, tripBaselineVersion?: string): AuditRecordV2 {
  const families: Record<string, FamilyVerdictV2> = {
    A: tripBaselineVersion
      ? { verdict: 'fire', detectors: [makeTrip(tripBaselineVersion)], alpha_spent: 6.67e-5, suppression_reason: null }
      : cleanFamily(),
    B: cleanFamily(), C: cleanFamily(), D: cleanFamily(), E: cleanFamily(),
  };
  return {
    schema_version: '2', ts: '2026-01-02T00:00:00.000Z', service: 'svc-invariant-3', tick: 0, total_ticks: 32,
    hours_elapsed: 0, verdict: 'proceed', reason: 'test', short_circuit: null, tripped: [],
    inputs: {} as never, baseline: {}, scenario_ctx: {}, trend_snapshot: null, policy_ctx_digest: 'digest',
    mode: 'act', gate_results: {} as never, fusion_topology: 'portfolio',
    compiled_config_version: compiledConfigVersion, families: families as AuditRecordV2['families'],
    reversibility: null, reversibility_source: null, total_alpha_spent: tripBaselineVersion ? 6.67e-5 : 0,
  };
}

test('invariant #3: deploy pinning — a mid-deploy auto-promotion never flips an in-flight deploy\'s pinned version', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-invariant-3');
  const v4 = loadV4();
  const oldVersion = v4.version;

  seedActive(store, {
    schema_version: '1', version_id: oldVersion, candidate_id: null,
    compiled_config_path: V4_PATH, baseline_ref: v4.baseline_ref,
    promoted_at: '2026-01-01T00:00:00.000Z', predecessor_version_id: null, promotion_history: [],
  });

  // Deploy 1 pinned to the OLD version — every record carries oldVersion
  // on both surfaces (top-level + per-trip provenance), simulating a
  // deploy that started before, and is still running during, the
  // recalibration below.
  const deploy1Records: AuditRecordV2[] = [
    makeDeployRecord(oldVersion, oldVersion),
    makeDeployRecord(oldVersion),
    makeDeployRecord(oldVersion, oldVersion),
  ];
  assert.deepEqual(validateDeployPinning(deploy1Records, oldVersion), []);

  // Mid-"deploy1" (conceptually), an improvement candidate auto-promotes.
  const candidateConfig = improvedCandidateConfig(v4, 'v4-improved-candidate@seed=77');
  const candidatePath = path.join(root, 'candidate-improved.json');
  fs.writeFileSync(candidatePath, JSON.stringify(candidateConfig));
  const newVersion = candidateConfig.version;

  const emitter = new InMemoryLifecycleEventEmitter();
  const proposeResult = await runPropose(store, emitter, {
    candidateId: 'cand-pin-1',
    candidateConfigPath: candidatePath,
    creationReason: 'drift_detected',
    sourceWindow: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z', n_samples: 80 },
    now: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(proposeResult.exitCode, 0, proposeResult.lines.join('\n'));
  assert.equal(store.readCandidate('cand-pin-1').direction_classification, 'improvement');

  const shadowResult = await runShadow(store, emitter, {
    candidateId: 'cand-pin-1',
    scenarios: ['anthropic_tpu_output_corruption_step_2025_09'],
    seeds: [42],
    outputDir: path.join(store.dir, 'shadow-out'),
    dryRun: true,
    now: '2026-01-02T01:00:00.000Z',
  });
  assert.equal(shadowResult.exitCode, 0, shadowResult.lines.join('\n'));
  assert.equal(store.readCandidate('cand-pin-1').outcome, 'auto_promoted');
  assert.equal(store.readActive()!.version_id, newVersion);

  // Deploy 1's OWN records are untouched by the promotion (they're a
  // fixed, already-recorded fact — the store's active pointer moving on
  // doesn't rewrite history) — still validates clean against oldVersion.
  assert.deepEqual(validateDeployPinning(deploy1Records, oldVersion), []);

  // Deploy 2 starts AFTER the promotion, pinned to the NEW version.
  const deploy2Records: AuditRecordV2[] = [
    makeDeployRecord(newVersion, newVersion),
    makeDeployRecord(newVersion),
  ];
  assert.deepEqual(validateDeployPinning(deploy2Records, newVersion), []);

  // Negative control: a hand-built mid-deploy version flip DOES surface
  // as violations — proves validateDeployPinning isn't vacuously passing.
  const flippedRecords: AuditRecordV2[] = [
    makeDeployRecord(oldVersion, oldVersion),
    makeDeployRecord(newVersion, newVersion), // mid-deploy flip
  ];
  const violations = validateDeployPinning(flippedRecords, oldVersion);
  assert.ok(violations.length > 0, 'expected a mid-deploy version flip to be flagged');
  assert.ok(violations.some((v) => v.kind === 'compiled_config_version'));
  assert.ok(violations.some((v) => v.kind === 'trip_provenance_baseline_version'));
});

// ── #4 Improvement auto-promote e2e ───────────────────────────────────

test('invariant #4: improvement candidate auto-promotes end-to-end with no operator identity + correct predecessor chain', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-invariant-4');
  const v4 = loadV4();

  seedActive(store, {
    schema_version: '1', version_id: v4.version, candidate_id: null,
    compiled_config_path: V4_PATH, baseline_ref: v4.baseline_ref,
    promoted_at: '2026-01-01T00:00:00.000Z', predecessor_version_id: null, promotion_history: [],
  });

  const candidateConfig = improvedCandidateConfig(v4, 'v4-improved-candidate@seed=55');
  const candidatePath = path.join(root, 'candidate-improved.json');
  fs.writeFileSync(candidatePath, JSON.stringify(candidateConfig));

  const emitter = new InMemoryLifecycleEventEmitter();
  const proposeResult = await runPropose(store, emitter, {
    candidateId: 'cand-improve-e2e',
    candidateConfigPath: candidatePath,
    creationReason: 'drift_detected',
    sourceWindow: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z', n_samples: 80 },
    now: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(proposeResult.exitCode, 0, proposeResult.lines.join('\n'));
  assert.equal(store.readCandidate('cand-improve-e2e').direction_classification, 'improvement');

  const shadowResult = await runShadow(store, emitter, {
    candidateId: 'cand-improve-e2e',
    scenarios: ['anthropic_tpu_output_corruption_step_2025_09'],
    seeds: [42],
    outputDir: path.join(store.dir, 'shadow-out'),
    dryRun: true,
    now: '2026-01-02T01:00:00.000Z',
  });
  assert.equal(shadowResult.exitCode, 0, shadowResult.lines.join('\n'));

  const finalRecord = store.readCandidate('cand-improve-e2e');
  assert.equal(finalRecord.status, 'active');
  assert.equal(finalRecord.review_status, 'decided');
  assert.equal(finalRecord.outcome, 'auto_promoted');
  // History never records an operator actor — every entry is 'system'.
  assert.ok(finalRecord.history.every((h) => h.actor === 'system'));

  const active = store.readActive()!;
  assert.equal(active.version_id, candidateConfig.version);
  assert.equal(active.predecessor_version_id, v4.version);
  assert.equal(active.promotion_history.length, 1);
  assert.equal(active.promotion_history[0].outcome, 'auto_promoted');
  assert.equal(active.promotion_history[0].actor, undefined, 'no operator identity anywhere in the promotion trail');

  const types = emitter.getEvents().map((e) => e.type);
  assert.deepEqual(types, ['recalibration.proposed', 'recalibration.shadow_validated', 'recalibration.auto_promoted']);
});

// ── #5 Calendar safety net e2e ────────────────────────────────────────

test('invariant #5: calendar safety net e2e — check reports due, then calendar_safety_net-triggered candidate follows the same path to auto-promotion', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-invariant-5');
  const v4 = loadV4();

  seedActive(store, {
    schema_version: '1', version_id: v4.version, candidate_id: null,
    compiled_config_path: V4_PATH, baseline_ref: v4.baseline_ref,
    promoted_at: '2026-01-01T00:00:00.000Z', predecessor_version_id: null, promotion_history: [],
  });

  const emitter = new InMemoryLifecycleEventEmitter();
  const checkResult = await runCheck(store, emitter, '2026-02-05T00:00:00.000Z');
  assert.equal(checkResult.exitCode, 3, checkResult.lines.join('\n'));
  assert.ok(checkResult.lines.some((l) => l.includes('DUE')));

  // Fix 2: durable audit trace for the calendar-due decision.
  const calendarDueEvent = store.readEvents().find((e) => e.type === 'recalibration.calendar_due');
  assert.ok(calendarDueEvent, 'expected a recalibration.calendar_due event in events.jsonl');

  const candidateConfig = improvedCandidateConfig(v4, 'v4-improved-candidate@seed=44');
  const candidatePath = path.join(root, 'candidate-improved.json');
  fs.writeFileSync(candidatePath, JSON.stringify(candidateConfig));

  const proposeResult = await runPropose(store, emitter, {
    candidateId: 'cand-calendar-e2e',
    candidateConfigPath: candidatePath,
    creationReason: 'calendar_safety_net',
    sourceWindow: { start: '2026-02-01T00:00:00.000Z', end: '2026-02-05T00:00:00.000Z', n_samples: 80 },
    now: '2026-02-05T00:00:00.000Z',
  });
  assert.equal(proposeResult.exitCode, 0, proposeResult.lines.join('\n'));
  const proposed = store.readCandidate('cand-calendar-e2e');
  assert.equal(proposed.creation_reason, 'calendar_safety_net');
  assert.equal(proposed.direction_classification, 'improvement');

  const shadowResult = await runShadow(store, emitter, {
    candidateId: 'cand-calendar-e2e',
    scenarios: ['anthropic_tpu_output_corruption_step_2025_09'],
    seeds: [42],
    outputDir: path.join(store.dir, 'shadow-out'),
    dryRun: true,
    now: '2026-02-05T01:00:00.000Z',
  });
  assert.equal(shadowResult.exitCode, 0, shadowResult.lines.join('\n'));

  const finalRecord = store.readCandidate('cand-calendar-e2e');
  assert.equal(finalRecord.outcome, 'auto_promoted');
  assert.equal(store.readActive()!.version_id, candidateConfig.version);

  // A subsequent check is no longer due — the promotion moved last
  // activity forward.
  const secondCheck = await runCheck(store, emitter, '2026-02-06T00:00:00.000Z');
  assert.equal(secondCheck.exitCode, 0);
});
