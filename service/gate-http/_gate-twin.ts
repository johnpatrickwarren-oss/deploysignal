// service/gate-http/_gate-twin.ts — Plan B: the gate service's `mode: "twin"` sessions (engine
// ADR 0036, the randomized twin). The shared HTTP contract, JSON snake_case:
//
//   POST /v1/sessions            {"mode":"twin","twin_arm":{canary_weight, alpha_rollback,
//                                  alpha_proceed, alpha_srm, max_ticks, allow_unequal_rate_split?,
//                                  metrics:[{id, kind, worse, tolerance, margin?:{relative?, absolute?}}]}}
//                                -> 201 {"session_id","mode":"twin"}   (no scenario.baseline)
//   POST /v1/sessions/{id}/ticks {canary_requests, control_requests, observations:{<id>:
//                                  {canary_events, canary_total, control_events, control_total}
//                                  | {canary, control}}}
//                                -> 200 {verdict, engine_verdict, authority, tick, srm_e,
//                                        metrics[], ticks_to_detect?}
//
// Optional on create: deploy_ref (safe identifier; an active session with the same deploy_ref and
// the same twin_arm is returned with 200, a different twin_arm is 409), requested_at_ts, deploy_id,
// service_id. Optional on a tick: emitted_at_ts (unix seconds) — when present it is the
// idempotency key and a retry replays the stored body; when absent every POST is a new tick.
//
// PERSISTENCE follows GateSessionRuntime (service/gate-http/_gate-session-runtime.ts, OQ-1): the
// SessionRecord (with `twin_arm`) and one verdict-history line per tick are durable; the gate state
// (the engine's TwinGateState plus the planning accumulators) lives in an in-memory map keyed by
// session_id; a restart voids every active session (sweepOnBoot). A twin session whose state is
// missing mid-bake is voided `twin_state_lost` rather than restarted from a fresh gate.
//
// AUTHORITY: ADVISORY (TWIN_ARM_AUTHORITY). The record is `mode: 'shadow'`, so GET
// /v1/verdict/{deploy_ref} serves verdict_code 0 with the real code on shadow_verdict_code; a
// twin rollback never sets the deployment phase to rolled_back; every tick body carries
// "authority":"advisory".

import type { SessionStore } from '../session/session-store';
import type { SessionRecord, VerdictHistoryEntry, TwinTickResponse, BeginSessionInput } from '../session/types';
import type { TwinArmProfile, TwinArmMetricProfile } from '../../engine/types/_config-profiles';
import type {
  TwinArmRun, TwinArmReport, TwinTickInput, TwinGateVerdict,
} from '../../engine/gates/_health-twin';
import type { TwinObservation } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/twin-contrast';
import { isSafeIdentifier } from './_gate-http-util';
import { DEFAULT_TWIN_MAX_TICK_COUNT } from './_gate-config';

// Runtime values from the built engine (the require()-the-build-artifact convention of
// _gate-session-runtime.ts: service/ is compiled by tsconfig.test.json, which does not build engine/).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const twinRuntime = require('../../dist/engine/gates/_health-twin');
const freshTwinArm: (p: TwinArmProfile) => TwinArmRun = twinRuntime.freshTwinArm;
const stepTwinArm: (p: TwinArmProfile, run: TwinArmRun, input: TwinTickInput) => { run: TwinArmRun; report: TwinArmReport } = twinRuntime.stepTwinArm;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TWIN_ARM_AUTHORITY: 'advisory' = require('../../dist/engine/guarantees').TWIN_ARM_AUTHORITY;

/** A request error the handler turns into a status code. */
export class TwinRequestError extends Error {
  constructor(readonly status: 400 | 409, message: string, readonly body?: Record<string, unknown>) {
    super(message);
    this.name = 'TwinRequestError';
  }
}

const bad = (msg: string): TwinRequestError => new TwinRequestError(400, msg);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;

// ── parsing: session create ────────────────────────────────────────────────────────────────

const ARM_KEYS = new Set(['canary_weight', 'alpha_rollback', 'alpha_proceed', 'alpha_srm', 'max_ticks', 'allow_unequal_rate_split', 'metrics']);
const METRIC_KEYS = new Set(['id', 'kind', 'worse', 'tolerance', 'margin']);
const MARGIN_KEYS = new Set(['relative', 'absolute']);

function rejectExtraKeys(o: Record<string, unknown>, allowed: Set<string>, where: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.has(k));
  if (extra.length > 0) throw bad(`${where}: unknown field(s) ${extra.join(', ')}`);
}

