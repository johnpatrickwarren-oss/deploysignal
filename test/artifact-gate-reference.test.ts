// test/artifact-gate-reference.test.ts — the artifact policy gate counts observations on
// p99_latency when it is buffered and otherwise on the longest-buffered signal. Before 2026-09-28
// it read p99_latency only, so a profile without p99 never fired a critical artifact finding.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROLLBACK_DEFS } from '../dist/engine/gates/_health-defs';

const engine = require('../shared');
const { TrendBuffer } = engine;

const artifact = ROLLBACK_DEFS.find((d) => d.id === 'artifact')!;
const FLAGS = { artifact_content: true, artifact_severity: 'critical' };

function buffer(series: Record<string, number>): InstanceType<typeof TrendBuffer> {
  const tb = new TrendBuffer(10);
  for (const [k, n] of Object.entries(series)) for (let i = 0; i < n; i++) tb.push(k, 100 + (i % 2));
  return tb;
}

const fires = (tb: unknown, flags: Record<string, unknown> = FLAGS): boolean =>
  artifact.check({} as never, {} as never, flags as never, { thresholds: {} } as never, tb as never);

test('artifact: p99_latency buffered — fires at 4 observations, not at 3 (unchanged)', () => {
  assert.equal(fires(buffer({ p99_latency: 4 })), true);
  assert.equal(fires(buffer({ p99_latency: 3 })), false);
});

test('artifact: p99_latency preferred when buffered, even if another signal has more observations', () => {
  assert.equal(fires(buffer({ p99_latency: 3, http_5xx_rate: 10 })), false);
});

test('artifact: no p99_latency — counts on the longest-buffered signal', () => {
  assert.equal(fires(buffer({ http_5xx_rate: 4 })), true);
  assert.equal(fires(buffer({ http_5xx_rate: 2, queue_depth: 4 })), true);
  assert.equal(fires(buffer({ http_5xx_rate: 3 })), false);
});

test('artifact: nothing buffered, no buffer, or no flag — no fire', () => {
  assert.equal(fires(buffer({})), false);
  assert.equal(fires(null), false);
  assert.equal(fires(buffer({ http_5xx_rate: 10 }), { artifact_content: false }), false);
});
