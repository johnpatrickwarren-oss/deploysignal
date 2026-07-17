// service/gate-http/_gate-router.ts — Task 7 (WS4 session-durability-argo
// plan): method+path dispatch table. Every `/v1/*` request: (1) optional
// shared-secret check (`/healthz`, `/readyz` exempt), (2) lazy TTL sweep
// (Addition #15 D1 pattern — no background timer), (3) handler dispatch.
// Unknown routes -> 404. Body-too-large -> 413. Uncaught
// GateSessionNotFoundError -> 404 (defense in depth; handlers already
// check store.getSession() first, so this path is a backstop).

import type * as http from 'http';

import { readBody, sendJson, timingSafeEqualStr, BodyTooLargeError } from './_gate-http-util';
import { GateSessionNotFoundError } from './_gate-session-runtime';
import {
  handleBeginSession, handleTick, handleGetVerdict, handleGetSession,
  handleFinishSession, handleHealthz, handleReadyz,
} from './_gate-handlers';
import type { HandlerDeps, HandlerResult } from './_gate-handlers';

function dispatch(deps: HandlerDeps, method: string, pathname: string, rawBody: string): HandlerResult | null {
  if (method === 'GET' && pathname === '/healthz') return handleHealthz(deps);
  if (method === 'GET' && pathname === '/readyz') return handleReadyz(deps);
  if (method === 'POST' && pathname === '/v1/sessions') return handleBeginSession(deps, rawBody);

  let m = pathname.match(/^\/v1\/sessions\/([^/]+)\/ticks$/);
  if (method === 'POST' && m) return handleTick(deps, decodeURIComponent(m[1]), rawBody);

  m = pathname.match(/^\/v1\/sessions\/([^/]+)\/finish$/);
  if (method === 'POST' && m) return handleFinishSession(deps, decodeURIComponent(m[1]), rawBody);

  m = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
  if (method === 'GET' && m) return handleGetSession(deps, decodeURIComponent(m[1]));

  m = pathname.match(/^\/v1\/verdict\/([^/]+)$/);
  if (method === 'GET' && m) return handleGetVerdict(deps, decodeURIComponent(m[1]));

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
