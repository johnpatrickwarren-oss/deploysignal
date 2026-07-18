// service/gate-http/_gate-handlers.ts — Task 7 (WS4 session-durability-
// argo plan): one function per endpoint, each returning a
// {status, body} result — no direct http.ServerResponse writes here so
// each handler is independently testable and stays under the plan's
// <100-line-per-handler bar. `_gate-router.ts` owns dispatch + actually
// writing the response.

import * as fs from 'fs';

import type { AuditWriter } from '../../engine/types';
import { SessionStore } from '../session/session-store';
import { resolveActiveCalibration, ActiveCalibrationError } from '../session/active-calibration';
import {
  GateSessionRuntime,
} from './_gate-session-runtime';
import type { GateHttpConfig } from './_gate-config';
import type { MaintenanceScheduler } from './_gate-maintenance';
import { isSafeIdentifier } from './_gate-http-util';

export interface HandlerDeps {
  runtime: GateSessionRuntime;
  store: SessionStore;
  cfg: GateHttpConfig;
  auditWriter: AuditWriter;
  maintenance: MaintenanceScheduler;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

function badRequest(message: string): HandlerResult {
  return { status: 400, body: { error: message } };
}

function parseJsonBody(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: HandlerResult } {
  if (!raw) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: badRequest('body must be a JSON object') };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: badRequest(`invalid JSON body: ${e instanceof Error ? e.message : String(e)}`) };
  }
}

// ── POST /v1/sessions ──────────────────────────────────────────────

export function handleBeginSession(deps: HandlerDeps, rawBody: string): HandlerResult {
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) return parsed.error;
  const body = parsed.value;

  if (typeof body.deploy_ref !== 'string' || !body.deploy_ref) return badRequest('deploy_ref is required');
  // m4 fix (final-review): deploy_ref flows straight into the
  // `sess-${deploy_ref}-${ts}` session_id, which SessionStore uses as a
  // filename — reject anything outside the safe identifier charset
  // (blocks `../` traversal segments) before it reaches the store.
  if (!isSafeIdentifier(body.deploy_ref)) {
    return badRequest('deploy_ref contains invalid characters: allowed are A-Za-z0-9._-');
  }
  if (typeof body.requested_at_ts !== 'number') return badRequest('requested_at_ts is required (unix seconds)');
  const scenario = body.scenario as { baseline?: unknown } | undefined;
  if (!scenario || typeof scenario !== 'object' || typeof scenario.baseline !== 'object' || scenario.baseline === null) {
    return badRequest('scenario.baseline is required'); // OQ-8
  }

  try {
    const result = deps.runtime.begin({
      deploy_ref: body.deploy_ref,
      deploy_id: typeof body.deploy_id === 'string' ? body.deploy_id : undefined,
      service_id: typeof body.service_id === 'string' ? body.service_id : undefined,
      total_ticks: typeof body.total_ticks === 'number' ? body.total_ticks : undefined,
      mode: body.mode === 'shadow' || body.mode === 'enforce' ? body.mode : undefined,
      requested_at_ts: body.requested_at_ts,
      scenario: scenario as { baseline: Record<string, number> },
    });
    const rec = result.record;
    return {
      status: result.created ? 201 : 200,
      body: {
        session_id: rec.session_id,
        deploy_ref: rec.deploy_ref,
        status: rec.status,
        active_calibration_version: rec.active_calibration_version,
        config_source: result.config_source,
        mode: rec.mode,
        fail_policy: rec.fail_policy,
        total_ticks: rec.total_ticks,
        begun_at: rec.begun_at,
        ...(result.degraded ? { degraded: true } : {}),
      },
    };
  } catch (e) {
    if (e instanceof ActiveCalibrationError) return { status: 503, body: { error: e.message } };
    throw e;
  }
}

// ── POST /v1/sessions/{id}/ticks ───────────────────────────────────

