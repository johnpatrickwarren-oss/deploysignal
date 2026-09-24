// test/guarantees-vs-engine.test.ts — the two guarantee tables, reconciled mechanically (2026-09-24).
//
// The engine's GUARANTEE_TABLE classifies each detector CONSTRUCTION (its validity envelope, alpha
// policy, (ε,δ) form). This repo's DETECTOR_GUARANTEES classifies the SHIPPED PATH in DeploySignal.
// Where they agree, this test proves it; where they differ, the row must say why in
// `shipped_path_note`, and the set of differing kinds is frozen here so a new divergence is a
// decision, not a drift. knowledge stats/two-guarantee-tables carries the contested rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guaranteeFor, type ValidityClass as EngineClass } from '@johnpatrickwarren-oss/deploysignal-engine/guarantees';
import { DETECTOR_GUARANTEES, type ValidityClass as ShippedClass } from '../engine/guarantees';

/** Shipped-path class → the engine construction class it asserts the same thing as; null when the
 *  shipped class is a statement about DeploySignal's threshold, not about the construction. */
const SAME_CLAIM: Record<ShippedClass, EngineClass | null> = {
  ville_anytime_valid: 'ville_anytime_valid',
  classical_epoch_alpha: 'classical_epoch',
  heuristic_structural: 'heuristic',
  e_value_terminal: 'e_value_terminal',
  bootstrap_crossing_rate: null,
};

const kindOf = (id: string) => id.replace(/_(p99_latency|ttft|eval_score|tool_success_rate|downstream_err|cost_req|kv_cache)$/, '');

test('every shipped id has an engine construction row', () => {
  for (const id of Object.keys(DETECTOR_GUARANTEES)) assert.ok(guaranteeFor(id), `no engine row for ${id}`);
});

test('the shipped class matches the construction class, or the row states why the shipped path differs', () => {
  for (const [id, g] of Object.entries(DETECTOR_GUARANTEES)) {
    const eng = guaranteeFor(id)!;
    const same = SAME_CLAIM[g.validity_class] === eng.validityClass;
    if (!same) assert.ok(g.shipped_path_note && g.shipped_path_note.length > 40, `${id}: shipped ${g.validity_class} vs engine ${eng.validityClass} with no shipped_path_note`);
    else assert.equal(g.shipped_path_note, undefined, `${id}: classes agree, so shipped_path_note is noise`);
  }
});

test('the divergent kinds are exactly the recorded set', () => {
  const divergent = new Set<string>();
  for (const [id, g] of Object.entries(DETECTOR_GUARANTEES)) {
    if (SAME_CLAIM[g.validity_class] !== guaranteeFor(id)!.validityClass) divergent.add(kindOf(id));
  }
  assert.deepEqual([...divergent].sort(), [
    'betting_e_process', 'hotelling_t2_safe', 'mahalanobis_conformal_baseline', 'sequential_mmd', 'spectral_e_detector',
  ]);
});

test('the engine and shipped axis-3 forms agree wherever both are stated', () => {
  for (const [id, g] of Object.entries(DETECTOR_GUARANTEES)) {
    if (!g.approximate_e_value) continue;
    const eng = guaranteeFor(id)!.approximateEValue;
    if (eng.form === 'unrecorded') continue;
    assert.equal(g.approximate_e_value.form, eng.form, `${id}: axis-3 form`);
  }
});
