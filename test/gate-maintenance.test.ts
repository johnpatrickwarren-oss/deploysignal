// test/gate-maintenance.test.ts — R4 in-service maintenance scheduler.
// MaintenanceScheduler (service/gate-http/_gate-maintenance.ts) converts
// the recalibrate CLI's lazy `check` due-detection into action: an
// interval job, hosted by this same gate-http service, that spawns the
// recalibrate CLI as a child process. The CLI remains the sole writer of
// the recalibration store (write-split doctrine, README.md) — this
// module only ever reads a spawned child's exit code/stdout/stderr.
//
// Most tests inject a stub `ExecFileFn` (setExecFileFnForTest, mirroring
// _gate-session-runtime.ts's setEvaluateFnForTest seam) so exit codes are
// deterministic without an actual subprocess. Exactly ONE test
// (`real spawn` section, below) exercises the real
// child_process.execFile path against a real, initialized recalibration
// store and the actually-compiled tools/recalibrate.js — kept fast
// (check-only, no refresh, no shadow-compile).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MaintenanceScheduler,
} from '../service/gate-http/_gate-maintenance';
import type {
  MaintenanceSchedulerConfig, ExecResult, MaintenanceRunSummary,
} from '../service/gate-http/_gate-maintenance';
import { createGateServer } from '../service/gate-http/server';
import type { GateHttpConfig } from '../service/gate-http/_gate-config';
import { RecalibrationStore } from '../tools/recalibrate/_recalibrate-store';

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseCfg(overrides: Partial<MaintenanceSchedulerConfig> = {}): MaintenanceSchedulerConfig {
  return {
    intervalSeconds: 0,
    autoRefresh: false,
    refreshBundleDir: null,
    refreshWindow: null,
    recalibrateBin: '/fake/recalibrate.js',
    serviceId: 'svc-a',
    baselineHistoryDir: tmpRoot('ds-gate-maint-baseline-'),
    storeDir: tmpRoot('ds-gate-maint-store-'),
    ...overrides,
  };
}

function stubResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    code: 0, stdout: 'calendar safety net: not due', stderr: '', timedOut: false, ...overrides,
  };
}

interface RecordedCall { bin: string; args: string[]; }

function recordingStub(
  outcomes: ExecResult[],
): { fn: (bin: string, args: string[]) => Promise<ExecResult>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fn = async (bin: string, args: string[]): Promise<ExecResult> => {
    calls.push({ bin, args });
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    return outcome;
  };
  return { fn, calls };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

// ── disabled by default ─────────────────────────────────────────────

test('scheduler: disabled (intervalSeconds 0) -> start() never spawns anything, even after the timer would have fired', async () => {
  const cfg = baseCfg({ intervalSeconds: 0 });
  const scheduler = new MaintenanceScheduler(cfg);
  const { fn, calls } = recordingStub([stubResult()]);
  scheduler.setExecFileFnForTest(fn);
  assert.equal(scheduler.isEnabled(), false);

  scheduler.start();
  // No mock timers needed: with intervalSeconds 0, start() must not even
  // register a timer — nothing to advance. runOnce() is still a valid
  // direct call (used by the interval when enabled); disabledness is
  // about start(), not runOnce() itself.
  await flush();
  assert.equal(calls.length, 0, 'start() on a disabled scheduler must never spawn a child');
  scheduler.stop();
});

// ── interval wiring ──────────────────────────────────────────────────

test('scheduler: interval fires -> check spawned with correct args', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const baselineHistoryDir = tmpRoot('ds-gate-maint-baseline-');
  const cfg = baseCfg({ intervalSeconds: 30, baselineHistoryDir, serviceId: 'svc-interval' });
  const scheduler = new MaintenanceScheduler(cfg);
  const { fn, calls } = recordingStub([stubResult()]);
  scheduler.setExecFileFnForTest(fn);

  scheduler.start();
  t.mock.timers.tick(30_000);
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/fake/recalibrate.js');
  assert.deepEqual(calls[0].args, ['check', '--service', 'svc-interval', '--root', baselineHistoryDir]);
  scheduler.stop();
});

test('scheduler: default resolveRecalibrateBin (no override) points at the repo-relative compiled tools/recalibrate.js', async () => {
  const cfg = baseCfg({ recalibrateBin: null });
  const scheduler = new MaintenanceScheduler(cfg);
  const { fn, calls } = recordingStub([stubResult()]);
  scheduler.setExecFileFnForTest(fn);

  await scheduler.runOnce();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].bin.endsWith(path.join('tools', 'recalibrate.js')), calls[0].bin);
  assert.ok(path.isAbsolute(calls[0].bin));
});

