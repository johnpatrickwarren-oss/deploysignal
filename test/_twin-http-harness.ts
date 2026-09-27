// test/_twin-http-harness.ts — a gate server on an ephemeral port and a JSON request helper, for
// the Plan B twin-mode tests (test/twin-gate-http.test.ts, test/twin-authority.test.ts). Mirrors
// the helpers in test/gate-http-server.test.ts.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createGateServer } from '../service/gate-http/server';
import type { GateServerHandle } from '../service/gate-http/server';
import type { GateHttpConfig } from '../service/gate-http/_gate-config';
import { TWIN_PROFILE } from './_twin-fixture';

export interface Started { handle: GateServerHandle; baseUrl: string; cfg: GateHttpConfig }
export interface Resp { status: number; json: any; raw: string }

export function gateConfig(overrides: Partial<GateHttpConfig> = {}): GateHttpConfig {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-twin-store-'));
  const baselineHistoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-twin-baseline-'));
  const serviceId = overrides.serviceId ?? 'svc-twin';
  return {
    port: 0, bind: '127.0.0.1', sharedSecret: null,
    storeDir, baselineHistoryDir, serviceId,
    failPolicy: 'fail_closed', mode: 'enforce',
    totalTicksDefault: 8, sessionTtlSeconds: 3600, requestTimeoutMs: 4000,
    auditDir: path.join(storeDir, serviceId, 'audit'),
    maintenanceIntervalSeconds: 0, maintenanceAutoRefresh: false,
    maintenanceRefreshBundleDir: null, maintenanceRefreshWindow: null, maintenanceRecalibrateBin: null,
    ...overrides,
  };
}

export async function start(cfg: GateHttpConfig = gateConfig()): Promise<Started> {
  const handle = createGateServer(cfg);
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const port = (handle.server.address() as AddressInfo).port;
  return { handle, baseUrl: `http://127.0.0.1:${port}`, cfg };
}

export async function stop(s: Started): Promise<void> {
  await s.handle.close();
}

export function req(baseUrl: string, method: string, urlPath: string, body?: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const r = http.request(baseUrl + urlPath, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode!, json, raw });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

/** The contract's session-create body: mode twin, the twin_arm block, nothing else. */
export function twinBody(arm: Record<string, unknown> = TWIN_PROFILE as unknown as Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: 'twin', twin_arm: arm, ...extra };
}
