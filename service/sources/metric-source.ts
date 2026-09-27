// service/sources/metric-source.ts — the interface every twin-gate metric source implements.
//
// A source turns one wall-clock window of the orchestrator's telemetry into exactly the tick
// body the gate's POST /v1/sessions/{id}/ticks accepts. Sources hold no gate state; the caller
// (e.g. integrations/codedeploy/after-allow-traffic.ts) owns windows and the session.

import type { TwinTickBody } from './twin-contract';

export type { TwinTickBody } from './twin-contract';

export interface MetricSource {
  /** Observations for [windowStartMs, windowEndMs), epoch milliseconds. */
  fetchTick(windowStartMs: number, windowEndMs: number): Promise<TwinTickBody>;
}