function parseMetric(raw: unknown, i: number): TwinArmMetricProfile {
  const where = `twin_arm.metrics[${i}]`;
  if (!isObj(raw)) throw bad(`${where} must be an object`);
  rejectExtraKeys(raw, METRIC_KEYS, where);
  if (typeof raw.id !== 'string' || raw.id.length === 0) throw bad(`${where}.id must be a non-empty string`);
  if (raw.kind !== 'rate' && raw.kind !== 'sign') throw bad(`${where}.kind must be 'rate' or 'sign'`);
  if (raw.worse !== 'higher' && raw.worse !== 'lower') throw bad(`${where}.worse must be 'higher' or 'lower'`);
  if (!isNum(raw.tolerance)) throw bad(`${where}.tolerance must be a number`);
  const out: TwinArmMetricProfile = { id: raw.id, kind: raw.kind, worse: raw.worse, tolerance: raw.tolerance };
  if (raw.margin !== undefined) {
    // engine ADR 0037: shape checked here, ranges and the sign-only rule by the engine (checkTwinMetricSpec)
    if (!isObj(raw.margin)) throw bad(`${where}.margin must be an object { relative?, absolute? }`);
    rejectExtraKeys(raw.margin, MARGIN_KEYS, `${where}.margin`);
    const margin: { relative?: number; absolute?: number } = {};
    if (raw.margin.relative !== undefined) { if (!isNum(raw.margin.relative)) throw bad(`${where}.margin.relative must be a number`); margin.relative = raw.margin.relative; }
    if (raw.margin.absolute !== undefined) { if (!isNum(raw.margin.absolute)) throw bad(`${where}.margin.absolute must be a number`); margin.absolute = raw.margin.absolute; }
    out.margin = margin;
  }
  return out;
}

function parseArmScalars(raw: Record<string, unknown>): Omit<TwinArmProfile, 'metrics'> {
  for (const k of ['canary_weight', 'alpha_rollback', 'alpha_proceed', 'alpha_srm'] as const) {
    if (!isNum(raw[k])) throw bad(`twin_arm.${k} must be a number`);
  }
  if (!(isNum(raw.max_ticks) && Number.isInteger(raw.max_ticks))) throw bad('twin_arm.max_ticks must be an integer');
  if (raw.allow_unequal_rate_split !== undefined && typeof raw.allow_unequal_rate_split !== 'boolean') {
    throw bad('twin_arm.allow_unequal_rate_split must be a boolean');
  }
  return {
    canary_weight: raw.canary_weight as number, alpha_rollback: raw.alpha_rollback as number,
    alpha_proceed: raw.alpha_proceed as number, alpha_srm: raw.alpha_srm as number, max_ticks: raw.max_ticks,
    ...(raw.allow_unequal_rate_split !== undefined ? { allow_unequal_rate_split: raw.allow_unequal_rate_split as boolean } : {}),
  };
}

/** The request's twin_arm, shape-checked here and range-checked by the engine
 *  (checkTwinGateConfig, via freshTwinArm): a refused config is a 400 with the engine's reason. */
export function parseTwinArm(raw: unknown): TwinArmProfile {
  if (!isObj(raw)) throw bad('twin_arm is required (an object) in mode "twin"');
  rejectExtraKeys(raw, ARM_KEYS, 'twin_arm');
  if (!Array.isArray(raw.metrics) || raw.metrics.length === 0) throw bad('twin_arm.metrics must be a non-empty array');
  const arm: TwinArmProfile = { ...parseArmScalars(raw), metrics: raw.metrics.map(parseMetric) };
  try {
    freshTwinArm(arm);
  } catch (e) {
    throw bad(`twin_arm refused: ${e instanceof Error ? e.message : String(e)}`);
  }
  return arm;
}

// ── parsing: a tick ────────────────────────────────────────────────────────────────────────

const RATE_KEYS = ['canary_events', 'canary_total', 'control_events', 'control_total'] as const;

/** A per-tick count above `cap` is refused before the engine sees it (review 2026-09-26: the
 *  engine's Fisher noncentral mean is O(N) on the request thread; see DEFAULT_TWIN_MAX_TICK_COUNT). */
function checkCap(where: string, v: number, cap: number): void {
  if (v > cap) {
    throw bad(`${where} = ${v} exceeds the per-tick cap ${cap} (DS_GATE_TWIN_MAX_TICK_COUNT); `
      + 'send per-tick deltas, not cumulative counters');
  }
}

function parseRateObs(id: string, o: Record<string, unknown>, cap: number): TwinObservation {
  rejectExtraKeys(o, new Set(RATE_KEYS), `observations.${id}`);
  for (const k of RATE_KEYS) {
    if (!isNonNegInt(o[k])) throw bad(`observations.${id}.${k} must be a non-negative integer (a rate metric takes counts)`);
    checkCap(`observations.${id}.${k}`, o[k] as number, cap);
  }
  return {
    canaryEvents: o.canary_events as number, canaryTotal: o.canary_total as number,
    controlEvents: o.control_events as number, controlTotal: o.control_total as number,
  };
}

