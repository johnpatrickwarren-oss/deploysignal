// test/twin-source-prometheus.test.ts — Plan C task 3: the Prometheus twin source against a
// fake fetch. The real-container test is test/twin-source-prometheus-integration.test.ts
// (opt-in, DS_PROM_INTEGRATION=1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PrometheusTwinSource, histogramExceedance } from '../service/sources/prometheus';
import type { FetchLike, PrometheusTwinSourceConfig } from '../service/sources/prometheus';

type Answer = string | null | 'multi' | 'error';

/** Fake /api/v1/query: `answers` maps an exact PromQL string to one sample value (or null = empty vector). */
function fakeFetch(answers: Record<string, Answer>): { fetch: FetchLike; calls: URL[] } {
  const calls: URL[] = [];
  const fetch: FetchLike = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const q = u.searchParams.get('query') ?? '';
    if (!(q in answers)) throw new Error(`unexpected query: ${q}`);
    const a = answers[q];
    if (a === 'error') {
      return { ok: false, status: 400, json: async () => ({ status: 'error', errorType: 'bad_data', error: 'parse error' }) };
    }
    const result = a === null ? [] : a === 'multi'
      ? [{ metric: { pod: 'a' }, value: [0, '1'] }, { metric: { pod: 'b' }, value: [0, '2'] }]
      : [{ metric: {}, value: [Number(u.searchParams.get('time')), a] }];
    return { ok: true, status: 200, json: async () => ({ status: 'success', data: { resultType: 'vector', result } }) };
  };
  return { fetch, calls };
}

const ARMS = { canary: 'track="canary"', control: 'track="baseline"' };
const REQ = 'sum(increase(http_requests_total{$arm}[$window]))';
const ERR = 'sum(increase(http_requests_total{$arm,code=~"5.."}[$window]))';
const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);

function cfg(fetch: FetchLike, metrics: PrometheusTwinSourceConfig['metrics']): PrometheusTwinSourceConfig {
  return { baseUrl: 'http://prom.test:9090', fetch, arms: ARMS, requests: REQ, metrics };
}

const reqAnswers: Record<string, Answer> = {
  'sum(increase(http_requests_total{track="canary"}[60s]))': '1000.4',
  'sum(increase(http_requests_total{track="baseline"}[60s]))': '998',
};

test('counter -> rate: $arm and $window are substituted, time = window end in seconds, counts rounded', async () => {
  const { fetch, calls } = fakeFetch({
    ...reqAnswers,
    'sum(increase(http_requests_total{track="canary",code=~"5.."}[60s]))': '6.6',
    'sum(increase(http_requests_total{track="baseline",code=~"5.."}[60s]))': '3.2',
  });
  const src = new PrometheusTwinSource(cfg(fetch, [{ id: 'http_5xx', kind: 'rate', events: ERR, total: REQ }]));
  const body = await src.fetchTick(T0, T0 + 60_000);
  assert.deepEqual(body, {
    canary_requests: 1000,
    control_requests: 998,
    observations: { http_5xx: { canary_events: 7, canary_total: 1000, control_events: 3, control_total: 998 } },
  });
  assert.ok(calls.every((u) => u.pathname === '/api/v1/query'));
  assert.ok(calls.every((u) => u.searchParams.get('time') === String((T0 + 60_000) / 1000)));
});

test('histogram exceedance -> rate: events = count - bucket{le=L}, total = count', async () => {
  const spec = histogramExceedance('slow_requests', 'http_request_duration_seconds', '0.5');
  assert.equal(spec.kind, 'rate');
  assert.equal(spec.total, 'sum(increase(http_request_duration_seconds_count{$arm}[$window]))');
  assert.equal(
    spec.events,
    'sum(increase(http_request_duration_seconds_count{$arm}[$window])) - ' +
    'sum(increase(http_request_duration_seconds_bucket{$arm,le="0.5"}[$window]))',
  );
  const { fetch } = fakeFetch({
    ...reqAnswers,
    'sum(increase(http_request_duration_seconds_count{track="canary"}[60s]))': '1000',
    'sum(increase(http_request_duration_seconds_count{track="baseline"}[60s]))': '998',
    'sum(increase(http_request_duration_seconds_count{track="canary"}[60s])) - sum(increase(http_request_duration_seconds_bucket{track="canary",le="0.5"}[60s]))': '41.2',
    'sum(increase(http_request_duration_seconds_count{track="baseline"}[60s])) - sum(increase(http_request_duration_seconds_bucket{track="baseline",le="0.5"}[60s]))': '-0.3',
  });
  const body = await new PrometheusTwinSource(cfg(fetch, [spec])).fetchTick(T0, T0 + 60_000);
  assert.deepEqual(body.observations.slow_requests, {
    canary_events: 41, canary_total: 1000, control_events: 0, control_total: 998,
  });
});

test('gauge -> sign: one value per arm, unrounded', async () => {
  const expr = 'avg_over_time(queue_depth{$arm}[$window])';
  const { fetch } = fakeFetch({
    ...reqAnswers,
    'avg_over_time(queue_depth{track="canary"}[60s])': '3.25',
    'avg_over_time(queue_depth{track="baseline"}[60s])': '2.5',
  });
  const body = await new PrometheusTwinSource(cfg(fetch, [{ id: 'queue', kind: 'sign', expr }])).fetchTick(T0, T0 + 60_000);
  assert.deepEqual(body.observations.queue, { canary: 3.25, control: 2.5 });
});

