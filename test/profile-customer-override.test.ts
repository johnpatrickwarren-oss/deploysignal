// test/profile-customer-override.test.ts — Addition #28 slice-2.
//
// Per REPLY-51 §Tests for D8 customer-override layer:
//   - override loads, base profile loads, effective_config computes.
//   - override CANNOT introduce fields not in base schema (enforced).
//   - override CAN null out base fields to disable them.
//   - profile_ref + customer_override_ref both populate on emitted
//     CompiledConfig when both present (see
//     profile-audit-reproducibility.test.ts for the audit threading
//     coverage).
//
// Overrides materialized as temp-dir YAMLs to exercise the full
// YAML → parse → validate → merge pipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import {
  loadProfile, loadCustomerOverride, resolveEffectiveConfig,
} from '../tools/profile-loader';

function writeOverride(dir: string, filename: string, body: object): string {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, yaml.dump(body));
  return p;
}

test('override: loads + resolves effective_config with override-level α', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-override-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const overridePath = writeOverride(tmp, 'acme.yaml', {
    base_profile: 'llm-inference-streaming@1.0.0',
    customer_id: 'acme',
    overrides: {
      alpha_allocation: {
        per_family: { A: 3.0e-4, B: 3.0e-4, C: 2.0e-4, D: 1.0e-4, E: 1.0e-4 },
        total: 1.0e-3,
      },
    },
  });

  const profile = loadProfile('llm-inference-streaming@1.0.0');
  const override = loadCustomerOverride(overridePath);
  const effective = resolveEffectiveConfig(profile, override);

  assert.equal(effective.profile_ref, 'llm-inference-streaming@1.0.0');
  assert.equal(effective.customer_override_ref, 'acme@1.0.0');
  // Override's α values win.
  assert.equal(effective.alpha_allocation.per_family.A, 3.0e-4);
  assert.equal(effective.alpha_allocation.per_family.B, 3.0e-4);
  // Fields not overridden inherit from the profile.
  assert.deepEqual(effective.joint_vector, profile.joint_vector);
  assert.deepEqual(effective.policy_defaults, profile.policy_defaults);
});

test('override: base_profile without override yields effective with null ref', () => {
  const profile = loadProfile('llm-inference-streaming@1.0.0');
  const effective = resolveEffectiveConfig(profile, null);
  assert.equal(effective.profile_ref, 'llm-inference-streaming@1.0.0');
  assert.equal(effective.customer_override_ref, null);
});

test('override: array fields (sli_list) replace parent (D4 propagated to D8)', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-override-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const overridePath = writeOverride(tmp, 'custom-sli.yaml', {
    base_profile: 'llm-inference-streaming@1.0.0',
    customer_id: 'sli-customer',
    overrides: {
      sli_list: [
        { signal: 'p99_latency', direction_of_better: 'lower', 'δ_min': 0.005 },
      ],
    },
  });

  const profile = loadProfile('llm-inference-streaming@1.0.0');
  const override = loadCustomerOverride(overridePath);
  const effective = resolveEffectiveConfig(profile, override);

  // D4 array-replace: override's 1-entry list replaces the profile's 6.
  assert.equal(effective.sli_list.length, 1);
  assert.equal(effective.sli_list[0].signal, 'p99_latency');
  assert.equal(effective.sli_list[0].δ_min, 0.005);
});

test('override: unknown top-level field → load-time error (D8 no-new-fields)', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-override-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const overridePath = writeOverride(tmp, 'bad-field.yaml', {
    base_profile: 'llm-inference-streaming@1.0.0',
    customer_id: 'bad-customer',
    overrides: {
      unknown_top_field: 'should-reject',
    },
  });

  const profile = loadProfile('llm-inference-streaming@1.0.0');
  const override = loadCustomerOverride(overridePath);
  assert.throws(
    () => resolveEffectiveConfig(profile, override),
    /introduces field.*unknown_top_field.*not present in base profile schema/,
  );
});

test('override: unknown nested field inside alpha_allocation → rejected', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-override-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const overridePath = writeOverride(tmp, 'bad-nested.yaml', {
    base_profile: 'llm-inference-streaming@1.0.0',
    customer_id: 'bad-nested-customer',
    overrides: {
      alpha_allocation: {
        mystery_subfield: 42,
      },
    },
  });

  const profile = loadProfile('llm-inference-streaming@1.0.0');
  const override = loadCustomerOverride(overridePath);
  assert.throws(
    () => resolveEffectiveConfig(profile, override),
    /introduces field.*mystery_subfield/,
  );
});

test('override: type violation (e.g., α value of wrong type) fails post-merge revalidation', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-override-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const overridePath = writeOverride(tmp, 'bad-type.yaml', {
    base_profile: 'llm-inference-streaming@1.0.0',
    customer_id: 'bad-type-customer',
    overrides: {
      policy_defaults: {
        default_risk_tier: 'extreme', // not in enum
      },
    },
  });

  const profile = loadProfile('llm-inference-streaming@1.0.0');
  const override = loadCustomerOverride(overridePath);
  assert.throws(
    () => resolveEffectiveConfig(profile, override),
    /failed schema validation/,
  );
});

test('override: customer_override_ref format = `<customer_id>@<version>`', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-override-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const overridePath = writeOverride(tmp, 'ref-format.yaml', {
    base_profile: 'llm-inference-streaming@1.0.0',
    customer_id: 'example-corp',
    overrides: {},
  });

  const profile = loadProfile('llm-inference-streaming@1.0.0');
  const override = loadCustomerOverride(overridePath);
  const effective = resolveEffectiveConfig(profile, override);
  // v1: no explicit version field on override → defaults to 1.0.0 per Q2.
  assert.equal(effective.customer_override_ref, 'example-corp@1.0.0');
});

test('override: base_profile format enforced by schema (id@semver required)', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-override-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const overridePath = writeOverride(tmp, 'bad-ref.yaml', {
    base_profile: 'no-version-suffix',
    customer_id: 'acme',
    overrides: {},
  });

  assert.throws(
    () => loadCustomerOverride(overridePath),
    /failed schema validation/,
  );
});
