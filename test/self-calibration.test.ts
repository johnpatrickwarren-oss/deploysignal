// test/self-calibration.test.ts — ADR 0002 acceptance study `2026-10-self-calibration` (decisions/0002-self-calibration.md §6).
// A1 reproduces 2026-10-temporal-null-real from the committed raw series; A2 exclusion; A3 the served field; A4 a failing
// substrate (the GWDG unit the gate study rolled back) — A4 runs only when the dataset is present locally and is
// reported by the acceptance report, not by CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SessionStore } from '../service/session/session-store';
import { JsonlLifecycleEventEmitter } from '../service/session/jsonl-lifecycle-emitter';
import { GateSessionRuntime } from '../service/gate-http/_gate-session-runtime';
import type { GateRuntimeConfig } from '../service/gate-http/_gate-session-runtime';
import { runSelfCalibration, parseArgs } from '../tools/self-calibrate';
import { readSelfCalibration, selfCalibrationDir } from '../service/session/self-calibration';

const { createAuditWriter } = require('../dist/engine/_audit-writer');
const ROOT = path.resolve(__dirname, '..');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** The study's raw lanes → the tool's generic format (p99 ms, 5xx rate, traffic share of 9,740/2 min, healthy ≥ 2 hosts). */
function convertLanes(dir: string): string[] {
  const out: string[] = [];
  for (const L of [0, 1, 2, 3]) {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'studies', 'temporal-null-real', 'results', 'raw', `lane${L}.json`), 'utf8'));
    const ticks = r.ticks.map((x: any) => ({ t: x.t, metrics: { p99_latency: x.p99_s === null ? NaN : x.p99_s * 1000, downstream_err: x.req ? (x.e5 ?? 0) / x.req : NaN }, traffic_pct: x.req === null ? undefined : x.req / 9740, healthy: x.hh === null ? undefined : x.hh >= 2 }));
    const p = path.join(dir, `lane${L}.json`); fs.writeFileSync(p, JSON.stringify({ ticks })); out.push(p);
  }
  return out;
}
const BASE = (store: string, raws: string[], extra: string[] = []) => parseArgs(['--service-id', 'prod-old', '--store', store, ...raws.flatMap((r) => ['--raw', r]), '--calibration-end', '2026-10-02T01:30:00Z', '--now', '2026-10-03T05:00:00Z', ...extra]);

test('A1: the feature reproduces 2026-10-temporal-null-real — 100 sessions, 0 fires, upper 0.030, low_traffic held in 81, Family A on two signals', () => {
  const dir = tmp('selfcal-a1-'); const raws = convertLanes(dir); const store = tmp('selfcal-a1-store-');
  const { record } = runSelfCalibration(BASE(store, raws), ROOT);
  assert.equal(record.sessions, 100); assert.equal(record.fires, 0); assert.ok(Math.abs(record.upper95 - 0.0295) < 1e-3);
  assert.equal(record.hold_ids.low_traffic, 81); assert.deepEqual(Object.keys(record.fire_ids), []);
  assert.equal(record.per_family.B.holds, 81); assert.equal(record.per_family.A.fires, 0);
  assert.deepEqual(record.signals, ['p99_latency', 'downstream_err']);
  assert.ok(Object.values(record.thresholds).every((t) => !t.unreachable) && record.thresholds.p99_latency.bootstrap! > 0);
  assert.ok(fs.existsSync(path.join(selfCalibrationDir(store, 'prod-old'), 'latest.json')));
});

