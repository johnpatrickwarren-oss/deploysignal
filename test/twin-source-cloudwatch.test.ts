// test/twin-source-cloudwatch.test.ts — Plan C task 2: the CloudWatch twin source against a
// fake client. No live AWS call is made anywhere in this repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { GetMetricDataCommandOutput } from '@aws-sdk/client-cloudwatch';

import { CloudWatchTwinSource } from '../service/sources/cloudwatch';
import type { CloudWatchLike } from '../service/sources/cloudwatch';

const LB = 'app/checkout-alb/50dc6c495c0c9188';
const TG = { canary: 'targetgroup/checkout-canary/aaaa', control: 'targetgroup/checkout-baseline/bbbb' };

type Pages = Array<Record<string, number[]>>;

function fakeClient(pages: Pages): { client: CloudWatchLike; sent: GetMetricDataCommand[] } {
  const sent: GetMetricDataCommand[] = [];
  const client: CloudWatchLike = {
    async send(cmd: GetMetricDataCommand): Promise<GetMetricDataCommandOutput> {
      sent.push(cmd);
      const i = sent.length - 1;
      const page = pages[i] ?? {};
      return {
        $metadata: {},
        MetricDataResults: Object.entries(page).map(([Id, Values]) => ({ Id, Values, StatusCode: 'Complete' })),
        NextToken: i + 1 < pages.length ? `tok${i + 1}` : undefined,
      };
    },
  };
  return { client, sent };
}

const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);

test('one GetMetricData per window: Period = window, Sum for counts, p99 for latency, per target group', async () => {
  const { client, sent } = fakeClient([{
    rc_canary: [1000.4], rc_control: [998], e5_canary: [7], e5_control: [3], p99_canary: [0.41], p99_control: [0.38],
  }]);
  const src = new CloudWatchTwinSource({ client, loadBalancer: LB, targetGroups: TG });
  await src.fetchTick(T0, T0 + 120_000);
  assert.equal(sent.length, 1);
  const input = sent[0].input;
  assert.deepEqual(input.StartTime, new Date(T0));
  assert.deepEqual(input.EndTime, new Date(T0 + 120_000));
  const q = Object.fromEntries((input.MetricDataQueries ?? []).map((m) => [m.Id, m.MetricStat]));
  assert.equal(q.rc_canary?.Metric?.MetricName, 'RequestCount');
  assert.equal(q.rc_canary?.Stat, 'Sum');
  assert.equal(q.rc_canary?.Period, 120);
  assert.equal(q.e5_control?.Metric?.MetricName, 'HTTPCode_Target_5XX_Count');
  assert.equal(q.p99_canary?.Metric?.MetricName, 'TargetResponseTime');
  assert.equal(q.p99_canary?.Stat, 'p99');
  assert.equal(q.rc_canary?.Metric?.Namespace, 'AWS/ApplicationELB');
  assert.deepEqual(q.rc_canary?.Metric?.Dimensions, [
    { Name: 'TargetGroup', Value: TG.canary }, { Name: 'LoadBalancer', Value: LB },
  ]);
  assert.deepEqual(q.rc_control?.Metric?.Dimensions?.[0], { Name: 'TargetGroup', Value: TG.control });
});

test('maps 5XX / RequestCount to a rate observation and p99 to a sign observation, integer counts', async () => {
  const { client } = fakeClient([{
    rc_canary: [600.4, 400.3], rc_control: [998], e5_canary: [6.6], e5_control: [3], p99_canary: [0.41], p99_control: [0.38],
  }]);
  const src = new CloudWatchTwinSource({ client, loadBalancer: LB, targetGroups: TG });
  const body = await src.fetchTick(T0, T0 + 60_000);
  assert.deepEqual(body, {
    canary_requests: 1001,
    control_requests: 998,
    observations: {
      http_5xx: { canary_events: 7, canary_total: 1001, control_events: 3, control_total: 998 },
      p99_latency: { canary: 0.41, control: 0.38 },
    },
  });
});

test('absent 5XX datapoints are zero errors (ALB emits no zero datapoints); absent p99 omits the sign observation', async () => {
  const { client } = fakeClient([{ rc_canary: [50], rc_control: [48], p99_control: [0.3] }]);
  const src = new CloudWatchTwinSource({ client, loadBalancer: LB, targetGroups: TG });
  const body = await src.fetchTick(T0, T0 + 60_000);
  assert.deepEqual(body.observations.http_5xx, { canary_events: 0, canary_total: 50, control_events: 0, control_total: 48 });
  assert.equal('p99_latency' in body.observations, false);
});

