// test/gate-e2e-argo-loop.test.ts — Task 9 (WS4 session-durability-argo
// plan): end-to-end drill of the full Argo Level-1 loop, in-process (no
// child processes — the gate is just an http.Server object in this test
// process, started on port 0 and driven with real http.request() calls,
// same pattern as test/gate-http-server.test.ts).
//
// Three sessions against one gate-http server (plus a fourth after a
// simulated restart):
//   A. ~10 clean ticks -> proceed (poll GET /v1/verdict: -1 while
//      baking, 0 once proceed).
//   B. a regression stream -> rollback (poll GET /v1/verdict: 1);
//      SessionRecord shows rolled_back + finished; verdicts.jsonl
//      complete; events.jsonl carries triggered/tick/finished; the
//      audit dir has JSONL; readyz stays healthy throughout.
//   C. begun, ticked once (still active/baking) when the server is
//      closed and a NEW one is opened over the SAME storeDir/
//      baselineHistoryDir (the "kill runtime object, re-instantiate"
//      restart drill): C is void afterward (declare-void-and-restart,
//      OQ-1), a further tick for C is rejected (409), and a fresh
//      deploy_ref (D) works normally on the new server.
//
// Session begin pins the WS3 Addition #15 `active.json` -> `v1-legacy-
// equivalent.json` compiled config (verified separately in node to
// behave identically to the legacy/no-config path against this file's
// BASELINE fixture: clean bake through tick 3, rollback from tick 4 once
// degraded) — proving the pinning wire-up end-to-end, not just the
// resolver in isolation (Task 5 already covers the resolver itself).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

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

function degradedMetrics(): Record<string, number> {
  return {
    ...BASELINE,
    p99_latency: BASELINE.p99_latency * 2.5,
    ttft: BASELINE.ttft * 2.2,
    downstream_err: BASELINE.downstream_err * 6,
  };
}

const ROOT = path.resolve(__dirname, '..');
const V1_COMPILED_CONFIG = path.join(ROOT, 'runs', 'compiled-configs', 'v1-legacy-equivalent.json');

function writeActiveJson(baselineHistoryDir: string, serviceId: string): void {
  const dir = path.join(baselineHistoryDir, serviceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({
    schema_version: '1',
    version_id: 'v1',
    compiled_config_path: V1_COMPILED_CONFIG,
    baseline_ref: 'e2e-fixture@v1',
    promoted_at: new Date().toISOString(),
    predecessor_version_id: null,
    promotion_history: [],
  }));
}

interface JsonResp { status: number; json: any }

function req(baseUrl: string, method: string, urlPath: string, body?: unknown): Promise<JsonResp> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
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
        resolve({ status: res.statusCode!, json: raw ? JSON.parse(raw) : undefined });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

