// test/schema-continuity.integration.test.ts — W5 §T2 acceptance.
//
// Verifies the Addition #8 runtime consumer end-to-end: when the
// orchestrator threads `schemaContinuityClass: 'breaking'` (or
// 'observability_stack') through the health gate to detectors, Families
// A/C/D/E suppress with the correct `suppression_reason`; Family B
// continues to evaluate (per Addition #8 — structural signatures don't
// depend on continuous metric semantics); and the v2 audit record
// carries the continuity class in `Provenance.schema_continuity`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  CompiledConfig, OrchestrateParams, AuditRecordV2, FamilyId, SchemaContinuityRecord, Metrics,
} from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');

const ROOT = path.resolve(__dirname, '..');
const V4_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

const TEST_HOUR_OF_DAY = 20;
const TEST_DAY_OF_WEEK = 3;

function loadV4(): CompiledConfig {
  if (!fs.existsSync(V4_PATH)) {
    throw new Error(`v4 compiled config missing at ${V4_PATH} — run w4-full-sweep first to seed.`);
  }
  return JSON.parse(fs.readFileSync(V4_PATH, 'utf8')) as CompiledConfig;
}

// Drift that reliably trips Family A on p99/ttft and Family B (slowbleed
// + downstream corroboration). Picks a baseline from the synthetic pool.
function makeDriftingScenario(): OrchestrateParams['scenario'] {
  return {
    id: 'sci-test-breaking',
    riskLevel: 'critical',
    bakeHours: 6,
    author: 'human',
    changeType: 'model_weights',
    timeWindow: 'ok',
    flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
    baseline: {
      p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
      cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
      collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
    },
  };
}

// Forward-drift live metrics: scale signals to grow into rollback territory
// over the run. Independent of the adversarial-scenarios drift functions
// (which use Math.random) so this test stays deterministic.
function driftedLive(baseline: Metrics, tick: number): Metrics {
  const k = 1 + tick * 0.04;  // 4%/tick growth on rising signals
  return {
    p99_latency:    baseline.p99_latency * k,
    ttft:           baseline.ttft * k,
    tokens_turn:    baseline.tokens_turn * (1 + tick * 0.025),
    kv_cache:       baseline.kv_cache * (1 - tick * 0.005),
    cost_req:       baseline.cost_req * k,
    downstream_err: baseline.downstream_err * k,
    mfu:            baseline.mfu * (1 - tick * 0.005),
    hbm_spill:      baseline.hbm_spill * k,
    collective_ops: baseline.collective_ops * (1 - tick * 0.0001),
    corpus_delta:   baseline.corpus_delta * k,
    traffic_pct:    1.0,
  };
}

// Mild oscillation around baseline — never trips a rollback so the loop
// runs to completion and Family D's long-window detector gets enough
// samples to actually evaluate (>= 20 long-window samples needed).
function cleanLive(baseline: Metrics, tick: number): Metrics {
  const j = 1 + 0.001 * Math.sin(tick / 3);
  return {
    p99_latency:    baseline.p99_latency * j,
    ttft:           baseline.ttft * j,
    tokens_turn:    baseline.tokens_turn * j,
    kv_cache:       baseline.kv_cache * j,
    cost_req:       baseline.cost_req * j,
    downstream_err: baseline.downstream_err * j,
    mfu:            baseline.mfu * j,
    hbm_spill:      baseline.hbm_spill * j,
    collective_ops: baseline.collective_ops * j,
    corpus_delta:   baseline.corpus_delta * j,
    traffic_pct:    1.0,
  };
}

interface RunOpts {
  klass?: SchemaContinuityRecord['schema_continuity'];
  drift?: boolean;
  breakOnRollback?: boolean;
  totalTicks?: number;
}

function runScenario(
  cfg: CompiledConfig,
  opts: RunOpts,
): { lastAudit: AuditRecordV2 | null; sawRollback: boolean; ticks: number } {
  const sc = makeDriftingScenario();
  const tb = new TrendBuffer(10);
  const totalTicks = opts.totalTicks ?? 24;
  let lastRecord: AuditRecordV2 | null = null;
  let sawRollback = false;
  let lastI = 0;
  for (let i = 0; i < totalTicks; i++) {
    const live = opts.drift ? driftedLive(sc.baseline, i) : cleanLive(sc.baseline, i);
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live, scenario: sc,
      hoursElapsed: i * (sc.bakeHours! / totalTicks),
      trendBuffer: tb, tick: i, totalTicks,
      compiledConfig: cfg,
      currentHourOfDay: TEST_HOUR_OF_DAY,
      currentDayOfWeek: TEST_DAY_OF_WEEK,
      fusionTopology: 'portfolio',
      schemaContinuityClass: opts.klass,
    };
    const result = orchestrate(params);
    lastRecord = buildAuditRecord(params, result, { service: 'sci-test' }) as AuditRecordV2;
    lastI = i;
    if (result.verdict === 'rollback') {
      sawRollback = true;
      if (opts.breakOnRollback !== false) break;
    }
  }
  return { lastAudit: lastRecord, sawRollback, ticks: lastI + 1 };
}