test('an empty vector is zero for a count and missing (omitted) for a sign', async () => {
  const { fetch } = fakeFetch({
    ...reqAnswers,
    'sum(increase(http_requests_total{track="canary",code=~"5.."}[60s]))': null,
    'sum(increase(http_requests_total{track="baseline",code=~"5.."}[60s]))': null,
    'avg_over_time(queue_depth{track="canary"}[60s])': null,
    'avg_over_time(queue_depth{track="baseline"}[60s])': '2.5',
  });
  const body = await new PrometheusTwinSource(cfg(fetch, [
    { id: 'http_5xx', kind: 'rate', events: ERR, total: REQ },
    { id: 'queue', kind: 'sign', expr: 'avg_over_time(queue_depth{$arm}[$window])' },
  ])).fetchTick(T0, T0 + 60_000);
  assert.deepEqual(body.observations.http_5xx, { canary_events: 0, canary_total: 1000, control_events: 0, control_total: 998 });
  assert.equal('queue' in body.observations, false);
});

test('a NaN sign value is missing; events above total are clamped to total', async () => {
  const { fetch } = fakeFetch({
    ...reqAnswers,
    'sum(increase(http_requests_total{track="canary",code=~"5.."}[60s]))': '1003',
    'sum(increase(http_requests_total{track="baseline",code=~"5.."}[60s]))': '0',
    'avg_over_time(queue_depth{track="canary"}[60s])': 'NaN',
    'avg_over_time(queue_depth{track="baseline"}[60s])': '2.5',
  });
  const body = await new PrometheusTwinSource(cfg(fetch, [
    { id: 'http_5xx', kind: 'rate', events: ERR, total: REQ },
    { id: 'queue', kind: 'sign', expr: 'avg_over_time(queue_depth{$arm}[$window])' },
  ])).fetchTick(T0, T0 + 60_000);
  assert.equal((body.observations.http_5xx as { canary_events: number }).canary_events, 1000);
  assert.equal('queue' in body.observations, false);
});

test('a query returning more than one series is refused (templates must aggregate)', async () => {
  const { fetch } = fakeFetch({ ...reqAnswers, 'up{track="canary"}': 'multi', 'up{track="baseline"}': '1' });
  const src = new PrometheusTwinSource(cfg(fetch, [{ id: 'u', kind: 'sign', expr: 'up{$arm}' }]));
  await assert.rejects(() => src.fetchTick(T0, T0 + 60_000), /2 series/);
});

test('a Prometheus error response is an error, not a zero', async () => {
  const { fetch } = fakeFetch({ 'sum(increase(http_requests_total{track="canary"}[60s]))': 'error', 'sum(increase(http_requests_total{track="baseline"}[60s]))': '1' });
  const src = new PrometheusTwinSource(cfg(fetch, []));
  await assert.rejects(() => src.fetchTick(T0, T0 + 60_000), /400.*parse error/);
});

test('refuses windows that are not whole seconds, and empty arm selectors', async () => {
  const { fetch } = fakeFetch(reqAnswers);
  const src = new PrometheusTwinSource(cfg(fetch, []));
  await assert.rejects(() => src.fetchTick(T0, T0 + 1_500), /whole number of seconds/);
  await assert.rejects(() => src.fetchTick(T0, T0), /whole number of seconds/);
  assert.throws(() => new PrometheusTwinSource({ ...cfg(fetch, []), arms: { canary: '', control: 'x="y"' } }), /arm selector/);
});

test('optional headers are passed on every request (e.g. a bearer token)', async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const { fetch: inner } = fakeFetch(reqAnswers);
  const fetch: FetchLike = async (url, init) => { seen.push(init?.headers); return inner(url, init); };
  await new PrometheusTwinSource({ ...cfg(fetch, []), headers: { Authorization: 'Bearer t' } }).fetchTick(T0, T0 + 60_000);
  assert.deepEqual(seen, [{ Authorization: 'Bearer t' }, { Authorization: 'Bearer t' }]);
});

test('histogram exceedance: an empty events result with traffic is missing, not zero (a wrong le matches no bucket)', async () => {
  const spec = histogramExceedance('slow_requests', 'http_request_duration_seconds', '0.55');
  assert.equal(spec.emptyEvents, 'missing');
  const { fetch } = fakeFetch({
    ...reqAnswers,
    'sum(increase(http_request_duration_seconds_count{track="canary"}[60s]))': '1000',
    'sum(increase(http_request_duration_seconds_count{track="baseline"}[60s]))': '998',
    'sum(increase(http_request_duration_seconds_count{track="canary"}[60s])) - sum(increase(http_request_duration_seconds_bucket{track="canary",le="0.55"}[60s]))': null,
    'sum(increase(http_request_duration_seconds_count{track="baseline"}[60s])) - sum(increase(http_request_duration_seconds_bucket{track="baseline",le="0.55"}[60s]))': null,
  });
  const body = await new PrometheusTwinSource(cfg(fetch, [spec])).fetchTick(T0, T0 + 60_000);
  assert.equal('slow_requests' in body.observations, false);
});