test('follows NextToken across pages', async () => {
  const { client, sent } = fakeClient([
    { rc_canary: [10], rc_control: [12] },
    { rc_canary: [5], e5_canary: [1], p99_canary: [0.2], p99_control: [0.25] },
  ]);
  const src = new CloudWatchTwinSource({ client, loadBalancer: LB, targetGroups: TG });
  const body = await src.fetchTick(T0, T0 + 60_000);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].input.NextToken, 'tok1');
  assert.equal(body.canary_requests, 15);
  assert.deepEqual(body.observations.p99_latency, { canary: 0.2, control: 0.25 });
});

test('5XX above RequestCount (per-metric publication skew) is clamped to the total', async () => {
  const { client } = fakeClient([{ rc_canary: [3], rc_control: [4], e5_canary: [5], e5_control: [0] }]);
  const src = new CloudWatchTwinSource({ client, loadBalancer: LB, targetGroups: TG, latencyP99Id: null });
  const body = await src.fetchTick(T0, T0 + 60_000);
  assert.deepEqual(body.observations.http_5xx, { canary_events: 3, canary_total: 3, control_events: 0, control_total: 4 });
});

test('metric ids are configurable and either metric can be disabled', async () => {
  const { client, sent } = fakeClient([{ rc_canary: [3], rc_control: [4], p99_canary: [1], p99_control: [2] }]);
  const src = new CloudWatchTwinSource({
    client, loadBalancer: LB, targetGroups: TG, errorRateId: null, latencyP99Id: 'tail_latency',
  });
  const body = await src.fetchTick(T0, T0 + 60_000);
  assert.deepEqual(Object.keys(body.observations), ['tail_latency']);
  const ids = (sent[0].input.MetricDataQueries ?? []).map((m) => m.Id).sort();
  assert.deepEqual(ids, ['p99_canary', 'p99_control', 'rc_canary', 'rc_control']);
});

test('refuses a window that is not a positive multiple of 60 s or not minute-aligned', async () => {
  const { client } = fakeClient([]);
  const src = new CloudWatchTwinSource({ client, loadBalancer: LB, targetGroups: TG });
  await assert.rejects(() => src.fetchTick(T0, T0 + 90_000), /multiple of 60/);
  await assert.rejects(() => src.fetchTick(T0, T0), /multiple of 60/);
  await assert.rejects(() => src.fetchTick(T0 + 1_000, T0 + 61_000), /minute boundary/);
});

test('refuses the p99 sign metric at a declared canary weight other than 0.5 (sign needs equal weights)', () => {
  const { client } = fakeClient([]);
  assert.throws(
    () => new CloudWatchTwinSource({ client, loadBalancer: LB, targetGroups: TG, canaryWeight: 0.1 }),
    /equal routing weights/,
  );
  assert.doesNotThrow(() => new CloudWatchTwinSource({
    client, loadBalancer: LB, targetGroups: TG, canaryWeight: 0.1, latencyP99Id: null,
  }));
  assert.doesNotThrow(() => new CloudWatchTwinSource({ client, loadBalancer: LB, targetGroups: TG, canaryWeight: 0.5 }));
});

test('a query that CloudWatch reports as failed is an error, not a zero', async () => {
  const client: CloudWatchLike = {
    async send() {
      return {
        $metadata: {},
        MetricDataResults: [{ Id: 'rc_canary', Values: [], StatusCode: 'InternalError' }],
      };
    },
  };
  const src = new CloudWatchTwinSource({ client, loadBalancer: LB, targetGroups: TG });
  await assert.rejects(() => src.fetchTick(T0, T0 + 60_000), /rc_canary.*InternalError/);
});

test('an AbortSignal passed to fetchTick reaches GetMetricData as abortSignal', async () => {
  const seen: unknown[] = [];
  const client: CloudWatchLike = {
    async send(_cmd, opts) { seen.push(opts?.abortSignal); return { $metadata: {}, MetricDataResults: [] }; },
  };
  const ac = new AbortController();
  await new CloudWatchTwinSource({ client, loadBalancer: LB, targetGroups: TG }).fetchTick(T0, T0 + 60_000, ac.signal);
  assert.deepEqual(seen, [ac.signal]);
});

test('a real CloudWatchClient satisfies CloudWatchLike (type check; constructing it makes no call)', () => {
  const real: CloudWatchLike = new CloudWatchClient({ region: 'us-east-1' });
  assert.equal(typeof real.send, 'function');
});
