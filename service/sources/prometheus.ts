// service/sources/prometheus.ts — twin-gate MetricSource over the Prometheus HTTP API
// (GET /api/v1/query, instant queries evaluated at the window end).
//
// Queries are PromQL templates with two placeholders:
//   $arm     the arm's label matchers, e.g. track="canary" (configured once, per arm)
//   $window  the window length as a range, e.g. 60s
// Each template must reduce to at most one series (wrap it in sum(...) or similar).
//
//   counter              -> rate  (events / total, both increase() over the window)
//   histogram exceedance -> rate  (count - bucket{le=L}: requests slower than L, out of count)
//   gauge                -> sign  (one value per arm, e.g. avg_over_time)
//
// Latency as an exceedance rate is not subject to the equal-weight requirement that `sign` has
// (ADR 0036): the rate statistic conditions on the observed arm totals. The engine still refuses
// `rate` at canary_weight != 0.5 unless the session sets allow_unequal_rate_split, which belongs
// only where an A/A run at that split showed no arm-level effect. `sign` is refused at unequal
// weights with no opt-in.
//
// increase() extrapolates to the window edges, so counts are approximate and are rounded to
// integers (the engine throws on non-integers); events are clamped to [0, total].

import type { MetricSource } from './metric-source';
import type { TwinObservationBody, TwinTickBody } from './twin-contract';

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchLikeResponse>;

export interface PromRateSpec {
  id: string;
  kind: 'rate';
  events: string;
  total: string;
  /**
   * How an empty events result is read. 'zero' (default) suits a labelled counter whose error
   * series may not exist yet; 'missing' omits the observation when the arm had traffic, so a
   * template that matches nothing cannot report zero bad events.
   */
  emptyEvents?: 'zero' | 'missing';
}
export interface PromSignSpec { id: string; kind: 'sign'; expr: string }
export type PromTwinMetricSpec = PromRateSpec | PromSignSpec;

export interface PrometheusTwinSourceConfig {
  /** e.g. http://prometheus:9090 (no trailing /api). */
  baseUrl: string;
  fetch: FetchLike;
  /** Label matchers selecting each arm, substituted for $arm. */
  arms: { canary: string; control: string };
  /** Template for the arm's request count over the window (canary_requests / control_requests). */
  requests: string;
  metrics: PromTwinMetricSpec[];
  headers?: Record<string, string>;
}

type Arm = 'canary' | 'control';

/** Latency as a rate: requests slower than `le` (count - bucket{le}) out of count. */
export function histogramExceedance(id: string, histogram: string, le: string): PromRateSpec {
  const count = `sum(increase(${histogram}_count{$arm}[$window]))`;
  const bucket = `sum(increase(${histogram}_bucket{$arm,le="${le}"}[$window]))`;
  return { id, kind: 'rate', events: `${count} - ${bucket}`, total: count, emptyEvents: 'missing' };
}

interface PromVectorSample { value: [number, string] }
interface PromResponse { status: string; error?: string; data?: { resultType: string; result: PromVectorSample[] | [number, string] } }

export class PrometheusTwinSource implements MetricSource {
  constructor(private readonly cfg: PrometheusTwinSourceConfig) {
    if (!cfg.arms.canary.trim() || !cfg.arms.control.trim()) {
      throw new Error('PrometheusTwinSource: each arm selector must be non-empty label matchers');
    }
  }

  async fetchTick(windowStartMs: number, windowEndMs: number): Promise<TwinTickBody> {
    const spanMs = windowEndMs - windowStartMs;
    if (!(spanMs > 0) || spanMs % 1000 !== 0) {
      throw new Error(`PrometheusTwinSource: window must be a positive whole number of seconds, got ${spanMs} ms`);
    }
    const q = (template: string, arm: Arm): Promise<number | null> =>
      this.query(this.render(template, arm, spanMs / 1000), windowEndMs / 1000);

    const [canaryReq, controlReq, ...perMetric] = await Promise.all([
      q(this.cfg.requests, 'canary'),
      q(this.cfg.requests, 'control'),
      ...this.cfg.metrics.map((m) => this.observe(m, q)),
    ]);
    const observations: Record<string, TwinObservationBody> = {};
    this.cfg.metrics.forEach((m, i) => {
      const o = perMetric[i];
      if (o) observations[m.id] = o;
    });
    return { canary_requests: toCount(canaryReq), control_requests: toCount(controlReq), observations };
  }

  private async observe(
    m: PromTwinMetricSpec,
    q: (template: string, arm: Arm) => Promise<number | null>,
  ): Promise<TwinObservationBody | null> {
    if (m.kind === 'sign') {
      const [c, k] = await Promise.all([q(m.expr, 'canary'), q(m.expr, 'control')]);
      return c === null || k === null || !Number.isFinite(c) || !Number.isFinite(k) ? null : { canary: c, control: k };
    }
    const [ce, ct, ke, kt] = await Promise.all([
      q(m.events, 'canary'), q(m.total, 'canary'), q(m.events, 'control'), q(m.total, 'control'),
    ]);
    const canaryTotal = toCount(ct);
    const controlTotal = toCount(kt);
    const unmatched = (e: number | null, total: number): boolean => e === null && total > 0;
    if (m.emptyEvents === 'missing' && (unmatched(ce, canaryTotal) || unmatched(ke, controlTotal))) return null;
    return {
      canary_events: Math.min(toCount(ce), canaryTotal),
      canary_total: canaryTotal,
      control_events: Math.min(toCount(ke), controlTotal),
      control_total: controlTotal,
    };
  }

  private render(template: string, arm: Arm, windowSeconds: number): string {
    return template.split('$arm').join(this.cfg.arms[arm]).split('$window').join(`${windowSeconds}s`);
  }

  /** One instant query; null for an empty result. */
  private async query(promql: string, timeSeconds: number): Promise<number | null> {
    const url = new URL('/api/v1/query', this.cfg.baseUrl);
    url.searchParams.set('query', promql);
    url.searchParams.set('time', String(timeSeconds));
    const res = await this.cfg.fetch(url.toString(), { headers: this.cfg.headers });
    const body = (await res.json()) as PromResponse;
    if (!res.ok || body.status !== 'success' || !body.data) {
      throw new Error(`PrometheusTwinSource: HTTP ${res.status} for ${promql}: ${body.error ?? body.status}`);
    }
    return sampleValue(body.data, promql);
  }
}

function sampleValue(data: NonNullable<PromResponse['data']>, promql: string): number | null {
  if (data.resultType === 'scalar') return Number((data.result as [number, string])[1]);
  const result = data.result as PromVectorSample[];
  if (result.length === 0) return null;
  if (result.length > 1) {
    throw new Error(`PrometheusTwinSource: ${promql} returned ${result.length} series; aggregate it to one`);
  }
  return Number(result[0].value[1]);
}

/** Round an extrapolated count to a non-negative integer; absent or non-finite is 0. */
function toCount(v: number | null): number {
  return v === null || !Number.isFinite(v) ? 0 : Math.max(0, Math.round(v));
}
