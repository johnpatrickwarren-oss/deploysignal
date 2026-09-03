// test/c25-family-e-advisory.test.ts — WORKLIST C25 / C65.
//
// Family E is advisory (knowledge/stats/family-e-budget-ruling, option 3,
// operator 2026-09-02): its α budget is 0 on the llm profiles, it is
// non-α-participating, and a Family E `fire` is recorded for
// evidence_outlook / audit but never triggers rollback and books no α.
//
// Two layers pinned here:
//   1. Budget: profiles carry E at 0; the compiled split excludes E.
//   2. Guard: `FAMILY_E_ADVISORY` at both sites — portfolio fusion
//      (engine/verdict.ts) and the health gate (engine/gates/
//      _health-detectors.ts) — keyed on the constant, not on α.
// Plus the engine-pin fact: since engine v0.6.9-pre (C65, engine
// detectors/conformal.ts) a zero budget evaluates at the nominal level
// and a fire carries alpha_spent 0 / reason_code advisory_zero_budget.
// At v0.6.7-pre and v0.6.8-pre it was SILENCE (suppressed /
// calibration_underpowered); that test was retired at the v0.6.9-pre
// re-pin and replaced by the end-to-end advisory test below.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateFamilyE } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/conformal';
import { FAMILY_C_SIGNALS } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/hotelling';
import type { CompiledConfig, FamilyCPerCell, DetectorVerdict, HealthResult, FiredSignal, Metrics } from '../dist/engine/types';
import { DETECTOR_GUARANTEES, FAMILY_E_ADVISORY } from '../dist/engine/guarantees';
import { fuseVerdict } from '../dist/engine/verdict';
import { runFamilyE } from '../dist/engine/gates/_health-detectors';
import { loadProfile, resolveEffectiveConfig } from '../tools/profile-loader';
import { allocateAlpha } from '../tools/calibrate/_calibrate-config-build';
import type { Args } from '../tools/calibrate/_calibrate-types';
import { FAMILY_E_ALPHA_FRACTION } from '../tools/calibrate/_calibrate-constants';

const LLM_PROFILES = ['llm-inference-streaming@1.0.0', 'llm-inference-batch@1.0.0'];

// ── 1. Budget ────────────────────────────────────────────────────────

test('C25: FAMILY_E_ADVISORY is on and mahalanobis_conformal_baseline is non-α-participating', () => {
  assert.equal(FAMILY_E_ADVISORY, true);
  assert.equal(DETECTOR_GUARANTEES['mahalanobis_conformal_baseline'].alpha_participating, false);
  assert.equal(FAMILY_E_ALPHA_FRACTION, 0, 'legacy no-profile path zeroed in lockstep (byte-identity anchor)');
});

for (const ref of LLM_PROFILES) {
  test(`C25: ${ref} holds Family E at 0 α with E still enabled; sum invariant holds`, () => {
    const profile = loadProfile(ref);
    const pf = profile.alpha_allocation.per_family;
    assert.equal(pf.E, 0, 'Family E budget is 0 (advisory)');
    assert.equal(profile.joint_vector.include_in_family_e, true, 'E still evaluates — advisory, not disabled');
    assert.equal(pf.A + pf.B + pf.C + pf.D + pf.E, profile.alpha_allocation.total);
  });

  test(`C25: ${ref} compiled α split has E = 0 and the participating sum excludes E`, () => {
    const profile = loadProfile(ref);
    const effective = resolveEffectiveConfig(profile, null);
    const args = { alpha: effective.alpha_allocation.total } as unknown as Args;
    const a = allocateAlpha(args, effective, true, true, true, true);
    assert.equal(a.alphaE, 0);
    // α-participating families per engine/guarantees.ts: A, C, D (B and E are not).
    const participating = a.alphaA + a.alphaC + a.alphaD;
    assert.ok(Math.abs(participating - 7e-4) < 1e-15, `participating budget A+C+D = ${participating}`);
    assert.ok(Math.abs(a.alphaA + a.alphaB + a.alphaC + a.alphaD + a.alphaE - args.alpha) < 1e-15);
  });
}

