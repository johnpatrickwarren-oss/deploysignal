// studies/twin-aa-local Amendment 1 (PREREGISTRATION.md): the void rule for host suspension, the
// per-arm upstream-error split check, and that run 1's scored output is unchanged by them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const STUDY = path.join(__dirname, '..', 'studies', 'twin-aa-local');
const load = (): Promise<any> => import(path.join(STUDY, 'analysis', 'executability.mjs'));
const summarize = (): Promise<any> => import(path.join(STUDY, 'analysis', 'summarize.mjs'));

const LOG = [
  '2026-09-26 22:07:00 -0700 Assertions          \tPID 1(x) Created PreventUserIdleSystemSleep "caffeinate"',
  '2026-09-26 22:29:58 -0700 Sleep               \tEntering Sleep state due to \'Clamshell Sleep\':TCPKeepAlive=active',
  '2026-09-26 22:30:29 -0700 DarkWake            \tDarkWake from Deep Idle [CDN] : due to smc.sysState.Wake',
  '2026-09-26 22:31:14 -0700 Sleep               \tEntering Sleep state due to \'Maintenance Sleep\'',
  '2026-09-26 23:40:00 -0700 Wake                \tDarkWake to FullWake from Deep Idle [CDNVA]',
  '  continuation line without a timestamp',
].join('\n');

test('powerLogWindow keeps only timestamped lines inside [start, end], inclusive to the second', async () => {
  const { powerLogWindow } = await load();
  const start = Date.parse('2026-09-26T22:29:58.400-07:00');
  const end = Date.parse('2026-09-26T22:30:29.100-07:00');
  const kept = powerLogWindow(LOG, start, end).split('\n').filter(Boolean);
  assert.equal(kept.length, 2);
  assert.match(kept[0], /Clamshell Sleep/);
  assert.match(kept[1], /DarkWake from Deep Idle/);
});

test('suspensionEvents finds Sleep and DarkWake event types and ignores Wake and Assertions', async () => {
  const { suspensionEvents } = await load();
  const ev = suspensionEvents(LOG);
  assert.deepEqual(ev.map((e: any) => e.type), ['Sleep', 'DarkWake', 'Sleep']);
  assert.equal(ev[0].at, '2026-09-26 22:29:58 -0700');
});

test('voidReasons: clean run is executable; sleep, a slow tick, or a missing power log void it', async () => {
  const { voidReasons, TICK_WALL_BOUND_MS } = await load();
  assert.equal(TICK_WALL_BOUND_MS, 2000);
  const cell = (ms: number) => ({ name: 'AA-w0.5', runs: [{ run: 0, ticks: [{ t: 0, ms: 70 }, { t: 1, ms }] }] });
  assert.deepEqual(voidReasons({ powerLog: '', cells: [cell(80)] }), []);
  assert.deepEqual(voidReasons({ powerLog: '', cells: [cell(2000)] }), [], 'the bound itself is not exceeded');
  const slow = voidReasons({ powerLog: '', cells: [cell(2000.5)] });
  assert.equal(slow.length, 1);
  assert.match(slow[0], /AA-w0\.5 run 0 tick 1: 2000\.5 ms > 2000 ms/);
  const slept = voidReasons({ powerLog: LOG.split('\n')[1], cells: [cell(80)] });
  assert.equal(slept.length, 1);
  assert.match(slept[0], /power log: Sleep at 2026-09-26 22:29:58 -0700/);
  assert.match(voidReasons({ powerLog: null, cells: [cell(80)] })[0], /power log unavailable/);
  assert.match(voidReasons({ powerLog: '', cells: [{ name: 'X', runs: [{ run: 0, ticks: [{ t: 0 }] }] }] })[0], /no wall duration/);
});