async function listen(handle: GateServerHandle): Promise<string> {
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const port = (handle.server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

test('e2e: full Argo loop — clean proceed, regression rollback, restart drill', async () => {
  const storeDir = tmpRoot('ds-gate-e2e-store-');
  const baselineHistoryDir = tmpRoot('ds-gate-e2e-baseline-');
  const serviceId = 'svc-e2e';
  writeActiveJson(baselineHistoryDir, serviceId);

  const cfg: GateHttpConfig = {
    port: 0, bind: '127.0.0.1', sharedSecret: null,
    storeDir, baselineHistoryDir, serviceId,
    failPolicy: 'fail_closed', mode: 'enforce',
    totalTicksDefault: 10, sessionTtlSeconds: 3600, requestTimeoutMs: 4000,
    auditDir: path.join(storeDir, serviceId, 'audit'),
    maintenanceIntervalSeconds: 0, maintenanceAutoRefresh: false,
    maintenanceRefreshBundleDir: null, maintenanceRefreshWindow: null, maintenanceRecalibrateBin: null,
  };

  let handle1: GateServerHandle | undefined;
  try {
    handle1 = createGateServer(cfg);
    const baseUrl1 = await listen(handle1);

    // ── Session A: ~10 clean ticks -> proceed. ─────────────────────
    const beginA = await req(baseUrl1, 'POST', '/v1/sessions', {
      deploy_ref: 'deploy-e2e-clean', requested_at_ts: NOW, scenario: { baseline: BASELINE },
    });
    assert.equal(beginA.status, 201);
    assert.equal(beginA.json.config_source, 'lifecycle_store', 'active.json pinning resolved');
    assert.equal(beginA.json.active_calibration_version, 'v1');
    const sessionA = beginA.json.session_id;

    for (let i = 0; i < 10; i++) {
      const tick = await req(baseUrl1, 'POST', `/v1/sessions/${sessionA}/ticks`, {
        emitted_at_ts: NOW + i * 30, metrics: BASELINE,
      });
      assert.equal(tick.status, 200);

      const verdict = await req(baseUrl1, 'GET', '/v1/verdict/deploy-e2e-clean');
      assert.equal(verdict.status, 200);
      if (i < 9) {
        assert.equal(verdict.json.verdict_code, -1, `tick ${i}: baking -> -1`);
      } else {
        assert.equal(verdict.json.verdict_code, 0, 'final tick: proceed -> 0');
      }
    }
    const recA = (await req(baseUrl1, 'GET', `/v1/sessions/${sessionA}`)).json;
    assert.equal(recA.status, 'finished');
    assert.equal(recA.deployment.phase, 'baking', 'proceed does not force a phase transition');

    // ── Session B: a regression stream -> rollback. ────────────────
    const beginB = await req(baseUrl1, 'POST', '/v1/sessions', {
      deploy_ref: 'deploy-e2e-regression', requested_at_ts: NOW, scenario: { baseline: BASELINE },
    });
    assert.equal(beginB.status, 201);
    const sessionB = beginB.json.session_id;

    let lastVerdictCode = -1;
    for (let i = 0; i < 8 && lastVerdictCode !== 1; i++) {
      const metrics = i >= 4 ? degradedMetrics() : BASELINE;
      const tick = await req(baseUrl1, 'POST', `/v1/sessions/${sessionB}/ticks`, {
        emitted_at_ts: NOW + i * 30, metrics,
      });
      assert.equal(tick.status, 200);
      const verdict = await req(baseUrl1, 'GET', '/v1/verdict/deploy-e2e-regression');
      lastVerdictCode = verdict.json.verdict_code;
    }
    assert.equal(lastVerdictCode, 1, 'regression stream eventually rolls back');

    const recB = (await req(baseUrl1, 'GET', `/v1/sessions/${sessionB}`)).json;
    assert.equal(recB.status, 'finished');
    assert.equal(recB.deployment.phase, 'rolled_back');
    assert.ok(recB.verdict_history_tail.length > 0);

    const verdictsPath = path.join(storeDir, serviceId, 'sessions', `${sessionB}.verdicts.jsonl`);
    const verdictLines = fs.readFileSync(verdictsPath, 'utf8').trim().split('\n');
    assert.ok(verdictLines.length >= 5, 'verdicts.jsonl is complete for session B');
    const lastEntry = JSON.parse(verdictLines[verdictLines.length - 1]);
    assert.equal(lastEntry.verdict, 'rollback');

    const eventsPath = path.join(storeDir, serviceId, 'events.jsonl');
    const eventTypes = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
    assert.ok(eventTypes.includes('evaluation.triggered'));
    assert.ok(eventTypes.includes('evaluation.tick'));
    assert.ok(eventTypes.includes('evaluation.finished'));

    handle1.auditWriter.close?.(); // force-flush the buffered audit writer before inspecting disk
    const auditServiceDir = path.join(cfg.auditDir, serviceId);
    const auditFiles = fs.readdirSync(auditServiceDir).filter((f) => f.endsWith('.jsonl'));
    assert.ok(auditFiles.length > 0, 'audit dir has at least one JSONL file');
    const auditContent = fs.readFileSync(path.join(auditServiceDir, auditFiles[0]), 'utf8').trim();
    assert.ok(auditContent.length > 0);

    const readyBeforeRestart = await req(baseUrl1, 'GET', '/readyz');
    assert.equal(readyBeforeRestart.status, 200);
    assert.equal(readyBeforeRestart.json.ok, true);

    // ── Session C: begun + ticked once, then the server "dies". ────
    const beginC = await req(baseUrl1, 'POST', '/v1/sessions', {
      deploy_ref: 'deploy-e2e-restart', requested_at_ts: NOW, scenario: { baseline: BASELINE },
    });
    const sessionC = beginC.json.session_id;
    await req(baseUrl1, 'POST', `/v1/sessions/${sessionC}/ticks`, { emitted_at_ts: NOW, metrics: BASELINE });
    const recCBeforeRestart = (await req(baseUrl1, 'GET', `/v1/sessions/${sessionC}`)).json;
    assert.equal(recCBeforeRestart.status, 'active');

    await handle1.close(); // "kill runtime object" — releases the store-root lock
    handle1 = undefined;

    // ── Re-instantiate over the same store — the restart drill. ────
    const handle2 = createGateServer(cfg); // sweepOnBoot() runs automatically
    try {
      const baseUrl2 = await listen(handle2);

      const recCAfterRestart = await req(baseUrl2, 'GET', `/v1/sessions/${sessionC}`);
      assert.equal(recCAfterRestart.json.status, 'void');
      assert.equal(recCAfterRestart.json.void_reason, 'service_restart');

      const stragglerTick = await req(baseUrl2, 'POST', `/v1/sessions/${sessionC}/ticks`, {
        emitted_at_ts: NOW + 60, metrics: BASELINE,
      });
      assert.equal(stragglerTick.status, 409, 'a further tick for the voided session is rejected');

      const beginD = await req(baseUrl2, 'POST', '/v1/sessions', {
        deploy_ref: 'deploy-e2e-post-restart', requested_at_ts: NOW + 60, scenario: { baseline: BASELINE },
      });
      assert.equal(beginD.status, 201);
      const sessionD = beginD.json.session_id;
      const tickD = await req(baseUrl2, 'POST', `/v1/sessions/${sessionD}/ticks`, {
        emitted_at_ts: NOW + 60, metrics: BASELINE,
      });
      assert.equal(tickD.status, 200);
      assert.equal(tickD.json.replayed, false);

      const readyAfterRestart = await req(baseUrl2, 'GET', '/readyz');
      assert.equal(readyAfterRestart.status, 200);
    } finally {
      await handle2.close();
    }
  } finally {
    if (handle1) await handle1.close();
  }
});