// ── exit-3 (calendar due) + auto-refresh ─────────────────────────────

test('scheduler: exit 3 (calendar due) + auto-refresh enabled -> refresh spawned with calendar_safety_net', async () => {
  const baselineHistoryDir = tmpRoot('ds-gate-maint-baseline-');
  const cfg = baseCfg({
    autoRefresh: true,
    refreshBundleDir: '/data/bundles',
    refreshWindow: 'trailing-30d',
    baselineHistoryDir,
    serviceId: 'svc-due',
  });
  const scheduler = new MaintenanceScheduler(cfg);
  const { fn, calls } = recordingStub([
    stubResult({ code: 3, stdout: 'calendar safety net: DUE' }),
    stubResult({ code: 0, stdout: 'candidate proposed' }),
  ]);
  scheduler.setExecFileFnForTest(fn);

  const summary = await scheduler.runOnce() as MaintenanceRunSummary;
  assert.equal(calls.length, 2, 'both check and refresh spawned');
  assert.deepEqual(calls[0].args, ['check', '--service', 'svc-due', '--root', baselineHistoryDir]);
  assert.deepEqual(calls[1].args, [
    'refresh', '--service', 'svc-due', '--root', baselineHistoryDir,
    '--bundle-dir', '/data/bundles', '--window', 'trailing-30d',
    '--creation-reason', 'calendar_safety_net',
  ]);
  assert.equal(summary.auto_refresh_triggered, true);
  assert.equal(summary.check.exit_code, 3);
  assert.equal(summary.refresh?.exit_code, 0);
});

test('scheduler: exit 3 (calendar due) WITHOUT auto-refresh -> no refresh spawned', async () => {
  const cfg = baseCfg({ autoRefresh: false });
  const scheduler = new MaintenanceScheduler(cfg);
  const { fn, calls } = recordingStub([stubResult({ code: 3, stdout: 'calendar safety net: DUE' })]);
  scheduler.setExecFileFnForTest(fn);

  const summary = await scheduler.runOnce() as MaintenanceRunSummary;
  assert.equal(calls.length, 1, 'check-only — auto-refresh disabled must never spawn refresh');
  assert.equal(summary.auto_refresh_triggered, false);
  assert.equal(summary.refresh, undefined);
});

test('scheduler: exit 0 (not due) + auto-refresh enabled -> no refresh spawned', async () => {
  const cfg = baseCfg({ autoRefresh: true, refreshBundleDir: '/data/bundles', refreshWindow: 'trailing-30d' });
  const scheduler = new MaintenanceScheduler(cfg);
  const { fn, calls } = recordingStub([stubResult({ code: 0 })]);
  scheduler.setExecFileFnForTest(fn);

  const summary = await scheduler.runOnce() as MaintenanceRunSummary;
  assert.equal(calls.length, 1);
  assert.equal(summary.auto_refresh_triggered, false);
});

// ── overlapping-run skip ──────────────────────────────────────────────

test('scheduler: overlapping run is skipped (one-at-a-time guard)', async () => {
  const cfg = baseCfg();
  const scheduler = new MaintenanceScheduler(cfg);
  let resolveFirst: ((r: ExecResult) => void) | undefined;
  const calls: RecordedCall[] = [];
  // Blocks on `resolveFirst` only for the FIRST call — every later call
  // resolves immediately, so a stub bug can't itself hang the "third
  // call proceeds normally" assertion below.
  scheduler.setExecFileFnForTest(async (bin, args) => {
    calls.push({ bin, args });
    if (calls.length === 1) {
      return new Promise<ExecResult>((resolve) => { resolveFirst = resolve; });
    }
    return stubResult();
  });

  const firstRun = scheduler.runOnce();
  await flush();
  assert.equal(calls.length, 1, 'first run has started and is blocked on the child');

  const secondOutcome = await scheduler.runOnce();
  assert.deepEqual(secondOutcome, { skipped: true }, 'a run already in flight causes an immediate skip');
  assert.equal(calls.length, 1, 'the skipped run never spawned a second child');

  resolveFirst!(stubResult());
  const firstOutcome = await firstRun;
  assert.notDeepEqual(firstOutcome, { skipped: true });

  // Now that the first run has finished, a fresh runOnce() must proceed
  // normally (the guard is per-run, not permanently latched).
  const thirdOutcome = await scheduler.runOnce();
  assert.equal(calls.length, 2);
  assert.notDeepEqual(thirdOutcome, { skipped: true });
});

