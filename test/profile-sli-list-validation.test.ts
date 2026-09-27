// test/profile-sli-list-validation.test.ts — engine v0.12.1-pre re-pin.
//
// From v0.12.1-pre the engine's Family A evaluators iterate `family_a_signals` (the profile's
// sli_list), deduplicated, and split α over the distinct count. The profile layer therefore
// refuses what the engine would silently repair or skip:
//
//   - a signal named twice in sli_list (schema `uniqueItems` catches identical entries; the
//     loader catches the same name with different direction_of_better / δ_min, which Draft-07
//     `uniqueItems` does not);
//   - an empty sli_list, except beside `twin_arm` (twin-generic runs only the twin path and has
//     no Family A signal — the same exemption the loader gives its zero detector budget).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadProfile, resolveEffectiveConfig, validateAgainstSchema } from '../tools/profile-loader';
import { profileSchema } from '../tools/_profile-loader-schema';
import type { CustomerOverride } from '../engine/types';

const SCHEMA = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', 'profiles', 'schema', 'profile.schema.json'), 'utf8'));

const P99 = { signal: 'p99_latency', direction_of_better: 'lower', δ_min: 0.05 };
const ERR = { signal: 'downstream_err', direction_of_better: 'lower', δ_min: 0.02 };

function override(sli_list: unknown[]): CustomerOverride {
  return { base_profile: 'generic-microservice@1.0.0', customer_id: 'acme', overrides: { sli_list } as never };
}

test('schema: sli_list declares uniqueItems', () => {
  assert.equal(SCHEMA.properties.sli_list.uniqueItems, true);
});

test('validator: uniqueItems rejects an identical repeated entry and names the path and both indices', () => {
  const r = validateAgainstSchema([P99, ERR, { ...P99 }], { type: 'array', uniqueItems: true });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('$') && e.includes('uniqueItems') && e.includes('0') && e.includes('2')),
    r.errors.join(', '));
});

test('validator: uniqueItems compares by value, not key order', () => {
  const reordered = { δ_min: 0.05, signal: 'p99_latency', direction_of_better: 'lower' };
  assert.equal(validateAgainstSchema([P99, reordered], { type: 'array', uniqueItems: true }).valid, false);
  assert.equal(validateAgainstSchema([P99, ERR], { type: 'array', uniqueItems: true }).valid, true);
  assert.equal(validateAgainstSchema([1, '1'], { type: 'array', uniqueItems: true }).valid, true);
});

test('loader: a profile with an identical duplicate sli_list entry is rejected by the schema', () => {
  const p = loadProfile('generic-microservice@1.0.0');
  assert.throws(() => resolveEffectiveConfig(p, override([P99, ERR, P99])),
    /sli_list: array items at \[0\] and \[2\] are equal \(uniqueItems\)/);
  // The same object through the schema directly.
  const r = validateAgainstSchema({ ...p, sli_list: [P99, P99] }, profileSchema());
  assert.equal(r.valid, false);
});

test('loader: the same signal twice with different fields is rejected by name', () => {
  const p = loadProfile('generic-microservice@1.0.0');
  assert.throws(() => resolveEffectiveConfig(p, override([P99, ERR, { ...P99, δ_min: 0.1 }])),
    /sli_list names signal "p99_latency" more than once \(\[0\] and \[2\]\)/);
});

test('loader: an empty sli_list is rejected on a profile without twin_arm', () => {
  const p = loadProfile('generic-microservice@1.0.0');
  assert.throws(() => resolveEffectiveConfig(p, override([])),
    /sli_list is empty; only a profile declaring twin_arm may monitor no Family A signal/);
});

test('loader: twin-generic keeps its empty sli_list (twin_arm exemption)', () => {
  const p = loadProfile('twin-generic@1.0.0');
  assert.equal(p.sli_list.length, 0);
  assert.doesNotThrow(() => resolveEffectiveConfig(p, null));
});

// ── fix round 1: checkSliList at load time ──
//
// loadProfile reads profiles/<id>.yaml from the repo. The tests below serve a virtual file through
// a per-test fs mock (this process only), so no invalid profile is ever written to profiles/, where
// test/profile-schema-validation.test.ts loads every *.yaml.

import type { TestContext } from 'node:test';
import * as yaml from 'js-yaml';

function serveVirtualProfile(t: TestContext, id: string, sli_list: unknown[]): void {
  const base = yaml.load(fs.readFileSync(
    path.resolve(__dirname, '..', 'profiles', 'generic-microservice.yaml'), 'utf8')) as Record<string, unknown>;
  const text = yaml.dump({ ...base, id, sli_list });
  const suffix = path.join('profiles', `${id}.yaml`);
  // The module object itself (the loader reads it through getters); `import * as fs` is a copy.
  const nodeFs = require('node:fs') as typeof fs;
  const realExists = nodeFs.existsSync;
  const realRead = nodeFs.readFileSync;
  t.mock.method(nodeFs, 'existsSync', (p: fs.PathLike) => String(p).endsWith(suffix) || realExists(p));
  t.mock.method(nodeFs, 'readFileSync', ((p: fs.PathOrFileDescriptor, o?: unknown) =>
    String(p).endsWith(suffix) ? text : (realRead as (a: unknown, b?: unknown) => unknown)(p, o)) as typeof fs.readFileSync);
}

test('loadProfile: a duplicate sli_list signal is rejected at load', (t) => {
  serveVirtualProfile(t, 'virtual-dup-signal', [P99, ERR, { ...P99, δ_min: 0.1 }]);
  assert.throws(() => loadProfile('virtual-dup-signal@1.0.0'),
    /resolved profile "virtual-dup-signal" sli_list names signal "p99_latency" more than once \(\[0\] and \[2\]\)/);
});

test('loadProfile: an identical duplicate sli_list entry is rejected at load (schema uniqueItems)', (t) => {
  serveVirtualProfile(t, 'virtual-dup-entry', [P99, P99]);
  assert.throws(() => loadProfile('virtual-dup-entry@1.0.0'), /uniqueItems/);
});

test('loadProfile: an empty sli_list on a profile without twin_arm is rejected at load', (t) => {
  serveVirtualProfile(t, 'virtual-empty-sli', []);
  assert.throws(() => loadProfile('virtual-empty-sli@1.0.0'),
    /resolved profile "virtual-empty-sli" sli_list is empty; only a profile declaring twin_arm/);
});

test('loadProfile: the virtual profile with a valid sli_list loads (the mock is not what rejects)', (t) => {
  serveVirtualProfile(t, 'virtual-valid-sli', [P99, ERR]);
  assert.equal(loadProfile('virtual-valid-sli@1.0.0').sli_list.length, 2);
});
