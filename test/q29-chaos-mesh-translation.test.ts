// test/q29-chaos-mesh-translation.test.ts — Q29 SLICE 2 (proof-of-life).
//
// Covers translateChaosMeshSpec + parseGoDurationSeconds. The Chaos Mesh
// adapter splits network-call (K8s API client; stays stub) from
// translation (this); the latter is the load-bearing logic an integrator
// composes with a real K8s client.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  translateChaosMeshSpec,
  parseGoDurationSeconds,
} from '../dist/engine/o0/anvil/chaos-mesh-translate';
import type { ChaosMeshCRD } from '../dist/engine/o0/anvil/chaos-mesh-translate';

const T0 = 1_700_000_000;

test('Q29 SLICE 2 — parseGoDurationSeconds: "60s" → 60', () => {
  assert.equal(parseGoDurationSeconds('60s'), 60);
});

test('Q29 SLICE 2 — parseGoDurationSeconds: "5m" → 300', () => {
  assert.equal(parseGoDurationSeconds('5m'), 300);
});

test('Q29 SLICE 2 — parseGoDurationSeconds: "1h30m" → 5400', () => {
  assert.equal(parseGoDurationSeconds('1h30m'), 5400);
});

test('Q29 SLICE 2 — parseGoDurationSeconds: "500ms" → 0.5', () => {
  assert.equal(parseGoDurationSeconds('500ms'), 0.5);
});

test('Q29 SLICE 2 — parseGoDurationSeconds: unparseable input throws', () => {
  assert.throws(() => parseGoDurationSeconds('not-a-duration'),
    /unparseable Chaos Mesh duration/);
});

test('Q29 SLICE 2 — translateChaosMeshSpec: NetworkChaos delay → network_delay + suppress A', () => {
  const crd: ChaosMeshCRD = {
    apiVersion: 'chaos-mesh.org/v1alpha1',
    kind: 'NetworkChaos',
    metadata: { name: 'latency-injection-test', namespace: 'default' },
    spec: {
      action: 'delay',
      duration: '60s',
      delay: { latency: '200ms' },
    },
  };
  const pattern = translateChaosMeshSpec(crd, T0);
  assert.equal(pattern.kind, 'network_delay');
  assert.deepEqual(pattern.affected_signals, ['p99_latency', 'downstream_err']);
  assert.deepEqual(pattern.suppress_families, ['A']);
  assert.equal(pattern.recovery_seconds, 60);
  assert.equal(pattern.fault_start_unix, T0);
  assert.equal(pattern.magnitude_unit, 'sigma');
});

test('Q29 SLICE 2 — translateChaosMeshSpec: PodChaos pod-kill → pod_pod-kill + suppress A', () => {
  const crd: ChaosMeshCRD = {
    apiVersion: 'chaos-mesh.org/v1alpha1',
    kind: 'PodChaos',
    metadata: { name: 'pod-kill-test' },
    spec: { action: 'pod-kill', duration: '30s' },
  };
  const pattern = translateChaosMeshSpec(crd, T0);
  assert.equal(pattern.kind, 'pod_pod-kill');
  assert.equal(pattern.recovery_seconds, 30);
  assert.deepEqual(pattern.suppress_families, ['A']);
});

test('Q29 SLICE 2 — translateChaosMeshSpec: StressChaos → cpu_or_memory_stress', () => {
  const crd: ChaosMeshCRD = {
    apiVersion: 'chaos-mesh.org/v1alpha1',
    kind: 'StressChaos',
    metadata: { name: 'cpu-stress-test' },
    spec: {
      duration: '2m',
      stressors: { cpu: { workers: 4, load: 80 } },
    },
  };
  const pattern = translateChaosMeshSpec(crd, T0);
  assert.equal(pattern.kind, 'cpu_or_memory_stress');
  assert.deepEqual(pattern.affected_signals, ['p99_latency', 'cost_req']);
  assert.equal(pattern.recovery_seconds, 120);
});

test('Q29 SLICE 2 — translateChaosMeshSpec: IOChaos delay → io_delay', () => {
  const crd: ChaosMeshCRD = {
    apiVersion: 'chaos-mesh.org/v1alpha1',
    kind: 'IOChaos',
    metadata: { name: 'io-delay-test' },
    spec: { action: 'delay', duration: '45s' },
  };
  const pattern = translateChaosMeshSpec(crd, T0);
  assert.equal(pattern.kind, 'io_delay');
  assert.equal(pattern.recovery_seconds, 45);
});

test('Q29 SLICE 2 — translateChaosMeshSpec: TimeChaos → time_skew with empty suppress (let everything fire)', () => {
  const crd: ChaosMeshCRD = {
    apiVersion: 'chaos-mesh.org/v1alpha1',
    kind: 'TimeChaos',
    metadata: { name: 'time-skew-test' },
    spec: { duration: '90s' },
  };
  const pattern = translateChaosMeshSpec(crd, T0);
  assert.equal(pattern.kind, 'time_skew');
  assert.deepEqual(pattern.affected_signals, []);
  assert.deepEqual(pattern.suppress_families, []);
});

test('Q29 SLICE 2 — translateChaosMeshSpec: unknown CRD kind falls through to chaos_<lowercase>', () => {
  const crd: ChaosMeshCRD = {
    apiVersion: 'chaos-mesh.org/v1alpha1',
    kind: 'HTTPChaos',
    metadata: { name: 'http-chaos-test' },
    spec: { action: 'abort', duration: '20s' },
  };
  const pattern = translateChaosMeshSpec(crd, T0);
  assert.equal(pattern.kind, 'chaos_httpchaos');
  assert.deepEqual(pattern.suppress_families, []);
});

test('Q29 SLICE 2 — translateChaosMeshSpec: missing spec.duration throws (bounded-window invariant)', () => {
  const crd: ChaosMeshCRD = {
    apiVersion: 'chaos-mesh.org/v1alpha1',
    kind: 'NetworkChaos',
    metadata: { name: 'bad-no-duration' },
    spec: { action: 'delay' },
  };
  assert.throws(() => translateChaosMeshSpec(crd, T0),
    /missing spec.duration/);
});
