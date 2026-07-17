// service/gate-http/_gate-config.ts — Task 7 (WS4 session-durability-argo
// plan): env-var configuration for the gate HTTP verdict service.
// Every var is optional (claude-proxy.js convention) with a conservative
// default — "never silently defaults to permissive" (ORCHESTRATION-
// ADAPTERS.md doctrine) is why DS_GATE_FAIL_POLICY defaults to
// fail_closed, not fail_open.

import * as path from 'path';

export type GateMode = 'enforce' | 'shadow';
export type GateFailPolicy = 'fail_open' | 'fail_closed';

export interface GateHttpConfig {
  port: number;
  bind: string;
  sharedSecret: string | null;
  storeDir: string;
  baselineHistoryDir: string;
  serviceId: string;
  failPolicy: GateFailPolicy;
  mode: GateMode;
  totalTicksDefault: number;
  sessionTtlSeconds: number;
  requestTimeoutMs: number;
  auditDir: string;
  compiledConfigOverride?: string;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], fallback: T): T {
  const raw = env[key];
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GateHttpConfig {
  const storeDir = env.DS_GATE_STORE_DIR || 'runs/sessions';
  const serviceId = env.DS_GATE_SERVICE_ID || 'default';
  return {
    port: intFromEnv(env, 'DS_GATE_PORT', 8790), // claude-proxy.js owns 8787
    bind: env.DS_GATE_BIND || '127.0.0.1',
    sharedSecret: env.DS_GATE_SHARED_SECRET || null,
    storeDir,
    baselineHistoryDir: env.DS_GATE_BASELINE_HISTORY_DIR || 'runs/baseline-history',
    serviceId,
    failPolicy: oneOf(env, 'DS_GATE_FAIL_POLICY', ['fail_open', 'fail_closed'] as const, 'fail_closed'),
    mode: oneOf(env, 'DS_GATE_MODE', ['enforce', 'shadow'] as const, 'enforce'),
    totalTicksDefault: intFromEnv(env, 'DS_GATE_TOTAL_TICKS', 60), // matches AnalysisTemplate count: 60
    sessionTtlSeconds: intFromEnv(env, 'DS_GATE_SESSION_TTL_SECONDS', 3600),
    requestTimeoutMs: intFromEnv(env, 'DS_GATE_REQUEST_TIMEOUT_MS', 4000), // under Argo's timeoutSeconds: 5
    auditDir: env.DS_GATE_AUDIT_DIR || path.join(storeDir, serviceId, 'audit'),
    compiledConfigOverride: env.DS_GATE_COMPILED_CONFIG || undefined,
  };
}
