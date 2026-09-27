// test/_twin-fixture.ts — seeded ticks for the Plan B twin tests (engine ADR 0036). Two arms under
// randomized routing at equal weight: per tick each arm takes `n` requests; the rate metrics are
// binomial draws (http_5xx bad events, success good events) and the sign metric is one p99 value
// per arm. A regressed canary multiplies its 5xx odds and shifts its latency. No Math.random.

import { mulberry32, gauss } from './_c64-fixture';
import type { TwinArmProfile } from '../dist/engine/types';

export const TWIN_PROFILE: TwinArmProfile = {
  canary_weight: 0.5,
  alpha_rollback: 0.05,
  alpha_proceed: 0.05,
  alpha_srm: 0.001,
  max_ticks: 120,
  metrics: [
    { id: 'http_5xx', kind: 'rate', worse: 'higher', tolerance: 0.2 },
    { id: 'success', kind: 'rate', worse: 'lower', tolerance: 0.2 },
    { id: 'p99_latency_ms', kind: 'sign', worse: 'higher', tolerance: 0.15 },
  ],
};

export interface TwinArmsSpec {
  /** requests per arm per tick. */
  n?: number;
  /** control 5xx probability. */
  p5xx?: number;
  /** canary 5xx odds multiplier (1 = A/A). */
  canaryOdds?: number;
  /** canary latency shift in control sigmas (0 = A/A). */
  latencyShift?: number;
}

export interface CamelTick {
  canaryRequests: number;
  controlRequests: number;
  observations: Record<string, { canaryEvents: number; canaryTotal: number; controlEvents: number; controlTotal: number } | { canary: number; control: number }>;
}

export interface SnakeTick {
  canary_requests: number;
  control_requests: number;
  observations: Record<string, { canary_events: number; canary_total: number; control_events: number; control_total: number } | { canary: number; control: number }>;
}

function binomial(r: () => number, n: number, p: number): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (r() < p) k++;
  return k;
}

/** A generator of camelCase ticks (the engine's TwinTickInput shape). */
export function twinTicks(seed: number, spec: TwinArmsSpec = {}): () => CamelTick {
  const n = spec.n ?? 1000;
  const p = spec.p5xx ?? 0.01;
  const odds = spec.canaryOdds ?? 1;
  const pc = (odds * p) / (1 - p + odds * p);
  const r = mulberry32(seed);
  const g = gauss(seed + 7);
  return () => {
    const c5 = binomial(r, n, pc);
    const k5 = binomial(r, n, p);
    return {
      canaryRequests: n,
      controlRequests: n,
      observations: {
        http_5xx: { canaryEvents: c5, canaryTotal: n, controlEvents: k5, controlTotal: n },
        success: { canaryEvents: n - c5, canaryTotal: n, controlEvents: n - k5, controlTotal: n },
        p99_latency_ms: { canary: 200 + 10 * g() + 10 * (spec.latencyShift ?? 0), control: 200 + 10 * g() },
      },
    };
  };
}

/** The same tick in the HTTP contract's snake_case. */
export function toSnake(t: CamelTick): SnakeTick {
  const observations: SnakeTick['observations'] = {};
  for (const [id, o] of Object.entries(t.observations)) {
    observations[id] = 'canaryTotal' in o
      ? { canary_events: o.canaryEvents, canary_total: o.canaryTotal, control_events: o.controlEvents, control_total: o.controlTotal }
      : { canary: o.canary, control: o.control };
  }
  return { canary_requests: t.canaryRequests, control_requests: t.controlRequests, observations };
}
