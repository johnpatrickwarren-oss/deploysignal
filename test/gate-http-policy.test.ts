// test/gate-http-policy.test.ts — Task 7 (WS4 session-durability-argo
// plan): env-var config parsing (_gate-config.ts) + the begin-time
// active.json-resolution fail-policy branch documented in the plan's
// endpoint table for POST /v1/sessions: "503 active.json resolution
// threw under fail_closed (fail_open: 201 with config_source:'legacy',
// degraded:true)". `test/gate-http-server.test.ts` covers the http-server
// endpoint surface + the per-tick fail-policy/shadow/idempotency
// behavior; this file is the config + begin-time policy complement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadConfigFromEnv, GateConfigError } from '../service/gate-http/_gate-config';
import { createGateServer } from '../service/gate-http/server';
import type { GateServerHandle } from '../service/gate-http/server';
import type { GateHttpConfig } from '../service/gate-http/_gate-config';

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = Math.floor(Date.now() / 1000);

const BASELINE: Record<string, number> = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

// ────────────────────────────────────────────────────────────────────
// _gate-config.ts — env-var parsing.
// ────────────────────────────────────────────────────────────────────

test('loadConfigFromEnv: all-defaults when no DS_GATE_* vars set', () => {
  const cfg = loadConfigFromEnv({});
  assert.equal(cfg.port, 8790);
  assert.equal(cfg.bind, '127.0.0.1');
  assert.equal(cfg.sharedSecret, null);
  assert.equal(cfg.storeDir, 'runs/sessions');
  assert.equal(cfg.baselineHistoryDir, 'runs/baseline-history');
  assert.equal(cfg.serviceId, 'default');
  assert.equal(cfg.failPolicy, 'fail_closed');
  assert.equal(cfg.mode, 'enforce');
  assert.equal(cfg.totalTicksDefault, 60);
  assert.equal(cfg.sessionTtlSeconds, 3600);
  assert.equal(cfg.requestTimeoutMs, 4000);
  assert.equal(cfg.auditDir, path.join('runs/sessions', 'default', 'audit'));
  assert.equal(cfg.compiledConfigOverride, undefined);
});

test('loadConfigFromEnv: every var overridable; invalid enum values fall back to the default', () => {
  const cfg = loadConfigFromEnv({
    DS_GATE_PORT: '9999', DS_GATE_BIND: '0.0.0.0', DS_GATE_SHARED_SECRET: 'tok',
    DS_GATE_STORE_DIR: '/tmp/store', DS_GATE_BASELINE_HISTORY_DIR: '/tmp/baseline',
    DS_GATE_SERVICE_ID: 'svc-x', DS_GATE_FAIL_POLICY: 'fail_open', DS_GATE_MODE: 'shadow',
    DS_GATE_TOTAL_TICKS: '30', DS_GATE_SESSION_TTL_SECONDS: '120', DS_GATE_REQUEST_TIMEOUT_MS: '2000',
    DS_GATE_AUDIT_DIR: '/tmp/audit', DS_GATE_COMPILED_CONFIG: '/tmp/cc.json',
  });
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.bind, '0.0.0.0');
  assert.equal(cfg.sharedSecret, 'tok');
  assert.equal(cfg.storeDir, '/tmp/store');
  assert.equal(cfg.baselineHistoryDir, '/tmp/baseline');
  assert.equal(cfg.serviceId, 'svc-x');
  assert.equal(cfg.failPolicy, 'fail_open');
  assert.equal(cfg.mode, 'shadow');
  assert.equal(cfg.totalTicksDefault, 30);
  assert.equal(cfg.sessionTtlSeconds, 120);
  assert.equal(cfg.requestTimeoutMs, 2000);
  assert.equal(cfg.auditDir, '/tmp/audit');
  assert.equal(cfg.compiledConfigOverride, '/tmp/cc.json');

  const invalidEnum = loadConfigFromEnv({ DS_GATE_FAIL_POLICY: 'garbage', DS_GATE_MODE: 'garbage' });
  assert.equal(invalidEnum.failPolicy, 'fail_closed', 'invalid enum falls back to the conservative default');
  assert.equal(invalidEnum.mode, 'enforce');
});

// ────────────────────────────────────────────────────────────────────
// R4 maintenance scheduler config (DEFAULT OFF, opt-in per posture).
// ────────────────────────────────────────────────────────────────────

test('loadConfigFromEnv: maintenance scheduler defaults to fully disabled', () => {
  const cfg = loadConfigFromEnv({});
  assert.equal(cfg.maintenanceIntervalSeconds, 0);
  assert.equal(cfg.maintenanceAutoRefresh, false);
  assert.equal(cfg.maintenanceRefreshBundleDir, null);
  assert.equal(cfg.maintenanceRefreshWindow, null);
  assert.equal(cfg.maintenanceRecalibrateBin, null);
});

test('loadConfigFromEnv: maintenance scheduler vars overridable (check-only, auto-refresh off)', () => {
  const cfg = loadConfigFromEnv({
    DS_GATE_MAINTENANCE_INTERVAL_SECONDS: '3600',
    DS_GATE_RECALIBRATE_BIN: '/opt/ds/recalibrate.js',
  });
  assert.equal(cfg.maintenanceIntervalSeconds, 3600);
  assert.equal(cfg.maintenanceAutoRefresh, false);
  assert.equal(cfg.maintenanceRecalibrateBin, '/opt/ds/recalibrate.js');
});

