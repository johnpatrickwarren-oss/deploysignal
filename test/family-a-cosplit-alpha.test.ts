// test/family-a-cosplit-alpha.test.ts — Addition #17 (ARCHITECT-REPLY-34
// D7) α-split invariants.
//
// Co-ship semantic: Family A's per-signal Bonferroni-corrected budget is
// split 50/50 between Page-CUSUM and the betting e-process. Two gates:
//   1. The compiled config stamps `betting_e_process_alpha` on every
//      per-signal entry (cells + aggregate_fallback) at `(α_A / bonf) · 0.5`.
//   2. A fire from both detectors on the same signal at the same tick
//      attributes `alpha_spent` independently — no double-counting; each
//      detector's DetectorTrip carries its own α accounting surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { freshBettingState, evaluateBettingEProcess } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/betting-e-process';
import { wealthView } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/_wealth';
import { freshCUSUM, evaluateCUSUM } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/page-cusum';
import type { CompiledConfig, MSPRTParams } from '../dist/engine/types';

const V4_PATH = path.resolve(__dirname, '..', 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

test('α-split: compiled configs stamp betting_e_process_alpha when v4 was regenerated post-#17', () => {
  // Tolerant gate: if the v4 config on disk predates the Addition #17
  // recompile, the field is absent — pre-#17 configs MUST load cleanly
  // (backward compat per D8). Post-#17 recompiles MUST carry the field.
  if (!fs.existsSync(V4_PATH)) return;
  const v4: CompiledConfig = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  const alphaA = v4.alpha_budget.per_family.A ?? 4e-4;
  const bonf = v4.bonferroni_factor ?? 6;
  const expected = (alphaA / bonf) * 0.5;

  const agg = v4.baseline_cells?.aggregate_fallback.family_A?.per_signal;
  if (!agg) return;
  const anyKey = Object.keys(agg)[0];
  const entry = agg[anyKey];
  if (entry.betting_e_process_alpha === undefined) {
    // Pre-#17 config on disk — test is a soft gate. Nothing to assert;
    // the detector's runtime fallback (α * 0.5) handles backward compat.
    return;
  }
  assert.ok(Math.abs(entry.betting_e_process_alpha - expected) < expected * 1e-6,
    `aggregate_fallback.family_A.per_signal[${anyKey}].betting_e_process_alpha `
    + `expected ${expected.toExponential(3)}; got ${entry.betting_e_process_alpha.toExponential(3)}`);
  // Every per-signal entry in every cell must carry the same value.
  for (const cell of (v4.baseline_cells?.cells ?? [])) {
    const per = cell.family_A?.per_signal;
    if (!per) continue;
    for (const sig of Object.keys(per)) {
      assert.equal(per[sig].betting_e_process_alpha, expected,
        `cell ${JSON.stringify(cell.key)} signal ${sig}: betting α mismatch`);
    }
  }
});

test('α-split: both detectors fire independently with separate alpha_spent attributions', () => {
  // Construct a synthetic scenario where both Page-CUSUM S_n and
  // betting M_t have already crossed their thresholds. The test asserts:
  //   - Both verdicts are 'fire'
  //   - alpha_spent matches each detector's half of the budget
  //   - No accidental sharing of alpha_spent value between detectors
  const alphaPerSignalTotal = 6.67e-5;  // α_A / bonf
  const alphaPageCusum = alphaPerSignalTotal * 0.5;
  const alphaBetting = alphaPerSignalTotal * 0.5;

  const params: MSPRTParams = {
    signal: 'p99_latency',
    tau_squared: 100, delta_min: 20, min_samples: 0,
    min_ticks_before_eligible: 3, min_observation_window: 3,
    max_deploy_window_days: 1,
    alpha: alphaPageCusum,  // Page-CUSUM side of the split
    derivation: {
      tau_multiplier: 0, empirical_variance: 4, mean: 100, std: 2,
      pooled: false, n_samples: 100,
    },
  };

  const cusumState = freshCUSUM();
  cusumState.S = -Math.log(alphaPageCusum) + 5;  // well above threshold
  cusumState.n = 10;
  const vCusum = evaluateCUSUM(
    { signal: 'p99_latency', params, state: cusumState, trafficPct: 1.0,
      trafficGate: 0, ticksSinceDeploy: 10, deployAgeDays: 0 },
    0,
  );

  const bettingState = freshBettingState();
  // Just above threshold. Engine ADR 0026 makes `log_M` the wealth's source
  // of truth and `M` a derived view — the same log-domain seeding the
  // Page-CUSUM side above already does with `cusumState.S`. Assigning `M`
  // alone would leave log_M = 0 and the first update would reset wealth to 1.
  bettingState.log_M = Math.log((1 / alphaBetting) + 1);
  bettingState.M = wealthView(bettingState.log_M);
  bettingState.n = 10;
  const vBetting = evaluateBettingEProcess(
    { signal: 'p99_latency', params, state: bettingState, trafficPct: 1.0,
      trafficGate: 0, ticksSinceDeploy: 10, deployAgeDays: 0,
      alphaBetting },
    0,
  );

  assert.equal(vCusum.verdict, 'fire');
  assert.equal(vBetting.verdict, 'fire');
  assert.ok(vCusum.alpha_spent === alphaPageCusum,
    `Page-CUSUM alpha_spent ${vCusum.alpha_spent} != ${alphaPageCusum}`);
  assert.ok(vBetting.alpha_spent === alphaBetting,
    `Betting alpha_spent ${vBetting.alpha_spent} != ${alphaBetting}`);
  // Family-level total attribution for this signal: halves sum to per-signal.
  const totalForSignal = vCusum.alpha_spent! + vBetting.alpha_spent!;
  assert.ok(Math.abs(totalForSignal - alphaPerSignalTotal) < 1e-10,
    `signal-level α_spent (${totalForSignal}) must sum to per-signal α (${alphaPerSignalTotal})`);

  // Reason codes MUST differ so audit consumers can discriminate the
  // detectors that fired.
  assert.notEqual(vCusum.reason_code, vBetting.reason_code,
    'Page-CUSUM and betting fires must carry distinct reason_codes');
});
