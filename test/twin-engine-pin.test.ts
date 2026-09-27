// test/twin-engine-pin.test.ts — Plan B Task 1: the engine is pinned at v0.12.0-pre, the first tag
// that carries the randomized twin (engine ADR 0036: detectors/twin-contrast.ts,
// per-shard/twin-gate.ts, per-shard/twin-planning.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

test('Plan B: package.json pins the engine at #v0.12.0-pre and the installed copy is 0.12.0-pre', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const spec: string = pkg.dependencies['@johnpatrickwarren-oss/deploysignal-engine'];
  assert.ok(spec.endsWith('#v0.12.0-pre'), `engine pin is ${spec}`);
  const installed = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'package.json'), 'utf8'));
  assert.equal(installed.version, '0.12.0-pre');
});

test('Plan B: the twin library entry points resolve through the package export map', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const gate = require('@johnpatrickwarren-oss/deploysignal-engine/per-shard/twin-gate');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const planning = require('@johnpatrickwarren-oss/deploysignal-engine/per-shard/twin-planning');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const contrast = require('@johnpatrickwarren-oss/deploysignal-engine/detectors/twin-contrast');
  assert.equal(typeof gate.initTwinGate, 'function');
  assert.equal(typeof gate.stepTwinGate, 'function');
  assert.equal(typeof gate.checkTwinGateConfig, 'function');
  assert.equal(typeof planning.ticksToDetect, 'function');
  assert.equal(typeof contrast.checkTwinMetricSpec, 'function');
});
