// studies/twin-aa-noresponse (PREREGISTRATION.md §1, §2): the runner is the fault study's with the study id, the
// one cell AA-nr declaring no_response, and one task per arm; the lane template puts RESET_FRACTION in the shared
// task definition only when asked; the analysis carries the registered bars and N4's band. The earlier studies'
// test files cover the shared runner behaviour and the no_response construction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ROOT = path.join(__dirname, '..');
const FS = path.join(ROOT, 'studies', 'twin-fault-shapes', 'harness', 'run-real.mjs');
const NR = path.join(ROOT, 'studies', 'twin-aa-noresponse', 'harness', 'run-real.mjs');
const LANE = path.join(ROOT, 'studies', 'twin-aa-real', 'infra', 'cloudformation', 'lane.yaml');
const ANALYZE = path.join(ROOT, 'studies', 'twin-aa-noresponse', 'analysis', 'analyze.mjs');

test('twin-aa-noresponse: study id, the AA-nr cell only, three metrics with the margin, one task per arm', async () => {
  const m: any = await import(NR);
  assert.equal(m.REGISTERED.studyId, '2026-10-twin-aa-noresponse');
  assert.deepEqual([...m.REGISTERED.cells], ['AA-nr']);
  assert.deepEqual(m.twinArm(60, 'AA-nr').metrics, [
    { id: 'http_5xx', kind: 'rate', worse: 'higher', tolerance: 0.2 },
    { id: 'p99_latency', kind: 'sign', worse: 'higher', tolerance: 0.15, margin: { relative: 0.10 } },
    { id: 'no_response', kind: 'rate', worse: 'higher', tolerance: 0.2 },
  ]);
  const cfg = {
    study_id: '2026-10-twin-aa-noresponse', alb_idle_timeout_s: 60, lane: 2, region: 'eu-west-1',
    load_balancer: 'app/t3-alb/50dc6c495c0c9188',
    target_groups: { canary: 'targetgroup/t3-canary-new/aaaa1111', control: 'targetgroup/t3-baseline-old/bbbb2222' },
    tasks_per_arm: 1, gate: { base_url: 'http://127.0.0.1:8790', token_env: 'DS_GATE_SHARED_SECRET' },
  };
  assert.doesNotThrow(() => m.validateConfig(cfg));
  assert.throws(() => m.validateConfig({ ...cfg, tasks_per_arm: 4 }), /tasks_per_arm must be 1/);
  assert.throws(() => m.validateConfig({ ...cfg, study_id: '2026-10-twin-aa-onebox' }), /study_id/);
});

test('twin-aa-noresponse: unanswered requests are clamped per arm and the 5xx sum is the tick body\'s own', async () => {
  const m: any = await import(NR);
  const body = { canary_requests: 1220, control_requests: 1210, observations: { http_5xx: { canary_events: 6, control_events: 7 } } };
  const sums = { t2_canary: 1208, t3_canary: 0, t4_canary: 0, t2_control: 1205, t3_control: 0, t4_control: 0 };
  assert.deepEqual(m.noResponseObservation(body, sums), { canary_events: 6, canary_total: 1220, control_events: 0, control_total: 1210 });
});

test('twin-aa-noresponse: the runner differs from the fault study\'s only in the study id, the cell, the task count and comments', () => {
  const norm = (l: string) => l.replace(/twin-aa-noresponse/g, 'twin-fault-shapes');
  const a = fs.readFileSync(FS, 'utf8').split('\n').map(norm);
  const b = fs.readFileSync(NR, 'utf8').split('\n').map(norm);
  const setA = new Set(a), setB = new Set(b);
  const onlyB = b.filter((l) => !setA.has(l));
  const onlyA = a.filter((l) => !setB.has(l));
  const ok = /^\s*\/\/|tasks_per_arm === [14]|cells: Object\.freeze|NR_CELL = /;
  assert.ok(onlyB.every((l) => ok.test(l)), `unexpected lines only in this study's runner:\n${onlyB.join('\n')}`);
  assert.ok(onlyA.every((l) => ok.test(l)), `unexpected lines only in the fault study's runner:\n${onlyA.join('\n')}`);
});

test('twin-aa-noresponse: the lane template sets RESET_FRACTION in the shared task definition from ResetFraction, default "0"', () => {
  const y = fs.readFileSync(LANE, 'utf8');
  assert.match(y, /  ResetFraction:\n    Type: String\n    Default: "0"/);
  const shared = y.slice(y.indexOf('  TaskDefinition:\n'), y.indexOf('  CanaryTaskDefinition:\n'));
  assert.match(shared, /RESET_FRACTION, Value: !Ref ResetFraction \}/);
  assert.match(y, /RESET_FRACTION, Value: !If \[CanaryResetSet, !Ref CanaryResetFraction, !Ref ResetFraction\]/);
});

test('twin-aa-noresponse: the analysis carries the registered bars, N4\'s band, and V9 on both arms', async () => {
  const s = fs.readFileSync(ANALYZE, 'utf8');
  const m: any = await import(ANALYZE);
  assert.equal(m.CELL, 'AA-nr');
  assert.deepEqual({ R: m.REG.R, B: m.REG.B, max: m.REG.max_rollbacks, stop: m.REG.stop_after_rollbacks, cap: m.REG.attempt_cap, halts: m.REG.n2_max_halts, lo: m.REG.n4_lo, hi: m.REG.n4_hi },
    { R: 100, B: 0.1062, max: 10, stop: 11, cap: 150, halts: 2, lo: 3, hi: 12 });
  assert.equal(m.n4Verdict([{ canary: 6, control: 6 }, { canary: 5, control: 7 }, { canary: 6.5, control: 5.5 }]).verdict, 'PASS');
  assert.match(m.n4Verdict([{ canary: 6, control: 0 }, { canary: 6, control: 0 }, { canary: 6, control: 0 }]).verdict, /^FAIL/);
  assert.match(m.n4Verdict([]).verdict, /^FAIL/);
  assert.match(s, /const tds = \[\.\.\.new Set\(\[\.\.\.base, \.\.\.can\]\.map\(\(t\) => t\.td\)\)\]/);
  assert.match(s, /events_inside: inside\.filter\(\(e\) => e\.lane === s\.lane\)/);
});
