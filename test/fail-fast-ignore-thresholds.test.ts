// test/fail-fast-ignore-thresholds.test.ts — Addition #13 acceptance.
//
// Verifies the G1 three-tier policy contract:
//   1. `fail_fast_thresholds` → absolute panic bounds; crossing them
//      short-circuits L2 with verdict 'rollback', shortCircuit
//      'policy_fail_fast'. Sticky once tripped.
//   2. `ignore_thresholds` → per-signal skip bands; in-band signals are
//      suppressed by comparative-analysis detector families (A, C, E)
//      with suppression_reason='ignore_threshold'. Family B structural
//      signatures are NOT affected.
//   3. Backward compat: services with no thresholds set observe zero
//      behavior change.
//
// Flat test-file layout per REPLY-28/#10 precedent. 7 unit + 3 integration
// assertions in the same file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  classifyFailFast, classifyIgnoredSignals,
} from '../dist/engine/gates/policy';
import type {
  CompiledConfig, OrchestrateParams, Metrics, AuditRecord, AuditRecordV2,
  FailFastState,
} from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v2-with-family-a.json');
// Full-families config (A + B + C + D + E) for integration tests that need
// multivariate families wired. v4-fusion-novelty.json is the W4 fixture.
const CONFIG_PATH_V4 = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

// Inline a minimal baseline + scenario that every test can share. Numbers
// echo the "clean" scenario baseline; the per-test metrics trajectory sets
// the fail-fast or ignore behavior that matters.
const BASELINE: Metrics = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

