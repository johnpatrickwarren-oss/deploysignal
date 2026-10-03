// studies/twin-aa-onebox (PREREGISTRATION.md §1, Amendment 1): the runner is the second study's with the
// study id and one task per arm; the lane template can pin each arm to one subnet and defaults to both; the
// rotation script allows one task per arm only when told so; the analysis carries the registered placement
// and bars. The first study's test file covers the shared runner behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ROOT = path.join(__dirname, '..');
const V2 = path.join(ROOT, 'studies', 'twin-aa-real-2', 'harness', 'run-real.mjs');
const OB = path.join(ROOT, 'studies', 'twin-aa-onebox', 'harness', 'run-real.mjs');
const LANE = path.join(ROOT, 'studies', 'twin-aa-real', 'infra', 'cloudformation', 'lane.yaml');
const ROTATE = path.join(ROOT, 'studies', 'twin-aa-real', 'infra', 'scripts', 'rotate-arms.sh');
const ANALYZE = path.join(ROOT, 'studies', 'twin-aa-onebox', 'analysis', 'analyze.mjs');

test('twin-aa-onebox: study id, AA only, the 10% margin, exactly one task per arm', async () => {
  const m: any = await import(OB);
  assert.equal(m.REGISTERED.studyId, '2026-10-twin-aa-onebox');
  assert.deepEqual([...m.REGISTERED.cells], ['AA']);
  const sign = m.twinArm(60).metrics.find((x: any) => x.kind === 'sign');
  assert.deepEqual(sign, { id: 'p99_latency', kind: 'sign', worse: 'higher', tolerance: 0.15, margin: { relative: 0.10 } });
  const cfg = {
    study_id: '2026-10-twin-aa-onebox', alb_idle_timeout_s: 60, lane: 2, region: 'eu-west-1',
    load_balancer: 'app/t3-alb/50dc6c495c0c9188',
    target_groups: { canary: 'targetgroup/t3-canary-new/aaaa1111', control: 'targetgroup/t3-baseline-old/bbbb2222' },
    tasks_per_arm: 1, gate: { base_url: 'http://127.0.0.1:8790', token_env: 'DS_GATE_SHARED_SECRET' },
  };
  assert.doesNotThrow(() => m.validateConfig(cfg));
  assert.throws(() => m.validateConfig({ ...cfg, tasks_per_arm: 4 }), /tasks_per_arm must be 1/);
  assert.throws(() => m.validateConfig({ ...cfg, study_id: '2026-10-twin-aa-real-2' }), /study_id/);
});

test('twin-aa-onebox: the runner differs from the second study\'s only in the study id, the task count and comments', () => {
  const norm = (l: string) => l.replace(/twin-aa-onebox/g, 'twin-aa-real-2');
  const a = fs.readFileSync(V2, 'utf8').split('\n').map(norm);
  const b = fs.readFileSync(OB, 'utf8').split('\n').map(norm);
  const setA = new Set(a), setB = new Set(b);
  const onlyB = b.filter((l) => !setA.has(l));
  const onlyA = a.filter((l) => !setB.has(l));
  assert.ok(onlyB.every((l) => l.startsWith('//') || /tasks_per_arm === 1/.test(l)), `unexpected lines only in this study's runner:\n${onlyB.join('\n')}`);
  assert.ok(onlyA.every((l) => l.startsWith('//') || /tasks_per_arm === 4/.test(l)), `unexpected lines only in the second study's runner:\n${onlyA.join('\n')}`);
});

test('twin-aa-onebox: the lane template pins an arm to one subnet only when asked, and defaults to both', () => {
  const y = fs.readFileSync(LANE, 'utf8');
  for (const p of ['BaselineSubnetIndex', 'CanarySubnetIndex']) {
    assert.match(y, new RegExp(`  ${p}:\\n    Type: String\\n    Default: ""\\n    AllowedValues: \\["", "0", "1"\\]`), `${p} must default to empty and allow only 0 or 1`);
  }
  assert.match(y, /BaselinePinned: !Not \[!Equals \[!Ref BaselineSubnetIndex, ""\]\]/);
  assert.match(y, /CanaryPinned: !Not \[!Equals \[!Ref CanarySubnetIndex, ""\]\]/);
  assert.equal((y.match(/Subnets: !If \[BaselinePinned, \[!Select \[!Ref BaselineSubnetIndex,/g) ?? []).length, 1);
  assert.equal((y.match(/Subnets: !If \[CanaryPinned, \[!Select \[!Ref CanarySubnetIndex,/g) ?? []).length, 1);
  // prod-old and the load balancer stay on both subnets
  assert.equal((y.match(/^ +Subnets: !Split \[",", \{ "Fn::ImportValue": !Sub "\$\{NetworkStack\}-SubnetIds" \}\]$/gm) ?? []).length, 2);
});

test('twin-aa-onebox: rotate-arms.sh takes one task per arm only with ALLOW_ONEBOX=1', () => {
  const s = fs.readFileSync(ROTATE, 'utf8');
  assert.match(s, /\[ "\$TASKS" -ge 2 \] \|\| \{ \[ "\$TASKS" -eq 1 \] && \[ "\$\{ALLOW_ONEBOX:-\}" = "1" \]; \}/);
});

test('twin-aa-onebox: the analysis carries the registered placement and Amendment 1\'s bars', () => {
  const s = fs.readFileSync(ANALYZE, 'utf8');
  assert.match(s, /0: \{ stratum: 'S', baseline: 'us-east-1a', canary: 'us-east-1a' \}/);
  assert.match(s, /1: \{ stratum: 'S', baseline: 'us-east-1b', canary: 'us-east-1b' \}/);
  assert.match(s, /2: \{ stratum: 'X', baseline: 'us-east-1a', canary: 'us-east-1b' \}/);
  assert.match(s, /3: \{ stratum: 'X', baseline: 'us-east-1b', canary: 'us-east-1a' \}/);
  assert.match(s, /R: 100, B: 0\.1062, max_rollbacks: 10, stop_after_rollbacks: 11, attempt_cap: 150/);
  // Amendment 3: lane-less ECS TaskCreated events never decide a void; only events naming the lane do
  assert.match(s, /events_inside: inside\.filter\(\(e\) => e\.lane === s\.lane\)/);
  assert.ok(!/attribute\(e\)/.test(s), 'no nearest-scale attribution');
});