// ── Shared synthetic Family E config (mirrors test/conformal.test.ts) ─

function famECfg(alphaE: number, nCal: number): { cfg: CompiledConfig; liveHigh: Record<string, number> } {
  const p = FAMILY_C_SIGNALS.length;
  const cov: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? 0.01 : 0)));
  const mean = Array.from({ length: p }, (_, i) => (i === 0 ? 100 : 1));
  const famC: FamilyCPerCell = { mean_vector: mean, covariance: cov, covariance_shrinkage: 0 };
  const calibration = Array.from({ length: nCal }, (_, i) => 0.5 + (i / nCal) * 3);
  const cfg: CompiledConfig = {
    version: 'test', compiler_version: '0', compiled_at: '', baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 0, B: 0, C: 2e-4, D: 0, E: alphaE } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [{
        key: { hour_of_day: 14, day_of_week: 3 },
        n_samples: calibration.length, confidence: 'strict',
        family_C: famC,
        family_E: { calibration_scores: calibration },
      }],
      aggregate_fallback: { family_C: famC, family_E: { calibration_scores: calibration } },
    },
  };
  const liveHigh: Record<string, number> = {};
  for (let i = 0; i < p; i++) liveHigh[FAMILY_C_SIGNALS[i]] = mean[i] * 1.5;  // 50% off → huge score
  return { cfg, liveHigh };
}

const CTX = { hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0, trafficPct: 1.0 };

// ── Engine-pin fact: advisory is live (v0.6.9-pre, C65) ─────────────

test('C25/C65 engine pin v0.6.9-pre: Family E at α = 0 on a novel vector FIRES as advisory — '
  + 'alpha_spent 0, reason_code advisory_zero_budget; health gate records it with rollbackFired empty; '
  + 'fusion gives no rollback from E alone', () => {
  // α_E = 0 → the engine evaluates at its nominal DEFAULT_ALPHA_E (1e-4),
  // so the 1/α sample guard needs ≥ 10 000 calibration scores.
  const { cfg, liveHigh } = famECfg(0, 20000);
  const v = evaluateFamilyE(cfg, liveHigh, CTX);
  assert.ok(v, 'Family E is compiled for the cell');
  assert.equal(v!.verdict, 'fire');
  assert.equal(v!.alpha_spent, 0);
  assert.equal(v!.alpha_consumed, 0);
  assert.equal(v!.reason_code, 'advisory_zero_budget');
  assert.notEqual(v!.statistic, null, 'a score was computed: the guard no longer reads 1/0');

  const result = emptyHealth();
  const rollbackFired: FiredSignal[] = [];
  runFamilyE(result, rollbackFired, [], { ...liveHigh, traffic_pct: 1.0 } as unknown as Metrics, null, {
    compiledConfig: cfg, currentHourOfDay: 14, currentDayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0,
  });
  assert.equal(result.family_E_verdict?.verdict, 'fire', 'recorded for evidence_outlook / audit');
  assert.equal(result.family_E_verdict?.reason_code, 'advisory_zero_budget');
  assert.equal(result.family_E_verdict?.alpha_spent, 0);
  assert.deepEqual(rollbackFired.map((s) => s.id), [], 'family_E never enters the health gate rollback[]');

  const fused = fuseVerdict(result, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 't', familyE: result.family_E_verdict });
  assert.equal(fused.verdict, 'baking', 'no rollback from Family E alone');
  assert.deepEqual(fused.firing_families, []);
  assert.equal(fused.total_alpha_spent, 0);
  assert.equal(fused.evidence_outlook.find((x) => x.family_id === 'E')?.state, 'fired');
});

// ── 2. Guard, site 1: portfolio fusion ───────────────────────────────