test('A2: declared and lifecycle-store change windows are excluded and listed; the session count falls by the sessions they cover', () => {
  const dir = tmp('selfcal-a2-'); const raws = convertLanes(dir); const store = tmp('selfcal-a2-store-');
  // two declared deploys of 20 minutes each inside the evaluation window, on all four lanes (10 two-minute ticks each → one session per lane each)
  const ex = path.join(dir, 'ex.json');
  fs.writeFileSync(ex, JSON.stringify([{ start: '2026-10-02T10:00:00Z', end: '2026-10-02T10:20:00Z', source: 'deploy A' }, { start: '2026-10-02T20:00:00Z', end: '2026-10-02T20:20:00Z', source: 'deploy B' }]));
  // and one lifecycle-store session record
  const sdir = path.join(store, 'prod-old', 'sessions'); fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'sess-x.json'), JSON.stringify({ session_id: 'sess-x', begun_at: '2026-10-02T15:00:00Z', ended_at: '2026-10-02T15:30:00Z' }));
  const { record, series } = runSelfCalibration(BASE(store, raws, ['--exclude', ex]), ROOT);
  assert.equal(record.exclusions.length, 3);
  assert.ok(record.exclusions.some((e) => e.source.startsWith('lifecycle-store session sess-x')));
  // expected: sessions are contiguous 64-minute blocks from the calibration end on every lane; count the blocks each window touches
  const t0 = Date.parse('2026-10-02T01:30:00Z'), blockMs = 32 * 120 * 1000;
  const windows = [['2026-10-02T10:00:00Z', '2026-10-02T10:20:00Z'], ['2026-10-02T20:00:00Z', '2026-10-02T20:20:00Z'], ['2026-10-02T15:00:00Z', '2026-10-02T15:30:00Z']];
  const touched = new Set<number>(); for (const [a, b] of windows) { for (let k = Math.floor((Date.parse(a) - t0) / blockMs); k <= Math.floor((Date.parse(b) - 1 - t0) / blockMs); k++) touched.add(k); }
  const expected = touched.size * 4;
  const voided = series.flatMap((s) => s.sessions).filter((s) => !s.executable);
  assert.equal(voided.length, expected, `${touched.size} blocks touched × 4 lanes: ${voided.length}`);
  assert.ok(voided.every((v) => v.void_reason === 'change window'));
  assert.equal(record.sessions, 100 - expected);
});

test('A3: a session serves the stored summary on tick and verdict; no record → null; an older-than-span or re-compiled record → stale', () => {
  const dir = tmp('selfcal-a3-'); const raws = convertLanes(dir);
  const baselineHistoryDir = tmp('selfcal-a3-baseline-');
  const mk = () => {
    const storeDir = tmp('selfcal-a3-sessions-'); // one session store per runtime (the runtime locks its store dir)
    const store = SessionStore.init(storeDir, 'prod-old');
    const emitter = new JsonlLifecycleEventEmitter(path.join(storeDir, 'prod-old', 'events.jsonl'));
    const auditWriter = createAuditWriter({ dir: path.join(storeDir, 'prod-old', 'audit'), service: 'prod-old' });
    const cfg: GateRuntimeConfig = { storeDir, baselineHistoryDir, serviceId: 'prod-old', mode: 'enforce', failPolicy: 'fail_closed', totalTicksDefault: 4, sessionTtlSeconds: 3600 };
    return new GateSessionRuntime(cfg, store, emitter, auditWriter);
  };
  const BASELINE = { p99_latency: 76, downstream_err: 0.005, traffic_pct: 1 };
  // (i) no record → null
  let rt = mk(); let { record } = rt.begin({ deploy_ref: 'd1', requested_at_ts: 1_700_000_000, scenario: { baseline: BASELINE } });
  let tick = rt.ingestTick(record.session_id, { emitted_at_ts: 1_700_000_000, metrics: BASELINE });
  assert.equal(tick.self_calibration, null); assert.equal(rt.verdictFor('d1')!.self_calibration, null);
  // (ii) a fresh record → served, not stale
  runSelfCalibration(BASE(baselineHistoryDir, raws), ROOT);
  rt = mk(); ({ record } = rt.begin({ deploy_ref: 'd2', requested_at_ts: 1_700_000_100, scenario: { baseline: BASELINE } }));
  tick = rt.ingestTick(record.session_id, { emitted_at_ts: 1_700_000_100, metrics: BASELINE });
  assert.ok(tick.self_calibration); assert.equal(tick.self_calibration!.sessions, 100); assert.equal(tick.self_calibration!.fires, 0);
  const now = new Date('2026-10-03T06:00:00Z');
  assert.equal(readSelfCalibration(baselineHistoryDir, 'prod-old', { now })!.stale, false);
  // (iii) older than its span → stale; a different compiled config → stale
  assert.equal(readSelfCalibration(baselineHistoryDir, 'prod-old', { now: new Date('2026-10-10T00:00:00Z') })!.stale, true);
  const other = path.join(baselineHistoryDir, 'other.json'); fs.writeFileSync(other, '{"version":"different"}');
  const s3 = readSelfCalibration(baselineHistoryDir, 'prod-old', { now, compiledConfigPath: other })!;
  assert.equal(s3.stale, true); assert.match(s3.stale_reason!, /different compiled config/);
});

