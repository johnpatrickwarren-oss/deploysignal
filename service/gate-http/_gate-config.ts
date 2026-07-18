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
  // R4 in-service maintenance scheduler (service/gate-http/_gate-maintenance.ts).
  // DEFAULT OFF (opt-in per posture): intervalSeconds unset/0 disables the
  // scheduler entirely — no timer is ever created. See README.md's
  // "maintenance scheduler" section for the full write-split rationale.
  maintenanceIntervalSeconds: number;
  maintenanceAutoRefresh: boolean;
  maintenanceRefreshBundleDir: string | null;
  maintenanceRefreshWindow: string | null;
  /** DS_GATE_RECALIBRATE_BIN escape hatch — overrides the repo-relative
   *  default resolution of the recalibrate CLI entry point (see
   *  _gate-maintenance.ts's resolveRecalibrateBin). */
  maintenanceRecalibrateBin: string | null;
}

/** Thrown by loadConfigFromEnv when the env combination is
 *  self-contradictory in a way no fallback can safely resolve — thrown at
 *  startup (server.ts's require.main branch), never silently coerced.
 *  Today's only case: DS_GATE_MAINTENANCE_AUTO_REFRESH=true without both
 *  DS_GATE_REFRESH_BUNDLE_DIR and DS_GATE_REFRESH_WINDOW set — auto-acting
 *  on a calendar-due refresh with no bundle to refresh FROM is not a
 *  posture this service will silently degrade out of. */
export class GateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateConfigError';
  }
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

  const maintenanceIntervalSeconds = intFromEnv(env, 'DS_GATE_MAINTENANCE_INTERVAL_SECONDS', 0);
  const maintenanceAutoRefresh = env.DS_GATE_MAINTENANCE_AUTO_REFRESH === 'true';
  const maintenanceRefreshBundleDir = env.DS_GATE_REFRESH_BUNDLE_DIR || null;
  const maintenanceRefreshWindow = env.DS_GATE_REFRESH_WINDOW || null;

  // Validate at startup, not lazily at the first scheduled tick: auto-
  // refresh with no bundle to refresh from is a config error, not a
  // runtime condition to degrade around (README.md "maintenance
  // scheduler" section).
  if (maintenanceAutoRefresh && (!maintenanceRefreshBundleDir || !maintenanceRefreshWindow)) {
    throw new GateConfigError(
      'DS_GATE_MAINTENANCE_AUTO_REFRESH=true requires both DS_GATE_REFRESH_BUNDLE_DIR and '
      + 'DS_GATE_REFRESH_WINDOW to be set (auto-refresh has nothing to refresh from otherwise)',
    );
  }

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
    maintenanceIntervalSeconds,
    maintenanceAutoRefresh,
    maintenanceRefreshBundleDir,
    maintenanceRefreshWindow,
    maintenanceRecalibrateBin: env.DS_GATE_RECALIBRATE_BIN || null,
  };
}
