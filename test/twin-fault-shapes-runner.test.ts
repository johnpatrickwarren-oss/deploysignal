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
  assert.deepEqual([...m.REGISTERED.cells], ['AB-lat30', 'AB-5xx-1.5', 'AB-reset']);
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

test('twin-fault-shapes: the runner differs from the second study\'s only in the study id, the cells and comments', () => {
  const norm = (l: string) => l.replace(/twin-fault-shapes/g, 'twin-aa-real-2');
  const a = fs.readFileSync(V2, 'utf8').split('\n').map(norm);
  const b = fs.readFileSync(FS, 'utf8').split('\n').map(norm);
  const setA = new Set(a), setB = new Set(b);
  const onlyB = b.filter((l) => !setA.has(l));
  const onlyA = a.filter((l) => !setB.has(l));
  assert.ok(onlyB.every((l) => l.startsWith('//') || /cells: Object\.freeze\(\['AB-lat30', 'AB-5xx-1\.5', 'AB-reset'\]\)/.test(l)), `unexpected lines only in this study's runner:\n${onlyB.join('\n')}`);
  assert.ok(onlyA.every((l) => l.startsWith('//') || /cells: Object\.freeze\(\['AA'\]\)/.test(l)), `unexpected lines only in the second study's runner:\n${onlyA.join('\n')}`);
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