test('loadConfigFromEnv: auto-refresh with bundle-dir + window set is accepted', () => {
  const cfg = loadConfigFromEnv({
    DS_GATE_MAINTENANCE_INTERVAL_SECONDS: '3600',
    DS_GATE_MAINTENANCE_AUTO_REFRESH: 'true',
    DS_GATE_REFRESH_BUNDLE_DIR: '/data/bundles',
    DS_GATE_REFRESH_WINDOW: 'trailing-30d',
  });
  assert.equal(cfg.maintenanceAutoRefresh, true);
  assert.equal(cfg.maintenanceRefreshBundleDir, '/data/bundles');
  assert.equal(cfg.maintenanceRefreshWindow, 'trailing-30d');
});

test('loadConfigFromEnv: auto-refresh without bundle-dir/window is a config error', () => {
  assert.throws(
    () => loadConfigFromEnv({ DS_GATE_MAINTENANCE_AUTO_REFRESH: 'true' }),
    GateConfigError,
  );
  assert.throws(
    () => loadConfigFromEnv({
      DS_GATE_MAINTENANCE_AUTO_REFRESH: 'true', DS_GATE_REFRESH_BUNDLE_DIR: '/data/bundles',
    }),
    GateConfigError,
    'bundle-dir alone (no window) is still an error',
  );
  assert.throws(
    () => loadConfigFromEnv({
      DS_GATE_MAINTENANCE_AUTO_REFRESH: 'true', DS_GATE_REFRESH_WINDOW: 'trailing-30d',
    }),
    GateConfigError,
    'window alone (no bundle-dir) is still an error',
  );
});

// ────────────────────────────────────────────────────────────────────
// begin-time active.json-resolution fail policy.
// ────────────────────────────────────────────────────────────────────

interface Started {
  handle: GateServerHandle;
  baseUrl: string;
  cfg: GateHttpConfig;
}

async function start(overrides: Partial<GateHttpConfig> = {}): Promise<Started> {
  const storeDir = tmpRoot('ds-gate-policy-store-');
  const baselineHistoryDir = tmpRoot('ds-gate-policy-baseline-');
  const serviceId = overrides.serviceId ?? 'svc-a';
  const cfg: GateHttpConfig = {
    port: 0, bind: '127.0.0.1', sharedSecret: null,
    storeDir, baselineHistoryDir, serviceId,
    failPolicy: 'fail_closed', mode: 'enforce',
    totalTicksDefault: 8, sessionTtlSeconds: 3600, requestTimeoutMs: 4000,
    auditDir: path.join(storeDir, serviceId, 'audit'),
    maintenanceIntervalSeconds: 0, maintenanceAutoRefresh: false,
    maintenanceRefreshBundleDir: null, maintenanceRefreshWindow: null, maintenanceRecalibrateBin: null,
    ...overrides,
  };
  const handle = createGateServer(cfg);
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const port = (handle.server.address() as AddressInfo).port;
  return { handle, baseUrl: `http://127.0.0.1:${port}`, cfg };
}

async function stop(s: Started): Promise<void> {
  await s.handle.close();
}

function writeBrokenActiveJson(baselineHistoryDir: string, serviceId: string): void {
  const dir = path.join(baselineHistoryDir, serviceId);
  fs.mkdirSync(dir, { recursive: true });
  // Unknown schema_version -> resolveActiveCalibration throws ActiveCalibrationError.
  fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ schema_version: '99' }));
}

interface JsonResp { status: number; json: any }

function postJson(baseUrl: string, urlPath: string, body: unknown): Promise<JsonResp> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request(baseUrl + urlPath, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

test('POST /v1/sessions -> 503 when active.json resolution throws under fail_closed', async () => {
  const s = await start({ failPolicy: 'fail_closed' });
  try {
    writeBrokenActiveJson(s.cfg.baselineHistoryDir, s.cfg.serviceId);
    const r = await postJson(s.baseUrl, '/v1/sessions', {
      deploy_ref: 'deploy-ref-1', requested_at_ts: NOW, scenario: { baseline: BASELINE },
    });
    assert.equal(r.status, 503);
    assert.ok(r.json.error);
  } finally { await stop(s); }
});

test('POST /v1/sessions -> 201 degraded:true config_source:legacy when active.json resolution throws under fail_open', async () => {
  const s = await start({ failPolicy: 'fail_open' });
  try {
    writeBrokenActiveJson(s.cfg.baselineHistoryDir, s.cfg.serviceId);
    const r = await postJson(s.baseUrl, '/v1/sessions', {
      deploy_ref: 'deploy-ref-1', requested_at_ts: NOW, scenario: { baseline: BASELINE },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.config_source, 'legacy');
    assert.equal(r.json.degraded, true);
    assert.equal(r.json.status, 'active', 'the session is still usable, just degraded');
  } finally { await stop(s); }
});

test('DS_GATE_COMPILED_CONFIG override bypasses active.json resolution -> config_source:override', async () => {
  const compiledConfigOverride = path.join(process.cwd(), 'runs', 'compiled-configs', 'v4-fusion-novelty.json');
  assert.ok(fs.existsSync(compiledConfigOverride), 'fixture compiled config must exist');
  const s = await start({ compiledConfigOverride });
  try {
    const r = await postJson(s.baseUrl, '/v1/sessions', {
      deploy_ref: 'deploy-ref-1', requested_at_ts: NOW, scenario: { baseline: BASELINE },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.config_source, 'override');
    assert.equal(r.json.active_calibration_version, 'override');
  } finally { await stop(s); }
});