const GWDG = process.env.GWDG_DATA ?? path.join(ROOT, '..', 'tessera', 'runs', 'gwdg-data', 'gwdg-gpu-node-telemetry-gpu-detachment-failures-2025-2026-v1.0.0');
test('A4: a failing substrate — the GWDG unit the gate study rolled back reports fires in its null window (runs only with the dataset present; GWDG_DATA)', { skip: !fs.existsSync(path.join(GWDG, 'telemetry', 'ggpu129_2026-01-09_gpu-lost_tidy.csv')) }, async () => {
  // @ts-ignore — an .mjs study module without declarations
  const lib: any = await import('../studies/gwdg-gate/harness/lib.mjs');
  const data = path.join(GWDG, 'telemetry', 'ggpu129_2026-01-09_gpu-lost_tidy.csv');
  const tidy = await lib.loadTidy(data);
  const gpu = '0'; const series = tidy.series[gpu]; const SIG = lib.SIGNALS as readonly string[];
  // the unit's grid from its first sample through the end of the gwdg-gate null window (2026-01-08 00:00)
  const first = Math.min(...SIG.map((s) => Math.min(...(series[s]?.keys() ?? [Infinity]))));
  const end = Date.parse('2026-01-08 00:00:00Z');
  const ticks: any[] = [];
  for (let ms = first; ms < end; ms += lib.tickMs) { const metrics: Record<string, number> = {}; for (const s of SIG) metrics[s] = series[s]?.get(ms) ?? NaN; ticks.push({ t: new Date(ms).toISOString(), metrics, traffic_pct: 1 }); }
  const dir = tmp('selfcal-a4-'); const raw = path.join(dir, 'ggpu129-gpu0.json'); fs.writeFileSync(raw, JSON.stringify({ ticks })); const store = tmp('selfcal-a4-store-');
  // calibration = the study's 96 h window from the unit's first sample (2026-01-02 → 2026-01-06); scored = the null window
  // (a) the study's own settings (Family A only, hour_of_day cells, risk medium, one 288-tick session on the null window): the fire reproduces
  const common = ['--service-id', 'ggpu129-gpu0', '--store', store, '--raw', raw, '--signals', SIG.join(','), '--tick-seconds', '600', '--session-ticks', '288', '--calibration-end', '2026-01-06T00:00:00Z', '--profile-ref', 'gwdg-gpu-node-a@1.0.0', '--cell-dim', 'hour_of_day', '--risk-level', 'medium', '--now', '2026-01-08T00:00:00Z'];
  const a = runSelfCalibration(parseArgs([...common, '--families', 'A']), ROOT).record;
  assert.equal(a.sessions, 1); assert.equal(a.fires, 1, `the gate study rolled this unit back at tick 92 of its null window; the feature reports ${a.fires}/${a.sessions}`);
  assert.ok(Object.keys(a.fire_ids).some((id) => id.includes('SM_CLOCK')), JSON.stringify(a.fire_ids));
  assert.ok(Object.values(a.thresholds).every((t) => !t.unreachable));
  // (b) the shipped family set: Family D's compile stamps a bootstrap betting threshold on Family A that this series cannot reach
  //     (knowledge stats/gwdg-gate-2026-09-29 finding 2); the record says the detector cannot fire, and 0 fires is not a measurement
  const b = runSelfCalibration(parseArgs([...common, '--families', 'A,B,C,D,E']), ROOT).record;
  assert.equal(b.fires, 0);
  const unreachable = Object.entries(b.thresholds).filter(([, t]) => t.unreachable).map(([s]) => s);
  assert.ok(unreachable.includes('DCGM_FI_DEV_SM_CLOCK'), `unreachable: ${unreachable.join(',')}`);
  assert.ok(b.thresholds.DCGM_FI_DEV_SM_CLOCK.bootstrap! > 1e12);
  const summ = readSelfCalibration(store, 'ggpu129-gpu0', { now: new Date('2026-01-08T00:00:00Z') })!;
  assert.ok(summ.unreachable_signals.includes('DCGM_FI_DEV_SM_CLOCK'));
});
