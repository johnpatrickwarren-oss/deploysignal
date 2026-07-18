// test/calibrate-load-bundle-timestamp-provenance.test.ts — R2 Task 2.
//
// loadBundle round-trip coverage for the additive bundle-schema
// extension: manifest.tick_seconds + manifest.baseline_provenance
// threaded onto BaselineBundle; per-run start_iso comes along for free
// (parsed verbatim from bundle.jsonl rows). All fields optional;
// absence preserves current behavior exactly (byte-identical for every
// checked-in bundle today, none of which carry tick_seconds).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadBundle } from '../tools/calibrate/_calibrate-data-prep';

function writeBundle(dir: string, manifest: Record<string, unknown>, rows: Record<string, unknown>[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'bundle.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('loadBundle: tick_seconds + baseline_provenance absent on a legacy manifest (current behavior preserved)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-loadbundle-'));
  writeBundle(dir, { version: 'legacy-v1', generated_at: '1970-01-01T00:00:00.000Z', seed: 1, cell_dim: 'hour_of_day' }, [
    { tenant_id: 'aggregate', hour_of_day: [0, 1], signal_series: { p99_latency: [1, 2] } },
  ]);
  const bundle = loadBundle(dir);
  assert.equal(bundle.tick_seconds, undefined);
  assert.equal(bundle.baseline_provenance, undefined);
  assert.equal(bundle.runs[0].start_iso, undefined);
  assert.equal(bundle.version, 'legacy-v1');
});

test('loadBundle: tick_seconds + baseline_provenance threaded from manifest when present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-loadbundle-'));
  writeBundle(dir, {
    version: 'real-v1', generated_at: '2026-07-01T00:00:00.000Z', seed: 2,
    cell_dim: 'hour_of_day', tick_seconds: 3600, baseline_provenance: 'real_burstgpt',
  }, [
    { tenant_id: 'aggregate', hour_of_day: [0, 1], signal_series: { p99_latency: [1, 2] }, start_iso: '2026-07-01T00:00:00Z' },
  ]);
  const bundle = loadBundle(dir);
  assert.equal(bundle.tick_seconds, 3600);
  assert.equal(bundle.baseline_provenance, 'real_burstgpt');
  assert.equal(bundle.runs[0].start_iso, '2026-07-01T00:00:00Z');
});

test('loadBundle: per-run start_iso threaded verbatim even when manifest.tick_seconds is absent (mixed presence is a selection-time concern, not a load-time one)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-loadbundle-'));
  writeBundle(dir, { version: 'mixed-v1', generated_at: '2026-07-01T00:00:00.000Z', seed: 3, cell_dim: 'hour_of_day' }, [
    { tenant_id: 'aggregate', hour_of_day: [0, 1], signal_series: { p99_latency: [1, 2] }, start_iso: '2026-07-01T00:00:00Z' },
  ]);
  const bundle = loadBundle(dir);
  assert.equal(bundle.tick_seconds, undefined);
  assert.equal(bundle.runs[0].start_iso, '2026-07-01T00:00:00Z');
});