// ── child error isolation ────────────────────────────────────────────

test('scheduler: a rejecting execFileFn never throws out of runOnce (isolated into the summary)', async () => {
  const cfg = baseCfg();
  const scheduler = new MaintenanceScheduler(cfg);
  scheduler.setExecFileFnForTest(async () => {
    throw new Error('boom: spawn ENOENT');
  });

  const summary = await scheduler.runOnce() as MaintenanceRunSummary;
  assert.equal(summary.check.exit_code, null);
  assert.match(summary.check.error ?? '', /boom: spawn ENOENT/);
});

test('scheduler: a timed-out child is captured (timed_out:true, null exit code), never throws', async () => {
  const cfg = baseCfg();
  const scheduler = new MaintenanceScheduler(cfg);
  scheduler.setExecFileFnForTest(async () => stubResult({
    code: null, timedOut: true, error: 'Command failed: killed', stdout: 'partial', stderr: '',
  }));

  const summary = await scheduler.runOnce() as MaintenanceRunSummary;
  assert.equal(summary.check.exit_code, null);
  assert.equal(summary.check.timed_out, true);
});

// ── maintenance.jsonl durable log ─────────────────────────────────────

test('scheduler: each run appends one JSON line to <storeDir>/<serviceId>/maintenance.jsonl', async () => {
  const storeDir = tmpRoot('ds-gate-maint-store-');
  const cfg = baseCfg({ storeDir, serviceId: 'svc-log' });
  const scheduler = new MaintenanceScheduler(cfg);
  scheduler.setExecFileFnForTest(async () => stubResult({ code: 0 }));

  await scheduler.runOnce();
  await scheduler.runOnce();

  const logPath = path.join(storeDir, 'svc-log', 'maintenance.jsonl');
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2);
  const parsed = lines.map((l) => JSON.parse(l));
  for (const entry of parsed) {
    assert.equal(entry.check.exit_code, 0);
    assert.ok(entry.started_at);
    assert.ok(entry.finished_at);
  }
});

// ── bounded in-memory history ─────────────────────────────────────────

test('scheduler: in-memory history is bounded to the last N (default 20) runs', async () => {
  const cfg = baseCfg({ historyLimit: 3 });
  const scheduler = new MaintenanceScheduler(cfg);
  scheduler.setExecFileFnForTest(async () => stubResult({ code: 0 }));

  for (let i = 0; i < 5; i += 1) await scheduler.runOnce();
  assert.equal(scheduler.getHistory().length, 3);
  assert.equal(scheduler.getStatus().history_count, 3);
});

// ── real spawn integration (no stub) ───────────────────────────────────

test('REAL SPAWN: check runs the actual compiled recalibrate CLI against an initialized store', async () => {
  const baselineHistoryDir = tmpRoot('ds-gate-maint-real-baseline-');
  const storeDir = tmpRoot('ds-gate-maint-real-store-');
  const serviceId = 'svc-real';
  // RecalibrationStore.init(root, serviceId) joins root+serviceId itself
  // (`path.join(root, serviceId)`, tools/recalibrate/_recalibrate-store.ts)
  // — exactly matching how the CLI's own `openStore` resolves
  // `--root <baselineHistoryDir> --service <serviceId>`. Do NOT
  // pre-join here, or the CLI (spawned below) looks in the wrong place.
  RecalibrationStore.init(baselineHistoryDir, serviceId);

  const cfg = baseCfg({
    recalibrateBin: null, // default resolution -> repo-relative compiled tools/recalibrate.js
    baselineHistoryDir,
    storeDir,
    serviceId,
    childTimeoutMs: 20_000,
  });
  const scheduler = new MaintenanceScheduler(cfg);
  // No setExecFileFnForTest call — this exercises the real
  // child_process.execFile path (defaultExecFile).

  const summary = await scheduler.runOnce() as MaintenanceRunSummary;
  // A freshly-initialized store has no candidate history at all ->
  // checkCalendarSafetyNet's lastActivity is null -> `check` exits 0
  // (not due), never 3 — see tools/recalibrate/_recalibrate-sweep.ts.
  // Check-only (no refresh compile), per the task's speed requirement.
  assert.equal(summary.check.exit_code, 0, summary.check.stderr_tail || summary.check.stdout_tail);
  assert.equal(summary.check.timed_out, false);
  assert.match(summary.check.stdout_tail, /not due/);
  assert.equal(summary.auto_refresh_triggered, false);
  assert.equal(summary.refresh, undefined);

  const logPath = path.join(storeDir, serviceId, 'maintenance.jsonl');
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).check.exit_code, 0);
});

