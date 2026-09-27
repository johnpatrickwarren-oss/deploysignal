// service/sources/cloudwatch.ts — twin-gate MetricSource over ALB target-group metrics in
// CloudWatch (GetMetricData, AWS/ApplicationELB namespace).
//
// Topology it assumes (ADR 0036 premise; ORCHESTRATION-ADAPTERS.md "Twin gate"): the canary and a
// freshly started control on the OLD version sit in their own target groups on one listener,
// receiving per-request randomized traffic at equal weight. The production fleet's target group
// is not an arm.
//
//   rate  <- HTTPCode_Target_5XX_Count (Sum) out of RequestCount (Sum), per target group
//   sign  <- TargetResponseTime p99, per target group
//
// `sign` needs equal routing weights: with unequal arm sizes a skewed tick statistic (a p99 over
// N requests) has a different median in each arm even with no regression, so the engine refuses
// it at canary_weight != 0.5 with no opt-in. This source refuses it at construction when a
// canaryWeight other than 0.5 is declared.
//
// Counts are rounded to integers (the engine throws on non-integer counts). The client is
// injected; this module never constructs one and makes no AWS call of its own.

import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { GetMetricDataCommandOutput, MetricDataQuery } from '@aws-sdk/client-cloudwatch';

import type { MetricSource } from './metric-source';
import type { TwinObservationBody, TwinTickBody } from './twin-contract';

/** The slice of CloudWatchClient this source uses; a CloudWatchClient satisfies it. */
export interface CloudWatchLike {
  send(command: GetMetricDataCommand, options?: { abortSignal?: AbortSignal }): Promise<GetMetricDataCommandOutput>;
}

export interface CloudWatchTwinSourceConfig {
  client: CloudWatchLike;
  /** LoadBalancer dimension value, e.g. "app/my-alb/50dc6c495c0c9188". */
  loadBalancer: string;
  /** TargetGroup dimension values, e.g. "targetgroup/my-canary/73e2d6bc24d8a067". */
  targetGroups: { canary: string; control: string };
  /** Metric id for the 5XX rate observation; null disables it. Default "http_5xx". */
  errorRateId?: string | null;
  /** Metric id for the p99 sign observation; null disables it. Default "p99_latency". */
  latencyP99Id?: string | null;
  /** The session's canary_weight, when known; a sign metric at != 0.5 is refused. */
  canaryWeight?: number;
}

type Arm = 'canary' | 'control';
const ARMS: Arm[] = ['canary', 'control'];
const MINUTE_MS = 60_000;

export class CloudWatchTwinSource implements MetricSource {
  private readonly errorRateId: string | null;
  private readonly latencyP99Id: string | null;

  constructor(private readonly cfg: CloudWatchTwinSourceConfig) {
    this.errorRateId = cfg.errorRateId === undefined ? 'http_5xx' : cfg.errorRateId;
    this.latencyP99Id = cfg.latencyP99Id === undefined ? 'p99_latency' : cfg.latencyP99Id;
    if (this.latencyP99Id !== null && cfg.canaryWeight !== undefined && cfg.canaryWeight !== 0.5) {
      throw new Error(
        `CloudWatchTwinSource: sign metric "${this.latencyP99Id}" needs equal routing weights ` +
        `(canary_weight 0.5), got ${cfg.canaryWeight}; set latencyP99Id: null or split traffic 50/50`,
      );
    }
  }

  async fetchTick(windowStartMs: number, windowEndMs: number, signal?: AbortSignal): Promise<TwinTickBody> {
    const spanMs = windowEndMs - windowStartMs;
    if (!(spanMs > 0) || spanMs % MINUTE_MS !== 0) {
      throw new Error(`CloudWatchTwinSource: window must be a positive multiple of 60 s, got ${spanMs} ms`);
    }
    if (windowStartMs % MINUTE_MS !== 0) {
      throw new Error('CloudWatchTwinSource: window must start on a minute boundary');
    }
    const values = await this.fetchAll(this.queries(spanMs / 1000), windowStartMs, windowEndMs, signal);
    return this.toBody(values);
  }

  private queries(periodSeconds: number): MetricDataQuery[] {
    const out: MetricDataQuery[] = [];
    const add = (id: string, metricName: string, stat: string, tg: string): void => {
      out.push({
        Id: id,
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ApplicationELB',
            MetricName: metricName,
            Dimensions: [{ Name: 'TargetGroup', Value: tg }, { Name: 'LoadBalancer', Value: this.cfg.loadBalancer }],
          },
          Period: periodSeconds,
          Stat: stat,
        },
      });
    };
    for (const arm of ARMS) {
      const tg = this.cfg.targetGroups[arm];
      add(`rc_${arm}`, 'RequestCount', 'Sum', tg);
      if (this.errorRateId !== null) add(`e5_${arm}`, 'HTTPCode_Target_5XX_Count', 'Sum', tg);
      if (this.latencyP99Id !== null) add(`p99_${arm}`, 'TargetResponseTime', 'p99', tg);
    }
    return out;
  }

  private async fetchAll(
    queries: MetricDataQuery[], startMs: number, endMs: number, signal?: AbortSignal,
  ): Promise<Map<string, number[]>> {
    const values = new Map<string, number[]>();
    let nextToken: string | undefined;
    do {
      const out = await this.cfg.client.send(new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: new Date(startMs),
        EndTime: new Date(endMs),
        NextToken: nextToken,
      }), signal ? { abortSignal: signal } : undefined);
      for (const r of out.MetricDataResults ?? []) {
        if (!r.Id) continue;
        if (r.StatusCode === 'InternalError' || r.StatusCode === 'Forbidden') {
          throw new Error(`CloudWatchTwinSource: query ${r.Id} returned ${r.StatusCode}`);
        }
        values.set(r.Id, [...(values.get(r.Id) ?? []), ...(r.Values ?? [])]);
      }
      nextToken = out.NextToken;
    } while (nextToken);
    return values;
  }

  private toBody(values: Map<string, number[]>): TwinTickBody {
    const sum = (id: string): number => Math.round((values.get(id) ?? []).reduce((a, b) => a + b, 0));
    const canaryTotal = sum('rc_canary');
    const controlTotal = sum('rc_control');
    const observations: Record<string, TwinObservationBody> = {};
    if (this.errorRateId !== null) {
      // ALB publishes no zero datapoints, so an absent 5XX series is zero errors. Metrics are
      // published independently; clamp so a skewed publication cannot put events above total.
      observations[this.errorRateId] = {
        canary_events: Math.min(sum('e5_canary'), canaryTotal),
        canary_total: canaryTotal,
        control_events: Math.min(sum('e5_control'), controlTotal),
        control_total: controlTotal,
      };
    }
    const p99c = values.get('p99_canary') ?? [];
    const p99k = values.get('p99_control') ?? [];
    // A percentile cannot be merged across periods; anything but one value per arm is missing
    // (the engine applies its ½ factor to a missing observation while the canary has traffic).
    if (this.latencyP99Id !== null && p99c.length === 1 && p99k.length === 1) {
      observations[this.latencyP99Id] = { canary: p99c[0], control: p99k[0] };
    }
    return { canary_requests: canaryTotal, control_requests: controlTotal, observations };
  }
}
