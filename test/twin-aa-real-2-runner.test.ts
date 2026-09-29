// studies/twin-aa-real-2 (PREREGISTRATION.md §1): the second registration's runner is the first
// study's runner with the registered deltas only. The first study's test file covers the shared
// behaviour; this one pins the deltas and the "byte-identical otherwise" claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const V1 = path.join(__dirname, '..', 'studies', 'twin-aa-real', 'harness', 'run-real.mjs');
const V2 = path.join(__dirname, '..', 'studies', 'twin-aa-real-2', 'harness', 'run-real.mjs');
const load = (): Promise<any> => import(V2);

test('twin-aa-real-2: study id, AA only, the p99 margin { relative: 0.10 }, everything else as registered', async () => {
  const m = await load();
  assert.equal(m.REGISTERED.studyId, '2026-10-twin-aa-real-2');
  assert.deepEqual([...m.REGISTERED.cells], ['AA']);
  assert.equal(m.REGISTERED.tickMs, 60_000);
  assert.equal(m.REGISTERED.warmupTicks, 15);
  assert.equal(m.REGISTERED.scoredTicks, 60);
  const arm = m.twinArm(60);
  const sign = arm.metrics.find((x: any) => x.kind === 'sign');
  const rate = arm.metrics.find((x: any) => x.kind === 'rate');
  assert.deepEqual(sign, { id: 'p99_latency', kind: 'sign', worse: 'higher', tolerance: 0.15, margin: { relative: 0.10 } });
  assert.deepEqual(rate, { id: 'http_5xx', kind: 'rate', worse: 'higher', tolerance: 0.2 });
  assert.equal(arm.canary_weight, 0.5);
  assert.equal(arm.alpha_rollback, 0.05);
  assert.equal(arm.alpha_proceed, 1e-12);
  assert.equal(arm.alpha_srm, 0.001);
});

test('twin-aa-real-2: the config needs the study id and exactly four tasks per arm (R5 as amended)', async () => {
  const m = await load();
  const cfg = {
    study_id: '2026-10-twin-aa-real-2', alb_idle_timeout_s: 60, lane: 0, region: 'eu-west-1',
    load_balancer: 'app/t3-alb/50dc6c495c0c9188',
    target_groups: { canary: 'targetgroup/t3-canary-new/aaaa1111', control: 'targetgroup/t3-baseline-old/bbbb2222' },
    tasks_per_arm: 4, gate: { base_url: 'http://127.0.0.1:8790', token_env: 'DS_GATE_SHARED_SECRET' },
  };
  assert.doesNotThrow(() => m.validateConfig(cfg));
  assert.throws(() => m.validateConfig({ ...cfg, tasks_per_arm: 2 }), /tasks_per_arm must be 4/);
  assert.throws(() => m.validateConfig({ ...cfg, study_id: '2026-10-twin-aa-real' }), /study_id/);
});

test('twin-aa-real-2: the runner differs from the first study\'s only on the registered lines', () => {
  const a = fs.readFileSync(V1, 'utf8').split('\n');
  const b = fs.readFileSync(V2, 'utf8').split('\n');
  // lines present in one file and not the other, ignoring the path and study-id substitutions
  const norm = (l: string) => l.replace(/twin-aa-real-2/g, 'twin-aa-real');
  const setA = new Set(a.map(norm)), setB = new Set(b.map(norm));
  const onlyB = b.map(norm).filter((l) => !setA.has(l));
  const onlyA = a.map(norm).filter((l) => !setB.has(l));
  assert.ok(onlyB.every((l) => /margin|2026-10-twin-aa-real-2|tasks_per_arm must be 4|cells: Object\.freeze\(\['AA'\]\)|first study's runner|registered deltas only|byte-identical otherwise/.test(l) || l.startsWith('//')), `unexpected lines only in v2:\n${onlyB.join('\n')}`);
  assert.ok(onlyA.every((l) => /tolerance: 0\.15 \}|cells: Object\.freeze\(\['AA', 'AB-5xx', 'AB-lat'\]\)|tasks_per_arm must be an integer >= 2/.test(l)), `unexpected lines only in v1:\n${onlyA.join('\n')}`);
  assert.ok(onlyA.length <= 3 && onlyB.length <= 8, `v1-only ${onlyA.length}, v2-only ${onlyB.length}`);
});
