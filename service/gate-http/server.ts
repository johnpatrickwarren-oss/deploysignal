// service/gate-http/server.ts — Task 7 (WS4 session-durability-argo
// plan): the gate HTTP verdict service. Facade — auto-runs
// (`require.main === module`, per tools/calibrate.ts's auto-run
// precedent) when invoked directly, exports `createGateServer` for
// tests (Task 7's own http tests, and Task 9's in-process e2e).
//
// SECURITY BOUNDARY: localhost bind (DS_GATE_BIND defaults to
// 127.0.0.1) + an optional shared secret (DS_GATE_SHARED_SECRET,
// constant-time-compared `x-ds-gate-token` header) — nothing more. This
// is explicitly NOT auth/SSO/RBAC infrastructure (enterprise-
// infrastructure anti-scope); deployers front it with their own ingress
// auth (mTLS, an API gateway, a service mesh policy) before exposing it
// beyond localhost or a private network. See service/gate-http/README.md
// (Task 8) for the full adapter write-up.
//
// SINGLE-WRITER: see service/session/session-store.ts's header for the
// index.json read-modify-write assumption. Run exactly one
// GateSessionRuntime (hence one server.ts process) per storeDir — the
// runtime constructor's pid lockfile (`<storeDir>/.gate-runtime.lock`)
// turns a second live instance into a loud startup error (
// GateRuntimeLockError) instead of a silent index race.

import * as http from 'http';
import * as path from 'path';

import type { AuditWriter } from '../../engine/types';
import { loadConfigFromEnv } from './_gate-config';
import type { GateHttpConfig } from './_gate-config';
import { GateSessionRuntime } from './_gate-session-runtime';
import type { GateRuntimeConfig } from './_gate-session-runtime';
import { SessionStore } from '../session/session-store';
import { JsonlLifecycleEventEmitter } from '../session/jsonl-lifecycle-emitter';
import { handleRequest } from './_gate-router';
import type { HandlerDeps } from './_gate-handlers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createAuditWriter } = require('../../dist/engine/_audit-writer');

export interface GateServerHandle {
  server: http.Server;
  runtime: GateSessionRuntime;
  store: SessionStore;
  auditWriter: AuditWriter;
  close(): Promise<void>;
}

export function createGateServer(cfg: GateHttpConfig): GateServerHandle {
  const store = SessionStore.init(cfg.storeDir, cfg.serviceId);
  const emitter = new JsonlLifecycleEventEmitter(path.join(cfg.storeDir, cfg.serviceId, 'events.jsonl'));
  const auditWriter = createAuditWriter({ dir: cfg.auditDir, service: cfg.serviceId });

  const runtimeCfg: GateRuntimeConfig = {
    storeDir: cfg.storeDir,
    baselineHistoryDir: cfg.baselineHistoryDir,
    serviceId: cfg.serviceId,
    mode: cfg.mode,
    failPolicy: cfg.failPolicy,
    totalTicksDefault: cfg.totalTicksDefault,
    sessionTtlSeconds: cfg.sessionTtlSeconds,
    compiledConfigOverride: cfg.compiledConfigOverride,
  };
  const runtime = new GateSessionRuntime(runtimeCfg, store, emitter, auditWriter);
  runtime.sweepOnBoot(); // OQ-1 declare-void-and-restart

  const deps: HandlerDeps = {
    runtime, store, cfg, auditWriter,
  };
  const server = http.createServer((req, res) => handleRequest(deps, req, res));
  server.requestTimeout = cfg.requestTimeoutMs;

  return {
    server,
    runtime,
    store,
    auditWriter,
    close: () => new Promise((resolve, reject) => {
      runtime.close();
      auditWriter.close();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

if (require.main === module) {
  const cfg = loadConfigFromEnv();
  const handle = createGateServer(cfg);
  handle.server.listen(cfg.port, cfg.bind, () => {
    // eslint-disable-next-line no-console
    console.error(`deploysignal gate-http listening on http://${cfg.bind}:${cfg.port}`);
    // eslint-disable-next-line no-console
    console.error(`  service_id=${cfg.serviceId} mode=${cfg.mode} fail_policy=${cfg.failPolicy}`);
  });
  const shutdown = () => {
    handle.close().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