/** A sign value may be null (the source had no value): the engine scores it missing (½ penalty). */
function signValue(id: string, k: 'canary' | 'control', v: unknown): number {
  if (v === null) return Number.NaN;
  if (!isNum(v)) throw bad(`observations.${id}.${k} must be a number or null (a sign metric takes one value per arm)`);
  return v;
}

function parseObservation(m: TwinArmMetricProfile, raw: unknown, cap: number): TwinObservation {
  if (!isObj(raw)) throw bad(`observations.${m.id} must be an object`);
  if (m.kind === 'rate') return parseRateObs(m.id, raw, cap);
  rejectExtraKeys(raw, new Set(['canary', 'control']), `observations.${m.id}`);
  return { canary: signValue(m.id, 'canary', raw.canary), control: signValue(m.id, 'control', raw.control) };
}

/** The tick body as the engine's TwinTickInput. A metric absent from `observations` stays absent:
 *  while the canary takes traffic the engine counts it missing (½ penalty, engine ADR 0036). */
export function parseTwinTick(
  arm: TwinArmProfile,
  body: Record<string, unknown>,
  maxTickCount: number = DEFAULT_TWIN_MAX_TICK_COUNT,
): TwinTickInput {
  if (!isNonNegInt(body.canary_requests)) throw bad('canary_requests must be a non-negative integer');
  if (!isNonNegInt(body.control_requests)) throw bad('control_requests must be a non-negative integer');
  checkCap('canary_requests', body.canary_requests, maxTickCount);
  checkCap('control_requests', body.control_requests, maxTickCount);
  if (!isObj(body.observations)) throw bad('observations is required (an object keyed by metric id)');
  const byId = new Map(arm.metrics.map((m) => [m.id, m]));
  const observations: Record<string, TwinObservation> = {};
  for (const [id, raw] of Object.entries(body.observations)) {
    const m = byId.get(id);
    if (!m) throw bad(`observations: unknown metric id '${id}' (declared: ${arm.metrics.map((x) => x.id).join(', ')})`);
    observations[id] = parseObservation(m, raw, maxTickCount);
  }
  return { canaryRequests: body.canary_requests, controlRequests: body.control_requests, observations };
}

// ── the runtime ────────────────────────────────────────────────────────────────────────────

export interface TwinBeginRequest {
  twin_arm: TwinArmProfile;
  deploy_ref?: string;
  deploy_id?: string;
  service_id?: string;
  requested_at_ts?: number;
}

export interface TwinBeginResult { record: SessionRecord; created: boolean }

/** Verdict code for the durable last_verdict (served only through shadow_verdict_code). */
function codeFor(v: TwinGateVerdict): number {
  return v === 'proceed' ? 0 : v === 'rollback' ? 1 : -1;
}