function emptyHealth(): HealthResult {
  return {
    rollback: [], extend: [],
    warmup: { active: false, grace: false, pct: 100, suppressedIds: [] },
    suppressed: [],
  };
}

function fireE(alpha = 1e-4): DetectorVerdict {
  return {
    verdict: 'fire', statistic: 4000, threshold: alpha,
    alpha_consumed: alpha, alpha_spent: alpha,
    reason_code: 'conformal_p_below_threshold', family: 'E',
  };
}

function fireA(): DetectorVerdict {
  return {
    verdict: 'fire', statistic: 12, threshold: 8,
    alpha_consumed: 6.67e-5, alpha_spent: 6.67e-5,
    reason_code: 'cusum_threshold', family: 'A', signal: 'p99_latency',
  };
}

test('C25 fusion: a Family E fire alone is not a rollback, spends no α, and is reported as fired (advisory)', () => {
  const v = fuseVerdict(emptyHealth(), { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 't', familyE: fireE() });
  assert.equal(v.verdict, 'baking');
  assert.deepEqual(v.firing_families, []);
  assert.equal(v.total_alpha_spent, 0);
  assert.equal(v.per_family_verdicts.E?.verdict, 'fire', 'verdict kept for audit');
  const e = v.evidence_outlook.find((x) => x.family_id === 'E')!;
  assert.equal(e.state, 'fired');
  assert.match(v.verdict_rationale, /Advisory only/);
  assert.match(v.verdict_rationale, /Family E fired/);
});

test('C25 fusion: the guard is keyed on the constant, not on α — an E fire stamped with α = 1e-4 still spends 0', () => {
  const v = fuseVerdict(emptyHealth(), { topology: 'portfolio', tick: 31, totalTicks: 32, deployRef: 't', familyE: fireE(1e-4) });
  assert.equal(v.verdict, 'proceed', 'window closed, no α-bounded family fired');
  assert.equal(v.total_alpha_spent, 0);
});

test('C25 fusion: with Family A firing, rollback is attributed to A only and α_spent excludes E', () => {
  const h = emptyHealth();
  h.family_A_shadow = [fireA()];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 't', familyE: fireE() });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['A']);
  assert.ok(Math.abs(v.total_alpha_spent - 6.67e-5) < 1e-18);
  assert.match(v.verdict_rationale, /^Rollback triggered: Family A fired/);
  assert.match(v.verdict_rationale, /Advisory only .*Family E fired/);
});

// ── 2. Guard, site 2: health gate ────────────────────────────────────

test('C25 health gate: runFamilyE records a Family E fire on family_E_verdict with alpha_spent 0 '
  + 'and does not push family_E into rollback[]', () => {
  // α_E = 1e-2 with 200 calibration scores clears the 1/α guard (needs
  // ≥ 100), so the detector actually fires on the 50%-off vector.
  const { cfg, liveHigh } = famECfg(1e-2, 200);
  const probe = evaluateFamilyE(cfg, liveHigh, CTX);
  assert.equal(probe!.verdict, 'fire', 'precondition: the raw detector fires');
  assert.ok(probe!.alpha_spent > 0, 'precondition: the raw detector books α');

  const result = emptyHealth();
  const rollbackFired: FiredSignal[] = [];
  runFamilyE(result, rollbackFired, [], { ...liveHigh, traffic_pct: 1.0 } as unknown as Metrics, null, {
    compiledConfig: cfg, currentHourOfDay: 14, currentDayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0,
  });
  assert.equal(result.family_E_verdict?.verdict, 'fire', 'verdict recorded for evidence_outlook / audit');
  assert.equal(result.family_E_verdict?.reason_code, 'conformal_p_below_threshold');
  assert.equal(result.family_E_verdict?.alpha_spent, 0);
  assert.equal(result.family_E_verdict?.alpha_consumed, 0);
  assert.deepEqual(rollbackFired.map((s) => s.id), [], 'family_E never enters the health gate rollback[]');
});