// ── server.ts wiring: readyz surface + failure isolation ───────────────

const NOW = Math.floor(Date.now() / 1000);

function serverCfg(overrides: Partial<GateHttpConfig> = {}): GateHttpConfig {
  const storeDir = tmpRoot('ds-gate-maint-srv-store-');
  const baselineHistoryDir = tmpRoot('ds-gate-maint-srv-baseline-');
  const serviceId = overrides.serviceId ?? 'svc-srv';
  return {
    port: 0,
    bind: '127.0.0.1',
    sharedSecret: null,
    storeDir,
    baselineHistoryDir,
    serviceId,
    failPolicy: 'fail_closed',
    mode: 'enforce',
    totalTicksDefault: 8,
    sessionTtlSeconds: 3600,
    requestTimeoutMs: 4000,
    auditDir: path.join(storeDir, serviceId, 'audit'),
    maintenanceIntervalSeconds: 0,
    maintenanceAutoRefresh: false,
    maintenanceRefreshBundleDir: null,
    maintenanceRefreshWindow: null,
    maintenanceRecalibrateBin: null,
    ...overrides,
  };
}

function req(baseUrl: string, method: string, urlPath: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const url = new URL(urlPath, baseUrl);
    const request = http.request(url, { method }, (res: any) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('server: /readyz surfaces maintenance {enabled, auto_refresh, interval_seconds, last_run}', async () => {
  const cfg = serverCfg({ maintenanceIntervalSeconds: 45, serviceId: 'svc-readyz' });
  const handle = createGateServer(cfg);
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const port = (handle.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  handle.maintenance.setExecFileFnForTest(async () => stubResult({ code: 0, stdout: 'not due' }));

  try {
    const before = await req(baseUrl, 'GET', '/readyz');
    assert.equal(before.status, 200);
    assert.equal(before.json.maintenance.enabled, true);
    assert.equal(before.json.maintenance.auto_refresh, false);
    assert.equal(before.json.maintenance.interval_seconds, 45);
    assert.equal(before.json.maintenance.last_run, null);

    await handle.maintenance.runOnce();

    const after = await req(baseUrl, 'GET', '/readyz');
    assert.equal(after.json.maintenance.last_run.check.exit_code, 0);
  } finally {
    await handle.close();
  }
});

test('server: a failed maintenance run never breaks the server — HTTP keeps serving through/after it', async () => {
  const cfg = serverCfg({ maintenanceIntervalSeconds: 45, serviceId: 'svc-isolation' });
  const handle = createGateServer(cfg);
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const port = (handle.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  handle.maintenance.setExecFileFnForTest(async () => {
    throw new Error('simulated spawn failure');
  });

  try {
    const healthyBefore = await req(baseUrl, 'GET', '/healthz');
    assert.equal(healthyBefore.status, 200);

    const summary = await handle.maintenance.runOnce() as MaintenanceRunSummary;
    assert.equal(summary.check.exit_code, null);
    assert.match(summary.check.error ?? '', /simulated spawn failure/);

    const healthyAfter = await req(baseUrl, 'GET', '/healthz');
    assert.equal(healthyAfter.status, 200, 'server must keep serving after a maintenance-run failure');

    const readyz = await req(baseUrl, 'GET', '/readyz');
    assert.equal(readyz.status, 200);
    assert.equal(readyz.json.maintenance.last_run.check.exit_code, null);
  } finally {
    await handle.close();
  }
});

test('server: maintenance scheduler is stopped on close() (disabled scheduler surfaces enabled:false)', async () => {
  const cfg = serverCfg({ maintenanceIntervalSeconds: 0, serviceId: 'svc-disabled' });
  const handle = createGateServer(cfg);
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const port = (handle.server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const ready = await req(baseUrl, 'GET', '/readyz');
    assert.equal(ready.json.maintenance.enabled, false);
    assert.equal(ready.json.maintenance.last_run, null);
  } finally {
    await handle.close();
  }
});