function makeScenario(): OrchestrateParams['scenario'] {
  return {
    id: 'sci-ff-ignore',
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

function clone(m: Metrics): Metrics { return { ...m }; }

// ────────────────────────────────────────────────────────────────────
// Unit tests — pure helpers.
// ────────────────────────────────────────────────────────────────────

test('unit 1: fail-fast trip — observed > threshold → short-circuit with full reason', () => {
  const live = clone(BASELINE); live.p99_latency = 1200;
  const r = classifyFailFast({ p99_latency: 1000 }, live, undefined);
  assert.equal(r.shortCircuit, true, 'must short-circuit');
  assert.equal(r.newState.tripped, true);
  assert.equal(r.newState.trippedSignalId, 'p99_latency');
  assert.equal(r.newState.trippedThreshold, 1000);
  assert.equal(r.newState.trippedObserved, 1200);
  assert.match(
    r.reason ?? '',
    /Fail-fast threshold exceeded — p99_latency: observed 1200 > threshold 1000/,
    'reason must mention signal, observed, and threshold',
  );
});

test('unit 2: fail-fast no-trip — observed below threshold → no short-circuit', () => {
  const live = clone(BASELINE); live.p99_latency = 500;
  const r = classifyFailFast({ p99_latency: 1000 }, live, undefined);
  assert.equal(r.shortCircuit, false);
  assert.equal(r.newState.tripped, false);
  assert.equal(r.reason, null);
});

test('unit 3: ignore threshold — min-only band, in-band signal is reported as ignored', () => {
  const live = clone(BASELINE); live.eval_score = 0.97;
  const ignored = classifyIgnoredSignals({ eval_score: { min: 0.95 } }, live);
  assert.ok(ignored.has('eval_score'), 'eval_score 0.97 ≥ 0.95 → in-band');
  assert.equal(ignored.size, 1);
});

test('unit 4: ignore threshold — min-only band, out-of-band signal is not ignored', () => {
  const live = clone(BASELINE); live.eval_score = 0.92;
  const ignored = classifyIgnoredSignals({ eval_score: { min: 0.95 } }, live);
  assert.equal(ignored.has('eval_score'), false, 'eval_score 0.92 < 0.95 → out-of-band');
  assert.equal(ignored.size, 0);
});

test('unit 5: two-sided ignore band — in / below / above behave correctly', () => {
  const cfg = { downstream_err: { min: 0, max: 0.01 } };
  {
    const live = clone(BASELINE); live.downstream_err = 0.005;
    assert.ok(classifyIgnoredSignals(cfg, live).has('downstream_err'), '0.005 in-band');
  }
  {
    const live = clone(BASELINE); live.downstream_err = -0.01;
    assert.equal(classifyIgnoredSignals(cfg, live).has('downstream_err'), false, '-0.01 below min');
  }
  {
    const live = clone(BASELINE); live.downstream_err = 0.02;
    assert.equal(classifyIgnoredSignals(cfg, live).has('downstream_err'), false, '0.02 above max');
  }
});

test('unit 6: fail-fast + ignore on same signal — fail-fast evaluated first', () => {
  // Operator redundantly configures both surfaces on p99_latency.
  const failFast = { p99_latency: 1000 };
  const ignore = { p99_latency: { max: 300 } };
  // Observed 1200 — above fail-fast threshold; ignore config irrelevant.
  {
    const live = clone(BASELINE); live.p99_latency = 1200;
    const ff = classifyFailFast(failFast, live, undefined);
    assert.equal(ff.shortCircuit, true, 'fail-fast wins at 1200');
  }
  // Observed 250 — below fail-fast threshold; inside ignore band → p99 ignored.
  {
    const live = clone(BASELINE); live.p99_latency = 250;
    const ff = classifyFailFast(failFast, live, undefined);
    assert.equal(ff.shortCircuit, false);
    const ignored = classifyIgnoredSignals(ignore, live);
    assert.ok(ignored.has('p99_latency'), 'ignore wins at 250');
  }
});

test('unit 7: backward compat — absent thresholds observe zero behavior change', () => {
  const live = clone(BASELINE);
  const ff = classifyFailFast(undefined, live, undefined);
  assert.equal(ff.shortCircuit, false);
  assert.equal(ff.newState.tripped, false);
  const ignored = classifyIgnoredSignals(undefined, live);
  assert.equal(ignored.size, 0);
  // Also confirm: signals with undefined observation are skipped even when
  // a threshold is configured for them (anti-scope rule).
  const ff2 = classifyFailFast({ missing_signal: 10 }, live, undefined);
  assert.equal(ff2.shortCircuit, false, 'missing observation must not trip');
});

// ────────────────────────────────────────────────────────────────────
// Integration assertions — end-to-end via orchestrate().
// ────────────────────────────────────────────────────────────────────

function makeLive(overrides: Partial<Metrics> = {}): Metrics {
  return { ...BASELINE, ...overrides };
}

test('integration 1: end-to-end fail-fast is sticky across ticks', () => {
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  const thresholds = { downstream_err: 0.05 };
  const audits: (AuditRecord | AuditRecordV2)[] = [];
  let failFastState: FailFastState | undefined;

  // Trajectory: 4 clean ticks, crossing at tick 4, then 3 more ticks. The
  // sticky-tripped behavior keeps emitting short-circuit after tick 4.
  const trajectory = [0.02, 0.02, 0.02, 0.02, 0.06, 0.02, 0.02, 0.02];
  for (let i = 0; i < trajectory.length; i++) {
    const live = makeLive({ downstream_err: trajectory[i] });
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live, scenario: sc,
      hoursElapsed: i * 0.25,
      trendBuffer: tb, tick: i, totalTicks: trajectory.length,
      failFastThresholds: thresholds,
      failFastState,
    };
    const result = orchestrate(params);
    audits.push(buildAuditRecord(params, result, { service: 'ff-test' }));
    failFastState = result.failFastState;
  }

  // Ticks 0–3 (downstream_err 0.02 < 0.05): no short-circuit.
  for (let i = 0; i < 4; i++) {
    assert.notEqual(audits[i].short_circuit, 'policy_fail_fast', `tick ${i}: must not short-circuit`);
  }
  // Tick 4 trips (0.06 > 0.05).
  assert.equal(audits[4].short_circuit, 'policy_fail_fast', 'tick 4 must trip fail-fast');
  assert.equal(audits[4].verdict, 'rollback', 'tick 4 verdict must be rollback');
  assert.equal(audits[4].tripped.length, 0, 'fail-fast short-circuit — no family detectors');
  assert.match(audits[4].reason, /Fail-fast threshold exceeded — downstream_err/);
  // Ticks 5–7 observations drop back below threshold — sticky keeps emitting
  // short-circuit (no flapping back to L2).
  for (let i = 5; i < trajectory.length; i++) {
    assert.equal(audits[i].short_circuit, 'policy_fail_fast', `tick ${i}: must stay short-circuited`);
    assert.equal(audits[i].verdict, 'rollback', `tick ${i}: must remain rollback`);
    assert.match(audits[i].reason, /sticky/, `tick ${i}: reason must note sticky state`);
  }
});

test('integration 2: end-to-end ignore — Family A per-signal suppression with trigger field; multivariate families evaluate normally', () => {
  if (!fs.existsSync(CONFIG_PATH)) {
    // Config not built — skip instead of failing. The family-a-parity
    // test's `before()` hook produces this config; we don't regenerate.
    console.warn('skip: ' + CONFIG_PATH + ' not present');
    return;
  }
  const cfg: CompiledConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  const ignore = { eval_score: { min: 0.95 } };

  // Hold eval_score at 0.97 (in-band) across 8 ticks; other signals pinned
  // at baseline. Assert:
  //   - eval_score's Family A verdict is 'suppressed' with reason
  //     'ignore_threshold' AND the audit-enrichment field
  //     `ignore_threshold_trigger_signal === 'eval_score'` per
  //     ARCHITECT-REPLY-31.
  //   - Other Family A signals evaluate normally (not suppressed under
  //     ignore_threshold).
  //   - Family C/E, if enabled in this config, evaluate normally —
  //     they never emit suppression_reason='ignore_threshold' (Option (d)
  //     multivariate semantic).
  let sawIgnore = false;
  let sawTrigger = false;
  let sawOtherEvaluated = false;
  let familyCSuppressedByIgnore = false;
  let familyESuppressedByIgnore = false;
  for (let i = 0; i < 8; i++) {
    const live = makeLive({ eval_score: 0.97 });
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live, scenario: sc,
      hoursElapsed: i * 0.25,
      trendBuffer: tb, tick: i, totalTicks: 8,
      compiledConfig: cfg,
      currentHourOfDay: 20,
      currentDayOfWeek: 3,
      ignoreThresholds: ignore,
    };
    const result = orchestrate(params);
    const shadow = result.healthResult?.family_A_shadow ?? [];
    for (const v of shadow) {
      if (v.signal === 'eval_score') {
        if (v.verdict === 'suppressed' && v.reason_code === 'ignore_threshold') {
          sawIgnore = true;
          if (v.ignore_threshold_trigger_signal === 'eval_score') sawTrigger = true;
        }
      } else if (v.verdict !== 'suppressed' || v.reason_code !== 'ignore_threshold') {
        sawOtherEvaluated = true;
      }
    }
    const cv = result.healthResult?.family_C_verdict;
    if (cv?.verdict === 'suppressed' && cv.reason_code === 'ignore_threshold') {
      familyCSuppressedByIgnore = true;
    }
    const ev = result.healthResult?.family_E_verdict;
    if (ev?.verdict === 'suppressed' && ev.reason_code === 'ignore_threshold') {
      familyESuppressedByIgnore = true;
    }
  }
  assert.ok(sawIgnore, 'eval_score must suppress with ignore_threshold at least once');
  assert.ok(sawTrigger, 'ignore_threshold_trigger_signal must name eval_score on suppression records');
  assert.ok(sawOtherEvaluated, 'other Family A signals must not be suppressed with ignore_threshold');
  assert.equal(familyCSuppressedByIgnore, false, 'Family C must not suppress under ignore_thresholds (Option d)');
  assert.equal(familyESuppressedByIgnore, false, 'Family E must not suppress under ignore_thresholds (Option d)');
});