// ─────────────────────────────────────────────────────────────────────
test('schema-continuity: breaking → A/C/D/E suppress, B still evaluates', () => {
  const cfg = loadV4();
  // Clean drift so the loop runs to completion; Family D needs ≥ 20 long-
  // window samples before it can evaluate — under a drift that fires Family
  // B early, the loop would short-circuit before D ever sees enough data.
  const out = runScenario(cfg, { klass: 'breaking', drift: false, breakOnRollback: false });
  assert.ok(out.lastAudit, 'expected an audit record');
  const fams = out.lastAudit!.families;

  for (const fam of ['A', 'C', 'D', 'E'] as FamilyId[]) {
    assert.equal(fams[fam].verdict, 'suppressed',
      `family ${fam} expected 'suppressed' under 'breaking'; got ${fams[fam].verdict}`);
    assert.equal(fams[fam].suppression_reason, 'schema_continuity_breaking',
      `family ${fam} suppression_reason mismatch (got ${fams[fam].suppression_reason})`);
  }

  // Family B is not suppressed by schema-continuity per Addition #8.
  assert.notEqual(fams.B.suppression_reason, 'schema_continuity_breaking',
    'Family B must not be suppressed by schema-continuity per Addition #8');
});

test('schema-continuity: observability_stack → A/C/D/E suppress with the right reason', () => {
  const cfg = loadV4();
  const out = runScenario(cfg, { klass: 'observability_stack', drift: false, breakOnRollback: false });
  assert.ok(out.lastAudit);
  const fams = out.lastAudit!.families;
  for (const fam of ['A', 'C', 'D', 'E'] as FamilyId[]) {
    assert.equal(fams[fam].verdict, 'suppressed',
      `family ${fam} expected 'suppressed' under 'observability_stack'; got ${fams[fam].verdict}`);
    assert.equal(fams[fam].suppression_reason, 'observability_stack_deploy',
      `family ${fam} suppression_reason mismatch (got ${fams[fam].suppression_reason})`);
  }
});

test('schema-continuity: continuous → families evaluate normally (no schema suppression)', () => {
  const cfg = loadV4();
  const out = runScenario(cfg, { klass: 'continuous', drift: true });
  assert.ok(out.lastAudit);
  const fams = out.lastAudit!.families;
  for (const fam of ['A', 'B', 'C', 'D', 'E'] as FamilyId[]) {
    assert.notEqual(fams[fam].suppression_reason, 'schema_continuity_breaking',
      `family ${fam} must not carry schema-continuity suppression under 'continuous'`);
    assert.notEqual(fams[fam].suppression_reason, 'observability_stack_deploy',
      `family ${fam} must not carry observability-stack suppression under 'continuous'`);
  }
  // Drifting input should drive at least one family to fire over 24 ticks.
  assert.ok(out.sawRollback, 'continuous run must reach a rollback under drifting inputs');
});

test('schema-continuity: provenance.schema_continuity threads through to every emitted trip', () => {
  const cfg = loadV4();
  // Drift + continuous so detectors actually fire and emit detector trips
  // with full provenance — assert each carries the threaded class.
  const out = runScenario(cfg, { klass: 'continuous', drift: true });
  assert.ok(out.lastAudit);
  const fams = out.lastAudit!.families;
  let trips = 0;
  for (const fam of ['A', 'B', 'C', 'D', 'E'] as FamilyId[]) {
    for (const det of fams[fam].detectors) {
      trips++;
      assert.equal(det.provenance.schema_continuity, 'continuous',
        `family ${fam} detector ${det.detector_id} provenance.schema_continuity should be 'continuous'`);
    }
  }
  assert.ok(trips > 0, 'expected at least one detector trip on continuous drift run');
});

test('schema-continuity: omitted class behaves like continuous (back-compat)', () => {
  const cfg = loadV4();
  const out = runScenario(cfg, { klass: undefined, drift: true });
  assert.ok(out.lastAudit);
  // Provenance should report null, not a defaulted class.
  for (const fam of ['A', 'B', 'C', 'D', 'E'] as FamilyId[]) {
    for (const det of out.lastAudit!.families[fam].detectors) {
      assert.equal(det.provenance.schema_continuity, null,
        `family ${fam} detector ${det.detector_id} should emit null when no class threaded`);
    }
  }
});
