// test/twin-profile.test.ts — Plan B Task 2: the `twin_arm` profile block and
// profiles/twin-generic.yaml.
//
// The block carries the HTTP contract's twin_arm fields (snake_case) and nothing else. The
// reference profile declares no LLM signal: two rate metrics and one sign metric at canary
// weight 0.5, every detector family off, and its alphas in the twin block (so
// alpha_allocation.total is 0, which the loader allows only beside a twin_arm).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import { loadProfile, validateAgainstSchema, resolveEffectiveConfig } from '../tools/profile-loader';
import { profileSchema } from '../tools/_profile-loader-schema';
import { effectiveOrDefaults } from '../tools/calibrators/effective-config';

const PROFILES = path.resolve(__dirname, '..', 'profiles');
const LLM_SIGNALS = ['ttft', 'tokens_turn', 'kv_cache', 'mfu', 'hbm_spill', 'collective_ops', 'eval_score',
  'tool_success_rate', 'refusal_rate', 'corpus_delta', 'cost_req'];

function rawTwin(): Record<string, unknown> {
  return yaml.load(fs.readFileSync(path.join(PROFILES, 'twin-generic.yaml'), 'utf8')) as Record<string, unknown>;
}

const LEGACY = {
  family_a_signals: ['p99_latency'], family_c_signals: [], family_a_alpha_fraction: 0.4, family_c_alpha_fraction: 0,
  family_d_alpha_fraction: 0, family_e_alpha_fraction: 0, alpha_total: 1e-3,
  family_enabled_from_cli: { A: true, B: true, C: true, D: true, E: true },
  cell_dimensions_from_bundle: { hour_of_day: true, day_of_week: false, workload_class: false, tenant_tier: false, region: false },
} as never;

test('Plan B: twin-generic loads with the contract twin_arm and no LLM signal', () => {
  const p = loadProfile('twin-generic@1.0.0');
  assert.ok(p.twin_arm, 'twin_arm present');
  const t = p.twin_arm!;
  assert.equal(t.canary_weight, 0.5);
  assert.deepEqual(t.metrics.map((m) => [m.id, m.kind, m.worse]), [
    ['http_5xx', 'rate', 'higher'],
    ['success', 'rate', 'lower'],
    ['p99_latency_ms', 'sign', 'higher'],
  ]);
  for (const m of t.metrics) assert.ok(m.tolerance > 0, `${m.id} tolerance`);
  for (const k of ['alpha_rollback', 'alpha_proceed', 'alpha_srm'] as const) assert.ok(t[k] > 0 && t[k] < 1, k);
  assert.ok(Number.isInteger(t.max_ticks) && t.max_ticks > 0);
  assert.equal(p.sli_list.length, 0, 'no Family A signals');
  assert.equal(p.structural_detectors.enabled, false, 'no LLM structural rules');
  assert.equal(p.joint_vector.include_in_family_c, false);
  assert.equal(p.joint_vector.include_in_family_e, false);
  assert.equal(p.alpha_allocation.total, 0);
  const text = JSON.stringify(p);
  for (const s of LLM_SIGNALS) assert.ok(!text.includes(`"${s}"`), `no LLM signal ${s}`);
});

test('Plan B: twin_arm passes through the effective config and the compile defaults', () => {
  const p = loadProfile('twin-generic@1.0.0');
  const eff = resolveEffectiveConfig(p, null);
  assert.deepEqual(eff.twin_arm, p.twin_arm);
  const defaults = effectiveOrDefaults(eff, LEGACY);
  assert.deepEqual(defaults.twin_arm, p.twin_arm);
  // A profile without the block leaves the defaults without it (byte-identical compile).
  const generic = effectiveOrDefaults(resolveEffectiveConfig(loadProfile('generic-microservice@1.0.0'), null), LEGACY);
  assert.equal('twin_arm' in generic, false);
});

test('Plan B: the schema rejects an unknown key, a bad kind and a missing required field inside twin_arm', () => {
  const raw = rawTwin();
  const arm = raw.twin_arm as Record<string, unknown>;
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...arm, unknown_key: 1 }, 'unknown_key'],
    [{ ...arm, metrics: [{ id: 'x', kind: 'ratio', worse: 'higher', tolerance: 0.1 }] }, 'ratio'],
    [{ ...arm, metrics: [{ id: 'x', kind: 'rate', worse: 'up', tolerance: 0.1 }] }, 'up'],
    [(() => { const { max_ticks: _m, ...rest } = arm; return rest; })(), 'max_ticks'],
    [{ ...arm, canary_weight: 1.5 }, 'canary_weight'],
    [{ ...arm, metrics: [] }, 'metrics'],
  ];
  for (const [bad, needle] of cases) {
    const r = validateAgainstSchema({ ...raw, twin_arm: bad }, profileSchema());
    assert.equal(r.valid, false, `expected rejection for ${needle}`);
    assert.ok(r.errors.some((e) => e.includes(needle)), `${needle}: ${r.errors.join('; ')}`);
  }
});

test('Plan B: alpha_allocation.total 0 is refused without a twin_arm', () => {
  const tmp = path.join(PROFILES, 'zz-test-twin-no-arm.yaml');
  const raw = rawTwin();
  delete raw.twin_arm;
  raw.id = 'zz-test-twin-no-arm';
  fs.writeFileSync(tmp, yaml.dump(raw));
  try {
    assert.throws(() => loadProfile('zz-test-twin-no-arm@1.0.0'), /alpha_allocation\.total/);
  } finally {
    fs.unlinkSync(tmp);
  }
});
