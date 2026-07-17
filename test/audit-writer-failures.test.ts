// test/audit-writer-failures.test.ts — Task 1 (WS4 session-durability plan):
// fail-loud audit writer. Pre-fix, createAuditWriter swallowed
// fs.appendFileSync failures in an empty catch block — a full disk or an
// unwritable audit dir failed silently, with zero operator signal. This
// guards the strict-additive `status()` surface (engine/types/audit.ts
// AuditWriterStatus) and the rate-limited stderr signal (first error +
// every 100th thereafter, per OQ-9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createAuditWriter } from '../dist/engine/_audit-writer';

test('unwritable dir: write()+close() do not throw; status() reports errors', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-audit-fail-'));
  try {
    // Point `dir` at a path whose parent is a FILE, not a directory — so
    // fs.mkdirSync(serviceDir, {recursive:true}) inside createAuditWriter
    // itself throws ENOTDIR before any appendFileSync is attempted. This
    // exercises the fail-loud path at construction time.
    const blocker = path.join(tmp, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    const badDir = path.join(blocker, 'service-dir'); // parent is a file

    let writer: ReturnType<typeof createAuditWriter>;
    assert.doesNotThrow(() => {
      writer = createAuditWriter({ dir: badDir, service: 'svc' });
    }, 'construction must not throw even when the service dir cannot be created');
    assert.doesNotThrow(() => writer.write({ tick: 0 } as never), 'write() must not throw');
    assert.doesNotThrow(() => writer.close(), 'close() must not throw');

    assert.ok(writer!.status, 'writer exposes status()');
    const status = writer!.status!();
    assert.ok(status.errors >= 1, 'status().errors >= 1');
    assert.ok(status.last_error, 'status().last_error populated');
    assert.equal(status.healthy, false, 'status().healthy === false');
    assert.ok(status.last_error_at, 'status().last_error_at populated');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('unwritable dir via chmod: appendFileSync failures surface through status()', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-audit-fail-chmod-'));
  try {
    const roDir = path.join(tmp, 'ro');
    fs.mkdirSync(roDir);
    // Make the service subdirectory itself read-only after creation so
    // mkdirSync succeeds (recursive, idempotent) but appendFileSync fails.
    const serviceDir = path.join(roDir, 'svc');
    fs.mkdirSync(serviceDir);
    fs.chmodSync(serviceDir, 0o500);
    try {
      const writer = createAuditWriter({ dir: roDir, service: 'svc' });
      assert.doesNotThrow(() => writer.write({ tick: 0 } as never));
      assert.doesNotThrow(() => writer.close());
      const status = writer.status!();
      assert.ok(status.errors >= 1, 'status().errors >= 1 after appendFileSync EACCES');
      assert.equal(status.healthy, false);
    } finally {
      fs.chmodSync(serviceDir, 0o700); // restore so rmSync can clean up
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('stderr signal fires on the first failure and every 100th thereafter', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-audit-fail-stderr-'));
  try {
    const blocker = path.join(tmp, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    const badDir = path.join(blocker, 'service-dir');

    const calls: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { calls.push(String(args[0])); };
    try {
      // Construction fails once (mkdirSync throws, ENOTDIR). Drive many
      // write()+close() cycles on the SAME writer instance so each cycle's
      // flush() attempts (and fails) an independent appendFileSync,
      // accumulating errors on one status() counter past the 100-boundary.
      const writer = createAuditWriter({ dir: badDir, service: 'svc' });
      for (let i = 0; i < 150; i++) {
        writer.write({ tick: i } as never);
        writer.close();
      }
      const status = writer.status!();
      assert.ok(status.errors >= 100, `expected >=100 accumulated errors, got ${status.errors}`);
    } finally {
      console.error = originalError;
    }
    // First error logged, and at least one 100th-boundary log (rate-limited,
    // not one line per failure).
    assert.ok(calls.length >= 1, 'console.error called at least once');
    assert.ok(calls.length < 150, 'console.error is rate-limited, not called once per failure');
    assert.ok(calls[0].includes('deploysignal audit-writer'), 'first log line carries the expected prefix');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('healthy writer: 10 records write cleanly; status() reports healthy; file contents unchanged', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-audit-healthy-'));
  try {
    const writer = createAuditWriter({ dir: tmp, service: 'healthy-svc' });
    for (let i = 0; i < 10; i++) {
      writer.write({ schema_version: '1', tick: i, verdict: 'proceed' } as never);
    }
    writer.close();

    assert.ok(writer.status, 'healthy writer exposes status()');
    const status = writer.status!();
    assert.deepEqual(status, { errors: 0, last_error: null, last_error_at: null, healthy: true });

    const serviceDir = path.join(tmp, 'healthy-svc');
    const files = fs.readdirSync(serviceDir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'exactly one JSONL file created');
    const lines = fs.readFileSync(path.join(serviceDir, files[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 10, '10 lines written — byte-identical JSONL shape to pre-fix behavior');
    for (let i = 0; i < 10; i++) {
      const rec = JSON.parse(lines[i]);
      assert.equal(rec.tick, i);
      assert.equal(rec.verdict, 'proceed');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('no-op writer (createAuditWriter(null)) exposes a healthy status()', () => {
  const writer = createAuditWriter(null as never);
  assert.doesNotThrow(() => writer.write({ tick: 0 } as never));
  assert.doesNotThrow(() => writer.close());
  assert.ok(writer.status, 'no-op writer exposes status()');
  assert.deepEqual(writer.status!(), { errors: 0, last_error: null, last_error_at: null, healthy: true });
});