test('integration 4: operator-intent preservation — eval_score in-band + p99 drift lets multivariate catch other-signal drift', () => {
  // ARCHITECT-REPLY-31 operator-intent-preservation scenario:
  //   ignore_thresholds.eval_score = {min: 0.95}
  //   eval_score held at 0.97 (in-band) for the full run
  //   p99_latency drifts upward to push the Family C joint T² up
  // Assert:
  //   * Family A mSPRT_eval_score is suppressed with reason
  //     'ignore_threshold' (per-signal, correct operator intent).
  //   * Family C is NOT suppressed under ignore_thresholds — it evaluates
  //     and reports a verdict driven by the p99 drift's contribution to
  //     the joint vector, even though eval_score contributes near-zero.
  // Uses the W4 config because Family C needs to be compiled; the W2
  // Family-A-only config (CONFIG_PATH) doesn't wire it.
  if (!fs.existsSync(CONFIG_PATH_V4)) {
    console.warn('skip: ' + CONFIG_PATH_V4 + ' not present');
    return;
  }
  const cfg: CompiledConfig = JSON.parse(fs.readFileSync(CONFIG_PATH_V4, 'utf8'));
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  const ignore = { eval_score: { min: 0.95 } };

  let evalScoreSuppressed = false;
  let familyCEverEvaluated = false;
  for (let i = 0; i < 12; i++) {
    // p99_latency drifts: baseline 185 ms; ramp +30 ms/tick to ~550 ms by t=12.
    const p99 = (BASELINE.p99_latency as number) + 30 * i;
    const live = makeLive({ eval_score: 0.97, p99_latency: p99 });
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live, scenario: sc,
      hoursElapsed: i * 0.25,
      trendBuffer: tb, tick: i, totalTicks: 12,
      compiledConfig: cfg,
      currentHourOfDay: 20,
      currentDayOfWeek: 3,
      ignoreThresholds: ignore,
    };
    const result = orchestrate(params);
    const shadow = result.healthResult?.family_A_shadow ?? [];
    for (const v of shadow) {
      if (v.signal === 'eval_score' && v.verdict === 'suppressed'
          && v.reason_code === 'ignore_threshold') {
        evalScoreSuppressed = true;
      }
    }
    const cv = result.healthResult?.family_C_verdict;
    if (cv) {
      // Any verdict other than suppression-by-ignore-threshold counts:
      // 'fire', 'clean', 'indeterminate', or a *different* suppression
      // reason (bake profile, continuity, etc.). The key architectural
      // invariant is that ignore_thresholds never silences Family C.
      assert.notEqual(
        cv.reason_code, 'ignore_threshold',
        `tick ${i}: Family C must not suppress with ignore_threshold`,
      );
      familyCEverEvaluated = true;
    }
  }
  assert.ok(evalScoreSuppressed, 'eval_score must be suppressed under ignore_threshold');
  assert.ok(familyCEverEvaluated, 'Family C must evaluate at least once — not silenced by eval_score ignore band');
});

test('integration 3: replay-regression invariant — absent thresholds preserve prior verdicts', () => {
  // Same trajectory as integration 1 but with NO thresholds configured.
  // The orchestrator path must behave exactly as before Addition #13: no
  // short-circuit, no suppression. Covers the hard backward-compat gate.
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  const trajectory = [0.02, 0.02, 0.02, 0.02, 0.06, 0.02, 0.02, 0.02];
  for (let i = 0; i < trajectory.length; i++) {
    const live = makeLive({ downstream_err: trajectory[i] });
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live, scenario: sc,
      hoursElapsed: i * 0.25,
      trendBuffer: tb, tick: i, totalTicks: trajectory.length,
    };
    const result = orchestrate(params);
    assert.notEqual(
      result.shortCircuit, 'policy_fail_fast',
      `tick ${i}: no thresholds set → must not fail-fast`,
    );
    // healthResult must be present — health gate must have run.
    assert.ok(result.healthResult !== null, `tick ${i}: health gate must evaluate`);
  }
});
