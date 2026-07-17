// service/gate-http/_gate-router.ts — Task 7 (WS4 session-durability-argo
// plan): method+path dispatch table. Every `/v1/*` request: (1) optional
// shared-secret check (`/healthz`, `/readyz` exempt), (2) lazy TTL sweep
// (Addition #15 D1 pattern — no background timer), (3) handler dispatch.
// Unknown routes -> 404. Body-too-large -> 413. Uncaught
// GateSessionNotFoundError -> 404 (defense in depth; handlers already
// check store.getSession() first, so this path is a backstop).

import type * as http from 'http';

import {
  readBody, sendJson, timingSafeEqualStr, BodyTooLargeError, isSafeIdentifier,
} from './_gate-http-util';
import { GateSessionNotFoundError } from './_gate-session-runtime';
import {
  handleBeginSession, handleTick, handleGetVerdict, handleGetSession,
  handleFinishSession, handleHealthz, handleReadyz,
} from './_gate-handlers';
import type { HandlerDeps, HandlerResult } from './_gate-handlers';

/** m4 fix (final-review): decodes a `[^/]+` path-segment match and
 *  validates it against the safe-identifier charset. A caller-controlled
 *  segment reaches SessionStore filenames (session_id directly;
 *  deploy_ref via the `sess-${deploy_ref}-${ts}` convention) — an
 *  encoded slash (`%2F`) or a `..` segment must be rejected as a 400
 *  before it ever reaches a handler, not after. Returns the decoded
 *  value, or a ready-to-return 400 HandlerResult. */
function decodeAndValidateSegment(raw: string, field: string): { ok: true; value: string } | { ok: false; result: HandlerResult } {
  const decoded = decodeURIComponent(raw);
  if (!isSafeIdentifier(decoded)) {
    return { ok: false, result: { status: 400, body: { error: `invalid ${field}: allowed characters are A-Za-z0-9._-` } } };
  }
  return { ok: true, value: decoded };
}

function dispatch(deps: HandlerDeps, method: string, pathname: string, rawBody: string): HandlerResult | null {
  if (method === 'GET' && pathname === '/healthz') return handleHealthz(deps);
  if (method === 'GET' && pathname === '/readyz') return handleReadyz(deps);
  if (method === 'POST' && pathname === '/v1/sessions') return handleBeginSession(deps, rawBody);

  let m = pathname.match(/^\/v1\/sessions\/([^/]+)\/ticks$/);
  if (method === 'POST' && m) {
    const id = decodeAndValidateSegment(m[1], 'session_id');
    return id.ok ? handleTick(deps, id.value, rawBody) : id.result;
  }

  m = pathname.match(/^\/v1\/sessions\/([^/]+)\/finish$/);
  if (method === 'POST' && m) {
    const id = decodeAndValidateSegment(m[1], 'session_id');
    return id.ok ? handleFinishSession(deps, id.value, rawBody) : id.result;
  }

  m = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
  if (method === 'GET' && m) {
    const id = decodeAndValidateSegment(m[1], 'session_id');
    return id.ok ? handleGetSession(deps, id.value) : id.result;
  }

  m = pathname.match(/^\/v1\/verdict\/([^/]+)$/);
  if (method === 'GET' && m) {
    const ref = decodeAndValidateSegment(m[1], 'deploy_ref');
    return ref.ok ? handleGetVerdict(deps, ref.value) : ref.result;
  }

  return null;
}

export function handleRequest(deps: HandlerDeps, req: http.IncomingMessage, res: http.ServerResponse): void {
  const method = req.method || 'GET';
  const pathname = (req.url || '/').split('?')[0];

  readBody(req).then((rawBody) => {
    if (pathname.startsWith('/v1/') && deps.cfg.sharedSecret) {
      const token = req.headers['x-ds-gate-token'];
      if (typeof token !== 'string' || !timingSafeEqualStr(token, deps.cfg.sharedSecret)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
    }
    if (pathname.startsWith('/v1/')) {
      deps.runtime.sweepExpired(Date.now() / 1000);
    }

    try {
      const result = dispatch(deps, method, pathname, rawBody);
      if (!result) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, result.status, result.body);
    } catch (e) {
      if (e instanceof GateSessionNotFoundError) {
        sendJson(res, 404, { error: e.message });
        return;
      }
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }).catch((e) => {
    if (e instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: e.message });
      return;
    }
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  });
}