function sameArm(a: TwinArmProfile | undefined, b: TwinArmProfile): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The response body: the report without srm_threshold (the contract's field set). */
function responseOf(report: TwinArmReport): TwinTickResponse {
  const { srm_threshold: _t, ...body } = report;
  return body;
}

export class TwinSessionRuntime {
  private readonly runs = new Map<string, TwinArmRun>();

  constructor(
    private readonly store: SessionStore,
    private readonly cfg: { serviceId: string; failPolicy: 'fail_open' | 'fail_closed'; twinMaxTickCount?: number },
    private readonly uniquify: (base: string) => string,
  ) {}

  /** Forget a session's in-memory state (finish, void, TTL). */
  drop(sessionId: string): void {
    this.runs.delete(sessionId);
  }

  begin(req: TwinBeginRequest): TwinBeginResult {
    if (req.deploy_ref !== undefined && !isSafeIdentifier(req.deploy_ref)) {
      throw bad('deploy_ref contains invalid characters: allowed are A-Za-z0-9._-');
    }
    const existing = req.deploy_ref !== undefined ? this.store.getSessionByDeployRef(req.deploy_ref) : null;
    if (existing && existing.status === 'active') {
      if (!sameArm(existing.twin_arm, req.twin_arm)) {
        throw new TwinRequestError(409, `deploy_ref ${req.deploy_ref} has an active session with a different configuration`);
      }
      return { record: existing, created: false };
    }
    const ts = req.requested_at_ts ?? Date.now() / 1000;
    const deployRef = req.deploy_ref ?? `twin-${Math.round(ts * 1000)}`;
    const record = this.store.beginSession(this.beginInput(req, deployRef, ts));
    this.runs.set(record.session_id, freshTwinArm(req.twin_arm));
    return { record, created: true };
  }

  private beginInput(req: TwinBeginRequest, deployRef: string, ts: number): BeginSessionInput {
    return {
      session_id: this.uniquify(`sess-${deployRef}-${Math.floor(ts)}`),
      service_id: req.service_id ?? this.cfg.serviceId,
      deploy_id: req.deploy_id ?? deployRef,
      deploy_ref: deployRef,
      mode: 'shadow', // TWIN_ARM_AUTHORITY 'advisory': a twin verdict never blocks through /v1/verdict
      fail_policy: this.cfg.failPolicy,
      active_calibration_version: 'twin',
      compiled_config_path: null,
      baseline_ref: null,
      total_ticks: req.twin_arm.max_ticks,
      begun_request_ts: ts,
      begun_at: new Date(ts * 1000).toISOString(),
      deployment: { phase: 'baking', start_time_ms: ts * 1000, cloud: 'primary' },
      scenario: { risk_level: 'medium', change_type: 'serving_code', author: 'human', time_window: 'ok', flags: {}, baseline: {} },
      twin_arm: req.twin_arm,
    };
  }

  /** One tick. `emittedAtTs` (optional) is the idempotency key. Throws TwinRequestError 400 on a
   *  malformed tick (the gate state is untouched) and 409 on a session that is not active. */
  tick(session: SessionRecord, body: Record<string, unknown>): TwinTickResponse {
    const arm = session.twin_arm!;
    const key = isNum(body.emitted_at_ts) ? body.emitted_at_ts : undefined;
    if (key !== undefined && this.store.hasTick(session.session_id, key)) {
      return this.store.getStoredTickResponse(session.session_id, key)!.twin!;
    }
    if (session.status !== 'active') throw this.notActive(session);
    const input = parseTwinTick(arm, body, this.cfg.twinMaxTickCount ?? DEFAULT_TWIN_MAX_TICK_COUNT);
    const run = this.runFor(session);
    let step: { run: TwinArmRun; report: TwinArmReport };
    try {
      step = stepTwinArm(arm, run, input);
    } catch (e) {
      throw bad(`tick refused by the engine: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.runs.set(session.session_id, step.run);
    const response = responseOf(step.report);
    this.persist(session, key ?? Date.now() / 1000, step.report, response);
    return response;
  }

  private notActive(session: SessionRecord): TwinRequestError {
    return new TwinRequestError(409, `session ${session.session_id} is ${session.status}`, {
      status: session.status, void_reason: session.void_reason, last_verdict: session.last_verdict,
    });
  }

  /** The in-memory run; a missing one mid-bake means the state was lost — void, never restart. */
  private runFor(session: SessionRecord): TwinArmRun {
    const run = this.runs.get(session.session_id);
    if (run) return run;
    if (session.tick === 0) return freshTwinArm(session.twin_arm!);
    const voided = this.store.voidSession(session.session_id, 'twin_state_lost');
    throw this.notActive(voided);
  }

  private persist(session: SessionRecord, emittedAtTs: number, report: TwinArmReport, response: TwinTickResponse): void {
    const recordedAt = new Date().toISOString();
    const fires = report.metrics.filter((m) => m.rollback_e >= m.rollback_threshold).map((m) => m.id);
    const code = codeFor(report.verdict);
    const entry: VerdictHistoryEntry = {
      session_id: session.session_id, tick: session.tick, emitted_at_ts: emittedAtTs,
      verdict: report.verdict, verdict_code: code, alpha_consumed: 0, fires, shadow: true,
      recorded_at: recordedAt, twin: response,
    };
    this.store.appendVerdict(entry);
    this.store.updateSession(session.session_id, {
      tick: report.tick,
      last_tick_at: recordedAt,
      last_verdict: { verdict: report.verdict, verdict_code: code, tick: session.tick, alpha_consumed: 0, fires, engine_verdict: report.engine_verdict },
    });
    // Engine terminal verdicts are sticky; the session ends with them. Advisory: the phase stays
    // as it was (never rolled_back) whatever the verdict.
    if (report.engine_verdict !== 'extend') {
      this.store.finishSession(session.session_id, `twin_${report.engine_verdict}`);
      this.drop(session.session_id);
    }
  }
}

/** The twin block GET /v1/verdict adds for a twin session (advisory; never the served code). */
export function twinVerdictBlock(session: SessionRecord): { verdict: string; engine_verdict: string; authority: 'advisory'; tick: number } {
  const lv = session.last_verdict;
  return {
    verdict: lv?.verdict ?? 'extend',
    engine_verdict: lv?.engine_verdict ?? 'extend',
    authority: TWIN_ARM_AUTHORITY,
    tick: session.tick,
  };
}
