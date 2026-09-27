// service/sources/twin-contract.ts — wire types for the twin gate's HTTP contract (snake_case).
//
// These mirror the shared contract between the gate service (Plan B, POST /v1/sessions and
// POST /v1/sessions/{id}/ticks) and its callers (the metric sources and orchestrator hooks
// here). They are the contract's shapes, not imports of the service's code, so a caller can be
// built and tested without the service.
//
// Engine premise (deploysignal-engine v0.12.0-pre, ADR 0036): per-request randomized routing
// between a canary arm and a concurrent control arm on the old version, with no arm-level
// effect on any tick. `rate` is refused at canary_weight != 0.5 unless allow_unequal_rate_split;
// `sign` is refused at unequal weights with no opt-in.

/** A rate observation: bad events out of requests, per arm, for one tick. Integers only. */
export interface TwinRateObservationBody {
  canary_events: number;
  canary_total: number;
  control_events: number;
  control_total: number;
}

/** A sign observation: one tick statistic per arm (compared canary-worse or not). */
export interface TwinSignObservationBody {
  canary: number;
  control: number;
}

export type TwinObservationBody = TwinRateObservationBody | TwinSignObservationBody;

/** Body of POST /v1/sessions/{id}/ticks. */
export interface TwinTickBody {
  canary_requests: number;
  control_requests: number;
  /** Keyed by metric id. An absent id is a missing observation (engine: ½ wealth factor). */
  observations: Record<string, TwinObservationBody>;
}

export interface TwinMetricSpecBody {
  id: string;
  kind: 'rate' | 'sign';
  worse: 'higher' | 'lower';
  tolerance: number;
}

export interface TwinArmBody {
  canary_weight: number;
  alpha_rollback: number;
  alpha_proceed: number;
  alpha_srm: number;
  max_ticks: number;
  allow_unequal_rate_split?: boolean;
  metrics: TwinMetricSpecBody[];
}

/** Body of POST /v1/sessions for a twin session (no scenario.baseline). */
export interface TwinSessionRequest {
  mode: 'twin';
  twin_arm: TwinArmBody;
}

export interface TwinSessionResponse {
  session_id: string;
  mode: 'twin';
}

export type TwinEngineVerdict = 'rollback' | 'proceed' | 'extend' | 'inconclusive' | 'invalid_experiment';
export type TwinGateVerdict = 'rollback' | 'proceed' | 'extend' | 'hold' | 'halt';

export interface TwinMetricEvidenceBody {
  id: string;
  rollback_e: number;
  rollback_threshold: number;
  proceed_e: number;
  proceed_threshold: number;
  used: number;
  skipped: number;
  ties: number;
  missing: number;
}

/** 200 response of POST /v1/sessions/{id}/ticks. */
export interface TwinTickResponse {
  verdict: TwinGateVerdict;
  engine_verdict: TwinEngineVerdict;
  authority: string;
  tick: number;
  srm_e: number;
  metrics: TwinMetricEvidenceBody[];
  ticks_to_detect?: number;
}

export function isRateObservationBody(o: TwinObservationBody): o is TwinRateObservationBody {
  return 'canary_events' in o;
}

function assertCount(v: unknown, name: string): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`twin tick body: ${name} must be a non-negative integer, got ${String(v)}`);
  }
}

function assertRate(id: string, o: TwinRateObservationBody): void {
  for (const k of ['canary_events', 'canary_total', 'control_events', 'control_total'] as const) {
    assertCount(o[k], `${id}.${k}`);
  }
  if (o.canary_events > o.canary_total) throw new Error(`twin tick body: ${id}.canary_events exceeds canary_total`);
  if (o.control_events > o.control_total) throw new Error(`twin tick body: ${id}.control_events exceeds control_total`);
}

function assertSign(id: string, o: TwinSignObservationBody): void {
  for (const k of ['canary', 'control'] as const) {
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) {
      throw new Error(`twin tick body: ${id}.${k} must be a finite number, got ${String(o[k])}`);
    }
  }
}

/** Throws on a body the engine would refuse (non-integer or negative counts, events > total). */
export function assertTwinTickBody(body: TwinTickBody): void {
  assertCount(body.canary_requests, 'canary_requests');
  assertCount(body.control_requests, 'control_requests');
  for (const [id, o] of Object.entries(body.observations)) {
    if (isRateObservationBody(o)) assertRate(id, o);
    else assertSign(id, o);
  }
}
