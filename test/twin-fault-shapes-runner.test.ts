// studies/twin-fault-shapes (PREREGISTRATION.md §1, §6): the runner is the second study's with the study
// id and the cell list changed, and the service's reset fault is evenly spaced and never coincides with
// the 503 schedule. The first study's test file covers the shared runner behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const V2 = path.join(__dirname, '..', 'studies', 'twin-aa-real-2', 'harness', 'run-real.mjs');
const FS = path.join(__dirname, '..', 'studies', 'twin-fault-shapes', 'harness', 'run-real.mjs');
const SERVER = path.join(__dirname, '..', 'studies', 'twin-aa-real', 'infra', 'service', 'server.mjs');
const LANE = path.join(__dirname, '..', 'studies', 'twin-aa-real', 'infra', 'cloudformation', 'lane.yaml');

test('twin-fault-shapes: study id, the three AB cells, the margin and four tasks per arm as the second study', async () => {
  const m: any = await import(FS);
  assert.equal(m.REGISTERED.studyId, '2026-10-twin-fault-shapes');
  assert.deepEqual([...m.REGISTERED.cells], ['AB-lat30', 'AB-5xx-1.5', 'AB-reset', 'AB-reset-nr']);
  const sign = m.twinArm(60).metrics.find((x: any) => x.kind === 'sign');
  assert.deepEqual(sign, { id: 'p99_latency', kind: 'sign', worse: 'higher', tolerance: 0.15, margin: { relative: 0.10 } });
  const cfg = {
    study_id: '2026-10-twin-fault-shapes', alb_idle_timeout_s: 60, lane: 0, region: 'eu-west-1',
    load_balancer: 'app/t3-alb/50dc6c495c0c9188',
    target_groups: { canary: 'targetgroup/t3-canary-new/aaaa1111', control: 'targetgroup/t3-baseline-old/bbbb2222' },
    tasks_per_arm: 4, gate: { base_url: 'http://127.0.0.1:8790', token_env: 'DS_GATE_SHARED_SECRET' },
  };
  assert.doesNotThrow(() => m.validateConfig(cfg));
  assert.throws(() => m.validateConfig({ ...cfg, tasks_per_arm: 2 }), /tasks_per_arm must be 4/);
  assert.throws(() => m.validateConfig({ ...cfg, study_id: '2026-10-twin-aa-real-2' }), /study_id/);
});

test('twin-fault-shapes: every line of the second study\'s runner survives; this study only adds (Amendment 2\'s fourth cell)', () => {
  const norm = (l: string) => l.replace(/twin-fault-shapes/g, 'twin-aa-real-2');
  const a = fs.readFileSync(V2, 'utf8').split('\n').map(norm);
  const b = new Set(fs.readFileSync(FS, 'utf8').split('\n').map(norm));
  const missing = a.filter((l) => !b.has(l));
  // the only second-study lines changed: comments, the cell list, twinArm's signature, the two twinArm call sites
  assert.ok(missing.every((l) => l.startsWith('//') || /cells: Object\.freeze\(\['AA'\]\)/.test(l) || /^export function twinArm\(maxTicks\) \{$/.test(l) || /twin_arm: \{ scored: twinArm\(T\), w0: twinArm\(W \+ T\) \}/.test(l)),
    `second-study lines missing from this study's runner:\n${missing.join('\n')}`);
});

test('twin-fault-shapes: cells 1–3 declare the second study\'s two metrics; AB-reset-nr adds exactly the no_response rate metric', async () => {
  const m: any = await import(FS);
  const v2: any = await import(V2);
  for (const cell of [undefined, 'AB-lat30', 'AB-5xx-1.5', 'AB-reset']) assert.deepEqual(m.twinArm(60, cell), v2.twinArm(60));
  const nr = m.twinArm(60, 'AB-reset-nr');
  assert.deepEqual(nr.metrics.slice(0, 2), v2.twinArm(60).metrics);
  assert.deepEqual(nr.metrics[2], { id: 'no_response', kind: 'rate', worse: 'higher', tolerance: 0.2 });
  assert.equal(nr.metrics.length, 3);
});

test('twin-fault-shapes: no_response = requests routed minus target responses, per arm, clamped to [0, total]', async () => {
  const m: any = await import(FS);
  const body = { canary_requests: 1209, control_requests: 1219, observations: { http_5xx: { canary_events: 6, canary_total: 1209, control_events: 6, control_total: 1219 } } };
  assert.deepEqual(m.noResponseObservation(body, { t2_canary: 1197, t3_canary: 0, t4_canary: 0, t2_control: 1213, t3_control: 0, t4_control: 0 }),
    { canary_events: 6, canary_total: 1209, control_events: 0, control_total: 1219 });
  // publication skew: more responses than requests clamps to 0, never negative
  assert.deepEqual(m.noResponseObservation(body, { t2_canary: 1300, t3_canary: 0, t4_canary: 0, t2_control: 1213.4, t3_control: 1, t4_control: 2 }),
    { canary_events: 0, canary_total: 1209, control_events: 0, control_total: 1219 });
  // 3xx and 4xx responses are answers too
  assert.deepEqual(m.noResponseObservation(body, { t2_canary: 1000, t3_canary: 100, t4_canary: 97, t2_control: 1000, t3_control: 100, t4_control: 100 }),
    { canary_events: 6, canary_total: 1209, control_events: 13, control_total: 1219 });
});

test('twin-fault-shapes: the reset schedule is evenly spaced and half a period from the 503 schedule', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  assert.match(src, /Math\.floor\(n \* RESET_FRACTION \+ 0\.5\) > Math\.floor\(\(n - 1\) \* RESET_FRACTION \+ 0\.5\)/);
  assert.match(src, /req\.socket\.destroy\(\)/);
  // the same arithmetic as the service, over 10,000 requests at the registered fractions
  const f = 0.005, r = 0.005; const faults: number[] = [], resets: number[] = [];
  for (let n = 1; n <= 10_000; n++) {
    if (Math.floor(n * r + 0.5) > Math.floor((n - 1) * r + 0.5)) { resets.push(n); continue; }
    if (Math.floor(n * f) > Math.floor((n - 1) * f)) faults.push(n);
  }
  assert.equal(resets.length, 50);
  assert.equal(faults.length, 50);
  assert.ok(resets.every((n) => !faults.includes(n)));
  assert.equal(resets[0], 100);
  assert.equal(faults[0], 200);
});

test('twin-fault-shapes: the lane template gives the canary its own definition for any of the three overrides and defaults to none', () => {
  const y = fs.readFileSync(LANE, 'utf8');
  assert.match(y, /CanaryHasOwnFault: !Or \[!Condition Canary503Set, !Condition CanaryLatencySet, !Condition CanaryResetSet\]/);
  for (const p of ['CanaryFault503Fraction', 'CanaryLatencyMedianMs', 'CanaryResetFraction']) {
    assert.match(y, new RegExp(`  ${p}:\\n    Type: String\\n    Default: ""`), `${p} must default to empty`);
  }
  assert.match(y, /RESET_FRACTION, Value: !If \[CanaryResetSet, !Ref CanaryResetFraction, "0"\]/);
  assert.match(y, /LATENCY_MEDIAN_MS, Value: !If \[CanaryLatencySet, !Ref CanaryLatencyMedianMs, !Ref LatencyMedianMs\]/);
});
