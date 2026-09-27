// test/twin-sources-contract.test.ts — Plan C task 1: the wire types for the twin gate's tick
// body (the shared /v1/sessions/{id}/ticks contract) and the MetricSource interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertTwinTickBody, isRateObservationBody } from '../service/sources/twin-contract';
import type { TwinTickBody } from '../service/sources/twin-contract';
import type { MetricSource } from '../service/sources/metric-source';

const VALID: TwinTickBody = {
  canary_requests: 100,
  control_requests: 98,
  observations: {
    http_5xx: { canary_events: 2, canary_total: 100, control_events: 1, control_total: 98 },
    p99_latency: { canary: 0.31, control: 0.29 },
  },
};

test('assertTwinTickBody accepts a body with integer counts and finite sign values', () => {
  assert.doesNotThrow(() => assertTwinTickBody(VALID));
});

test('assertTwinTickBody refuses non-integer request counts (the engine throws on them)', () => {
  assert.throws(() => assertTwinTickBody({ ...VALID, canary_requests: 100.5 }), /canary_requests/);
  assert.throws(() => assertTwinTickBody({ ...VALID, control_requests: -1 }), /control_requests/);
});

test('assertTwinTickBody refuses a non-integer rate count and names the metric', () => {
  const body: TwinTickBody = {
    ...VALID,
    observations: { http_5xx: { canary_events: 1.2, canary_total: 100, control_events: 1, control_total: 98 } },
  };
  assert.throws(() => assertTwinTickBody(body), /http_5xx\.canary_events/);
});

test('assertTwinTickBody refuses events above total', () => {
  const body: TwinTickBody = {
    ...VALID,
    observations: { e: { canary_events: 5, canary_total: 4, control_events: 0, control_total: 3 } },
  };
  assert.throws(() => assertTwinTickBody(body), /e\.canary_events/);
});

test('assertTwinTickBody refuses a non-finite sign value', () => {
  const body: TwinTickBody = { ...VALID, observations: { p: { canary: Number.NaN, control: 1 } } };
  assert.throws(() => assertTwinTickBody(body), /p\.canary/);
});

test('isRateObservationBody discriminates the two observation shapes', () => {
  assert.equal(isRateObservationBody(VALID.observations.http_5xx), true);
  assert.equal(isRateObservationBody(VALID.observations.p99_latency), false);
});

test('a MetricSource is anything with fetchTick(windowStartMs, windowEndMs)', async () => {
  const src: MetricSource = { fetchTick: async (_s: number, _e: number) => VALID };
  assert.deepEqual(await src.fetchTick(0, 60_000), VALID);
});