test('upstreamSplit reproduces the run-1 reference z values (1.94 near, 6.01 not near)', async () => {
  const { upstreamSplit } = await load();
  const runs = [
    { run: 99, ticks: [{ t: 13, nc: 50, nk: 450, uc: 0, uk: 0 }, { t: 14, nc: 50, nk: 450, uc: 19, uk: 106 }] },
    { run: 20, ticks: [{ t: 13, nc: 256, nk: 244, uc: 49, uk: 4 }] },
  ];
  const s = upstreamSplit(runs);
  assert.equal(s.canary, 68);
  assert.equal(s.control, 110);
  assert.equal(s.ticks.length, 2);
  assert.equal(s.ticks[0].z.toFixed(2), '1.94');
  assert.equal(s.ticks[0].near, true);
  assert.equal(s.ticks[1].z.toFixed(2), '6.01');
  assert.equal(s.ticks[1].near, false);
  assert.deepEqual(upstreamSplit([{ run: 0, ticks: [{ t: 0, nc: 250, nk: 250, uc: 0, uk: 0 }] }]), { canary: 0, control: 0, ticks: [] });
});

test('run 1 (no amendment in its manifest) scores exactly as its committed endpoints.json', async () => {
  const { compute } = await summarize();
  const dir = path.join(STUDY, 'results', 'run-20260927T050717Z');
  const stored = fs.readFileSync(path.join(dir, 'endpoints.json'), 'utf8');
  assert.equal(`${JSON.stringify(compute(dir), null, 2)}\n`, stored);
});

function fakeRun(dir: string, { powerLog, tickMs }: { powerLog: string | null; tickMs: number }): void {
  const mk = (name: string, R: number, verdict: string) => ({
    name, twin_arm: { metrics: [{ id: 'http_5xx' }, { id: 'p99_latency_ms' }] }, harness_failures: 0, wall_seconds: 1, requests_per_second: 1,
    runs: Array.from({ length: R }, (_, r) => ({ run: r, verdict, ticks_to_detect: 100, ticks: [{
      t: 0, ms: tickMs, nc: 250, nk: 250, ec: 5, ek: 5, uc: 0, uk: 0, p99c: 20 + (r % 2), p99k: 20.5, srm: 1,
      m: [['http_5xx', verdict === 'rollback' ? 50 : 1, 40, 1, 1, 0, 0, 0]],
    }] })),
  });
  for (const [n, R, v] of <[string, number, string][]>[['AA-w0.5', 100, 'inconclusive'], ['AA-w0.1', 100, 'inconclusive'], ['AB-rate-x2', 40, 'rollback'], ['AB-lat-x1.2', 40, 'rollback']]) {
    fs.writeFileSync(path.join(dir, `cell-${n}.json`), JSON.stringify(mk(n, R, v)));
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ amendment: 1, seed_offset: 1000000 }));
  if (powerLog !== null) fs.writeFileSync(path.join(dir, 'power-log.txt'), powerLog);
}

test('an Amendment-1 run with a Sleep line is VOID: nothing scored, ship rule not met, reason rendered', async () => {
  const { compute, renderTables } = await summarize();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-aa-run2-'));
  fakeRun(dir, { powerLog: LOG.split('\n')[1], tickMs: 70 });
  const res = compute(dir);
  assert.equal(res.amendment1.executable, false);
  for (const v of Object.values(res.endpoints)) assert.equal(v, 'VOID');
  for (const v of Object.values(res.predictions)) assert.equal(v, 'VOID');
  assert.equal(res.ship_rule_met, false);
  const txt = renderTables(res);
  assert.match(txt, /Run executable \(Amendment 1 \(c\)\): VOID/);
  assert.match(txt, /\| E1 \| VOID \|/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an Amendment-1 run with a clean power log and fast ticks is scored and renders the split line', async () => {
  const { compute, renderTables } = await summarize();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-aa-run2-'));
  fakeRun(dir, { powerLog: '', tickMs: 70 });
  const res = compute(dir);
  assert.equal(res.amendment1.executable, true);
  assert.equal(res.endpoints.E1, true);
  assert.equal(res.endpoints.E6, true);
  assert.equal(res.ship_rule_met, true);
  assert.equal(res.cells['AA-w0.5'].max_tick_ms, 70);
  const txt = renderTables(res);
  assert.match(txt, /Run executable \(Amendment 1 \(c\)\): YES/);
  assert.match(txt, /Upstream-error split \(Amendment 1 \(d\), report-only\): no upstream-error ticks/);
  fs.rmSync(dir, { recursive: true, force: true });
});
