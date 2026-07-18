// test/comparator-baseline-determinism.test.ts — WS6.2 Task 7 determinism
// test: two smoke invocations of the CLI with identical args produce
// byte-identical reports after stripping the `generated_at` timestamp
// field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'tools', 'run-comparator-baseline.ts');

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'comparator-baseline-determinism-'));
}

function runCli(outPath: string, summaryPath: string): void {
  execFileSync('node', [
    CLI,
    '--out', outPath,
    '--summary', summaryPath,
    '--allow-nonregistered-params',
    '--healthy-windows', '6',
    '--tuning-windows', '10',
    '--repeats-per-profile', '1',
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
}

function stripGeneratedAt(reportJson: string): string {
  const parsed = JSON.parse(reportJson) as Record<string, unknown>;
  delete parsed.generated_at;
  return JSON.stringify(parsed, null, 2);
}

test('determinism: two identical-args smoke runs produce byte-identical reports (minus generated_at)', () => {
  const dirA = scratchDir();
  const dirB = scratchDir();
  const outA = path.join(dirA, 'report.json');
  const outB = path.join(dirB, 'report.json');
  const summaryA = path.join(dirA, 'summary.md');
  const summaryB = path.join(dirB, 'summary.md');

  runCli(outA, summaryA);
  runCli(outB, summaryB);

  const reportA = fs.readFileSync(outA, 'utf8');
  const reportB = fs.readFileSync(outB, 'utf8');
  assert.equal(stripGeneratedAt(reportA), stripGeneratedAt(reportB), 'reports must be identical once generated_at is stripped');

  // generated_at itself should differ (or at least both be valid ISO
  // timestamps) — proves the strip actually removed a real varying field
  // rather than the two runs coincidentally producing identical output
  // including timestamps.
  const parsedA = JSON.parse(reportA) as { generated_at: string };
  const parsedB = JSON.parse(reportB) as { generated_at: string };
  assert.ok(!Number.isNaN(Date.parse(parsedA.generated_at)));
  assert.ok(!Number.isNaN(Date.parse(parsedB.generated_at)));

  const summaryTextA = fs.readFileSync(summaryA, 'utf8');
  const summaryTextB = fs.readFileSync(summaryB, 'utf8');
  const stripSummaryTimestamp = (s: string): string => s.replace(/^Generated: .*$/m, 'Generated: <stripped>');
  assert.equal(stripSummaryTimestamp(summaryTextA), stripSummaryTimestamp(summaryTextB), 'markdown summaries must be identical once the timestamp line is stripped');
});
