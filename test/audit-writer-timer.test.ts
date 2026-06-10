// test/audit-writer-timer.test.ts — Remediation L2 regression guard.
//
// createAuditWriter starts a 500ms flush setInterval. Pre-fix it was never
// unref()'d, so any CLI/tool that created a writer and forgot close() hung
// at exit forever. The timer must not keep the event loop alive on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('audit writer flush timer does not keep the process alive when close() is skipped', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-audit-unref-'));
  const script = `
    const { createAuditWriter } = require(${JSON.stringify(path.resolve(__dirname, '..', 'dist', 'engine', '_audit-writer'))});
    const w = createAuditWriter({ dir: ${JSON.stringify(tmp)}, service: 'unref-test' });
    w.write({ ts: new Date().toISOString(), verdict: 'proceed' });
    // Deliberately no w.close() — process must still exit naturally.
  `;
  const started = Date.now();
  try {
    // If the timer is not unref'd this child never exits and execFileSync
    // throws on the 5s timeout instead.
    execFileSync(process.execPath, ['-e', script], { timeout: 5000 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `child should exit naturally, took ${elapsed}ms`);
});

test('audit writer flushes buffered records to the file matching their write-time date', () => {
  // Attribution contract: each record is stamped with the UTC date at
  // write() time and flushed to that date's file, so a flush that crosses
  // a rotation boundary cannot drag pre-boundary records into the new file.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-audit-date-'));
  try {
    const { createAuditWriter } = require(path.resolve(__dirname, '..', 'dist', 'engine', '_audit-writer'));
    const w = createAuditWriter({ dir: tmp, service: 'svc' });
    w.write({ ts: new Date().toISOString(), verdict: 'proceed' });
    w.close();
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(tmp, 'svc', today + '.jsonl');
    assert.ok(fs.existsSync(file), `expected ${file} to exist`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).verdict, 'proceed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