export function handleTick(deps: HandlerDeps, sessionId: string, rawBody: string): HandlerResult {
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) return parsed.error;
  const body = parsed.value;

  if (typeof body.emitted_at_ts !== 'number') return badRequest('emitted_at_ts is required (unix seconds)');
  if (typeof body.metrics !== 'object' || body.metrics === null) return badRequest('metrics is required');

  const session = deps.store.getSession(sessionId);
  if (!session) return { status: 404, body: { error: `unknown session_id: ${sessionId}` } };

  // A replay of an already-durable tick is served regardless of current
  // session status (finishing/voiding after the original tick must not
  // turn a legitimate retry into a spurious 409).
  const isReplay = deps.store.hasTick(sessionId, body.emitted_at_ts as number);
  if (!isReplay && session.status !== 'active') {
    return { status: 409, body: { status: session.status, void_reason: session.void_reason } };
  }

  const result = deps.runtime.ingestTick(sessionId, {
    emitted_at_ts: body.emitted_at_ts as number,
    metrics: body.metrics as Record<string, number>,
    hour_of_day: typeof body.hour_of_day === 'number' ? body.hour_of_day : undefined,
    day_of_week: typeof body.day_of_week === 'number' ? body.day_of_week : undefined,
  });

  return {
    status: 200,
    body: {
      tick: result.tick,
      verdict: result.verdict,
      verdict_code: result.verdict_code,
      alpha_consumed: result.alpha_consumed,
      fires: result.fires,
      replayed: result.replayed,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.degraded ? { degraded: true } : {}),
    },
  };
}

// ── GET /v1/verdict/{deploy_ref} ───────────────────────────────────

export function handleGetVerdict(deps: HandlerDeps, deployRef: string): HandlerResult {
  const resp = deps.runtime.verdictFor(deployRef);
  if (!resp) return { status: 404, body: { error: `unknown deploy_ref: ${deployRef}` } };
  return { status: 200, body: resp };
}

// ── GET /v1/sessions/{id} ──────────────────────────────────────────

export function handleGetSession(deps: HandlerDeps, sessionId: string): HandlerResult {
  const rec = deps.store.getSession(sessionId);
  if (!rec) return { status: 404, body: { error: `unknown session_id: ${sessionId}` } };
  const verdictHistoryTail = deps.store.readVerdictHistory(sessionId).slice(-10);
  return { status: 200, body: { ...rec, verdict_history_tail: verdictHistoryTail } };
}

// ── POST /v1/sessions/{id}/finish ──────────────────────────────────

export function handleFinishSession(deps: HandlerDeps, sessionId: string, rawBody: string): HandlerResult {
  const rec = deps.store.getSession(sessionId);
  if (!rec) return { status: 404, body: { error: `unknown session_id: ${sessionId}` } };
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) return parsed.error;
  const reason = typeof parsed.value.reason === 'string' ? parsed.value.reason : undefined;
  const finished = deps.runtime.finish(sessionId, reason);
  return { status: 200, body: { status: finished.status, last_verdict: finished.last_verdict } };
}

// ── GET /healthz ────────────────────────────────────────────────────

export function handleHealthz(deps: HandlerDeps): HandlerResult {
  return { status: 200, body: { ok: true, service_id: deps.cfg.serviceId, mode: deps.cfg.mode, fail_policy: deps.cfg.failPolicy } };
}

// ── GET /readyz ─────────────────────────────────────────────────────

export function handleReadyz(deps: HandlerDeps): HandlerResult {
  let storeWritable = true;
  try {
    fs.accessSync(deps.cfg.storeDir, fs.constants.W_OK);
  } catch {
    storeWritable = false;
  }

  const auditStatus = deps.auditWriter.status
    ? deps.auditWriter.status()
    : { errors: 0, last_error: null, last_error_at: null, healthy: true };

  let configSource: 'lifecycle_store' | 'override' | 'legacy' = 'legacy';
  try {
    if (deps.cfg.compiledConfigOverride) {
      configSource = 'override';
    } else if (resolveActiveCalibration(deps.cfg.baselineHistoryDir, deps.cfg.serviceId)) {
      configSource = 'lifecycle_store';
    }
  } catch {
    // readyz reports best-effort config_source; a broken active.json
    // doesn't gate readiness itself (begin() surfaces it per fail policy).
  }

  const ok = storeWritable && auditStatus.healthy;
  return {
    status: ok ? 200 : 503,
    body: {
      ok, store_writable: storeWritable,
      audit_writer: { healthy: auditStatus.healthy, errors: auditStatus.errors },
      config_source: configSource,
      // R4 additive field — readiness itself never depends on the
      // maintenance scheduler (a stalled/erroring maintenance run is not
      // a reason to fail readiness: it never touches the served tick
      // path). See MaintenanceScheduler.getStatus().
      maintenance: deps.maintenance.getStatus(),
    },
  };
}
