// test/comparator-baseline-endpoints.test.ts — WS6.2 Task 7 endpoint-freeze
// tests: parses ENDPOINTS.md, runs a small smoke invocation of the CLI via
// execSync, and asserts (a) the emitted report's per-arm metric keys are
// EXACTLY the pre-registered set (ARM_REPORT_KEYS — no extras, no
// omissions), (b) `endpoints_sha256` matches a hash independently
// recomputed from the fenced JSON block (decoupled from
// _comparator-baseline-report.ts's own hashing so a bug there wouldn't be
// self-certifying), and (c) a frozen-param mismatch without
// --allow-nonregistered-params exits non-zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ARM_REPORT_KEYS, type ComparatorBaselineReport } from '../tools/_comparator-baseline-report';
import type { EndpointsSpec } from '../tools/_comparator-baseline-types';

const REPO_ROOT = path.join(__dirname, '..');
const ENDPOINTS_PATH = path.join(REPO_ROOT, 'runs', 'comparator-baseline', 'ENDPOINTS.md');
const CLI = path.join(REPO_ROOT, 'tools', 'run-comparator-baseline.ts');

function parsedEndpointsMd(): { spec: EndpointsSpec; sha256: string } {
  const md = fs.readFileSync(ENDPOINTS_PATH, 'utf8');
  const match = md.match(/```json\n([\s\S]*?)```/);
  assert.ok(match, 'ENDPOINTS.md must contain a fenced json block');
  const raw = match![1];
  return { spec: JSON.parse(raw) as EndpointsSpec, sha256: createHash('sha256').update(raw).digest('hex') };
}

function scratchPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comparator-baseline-endpoints-'));
  return path.join(dir, name);
}

function runCli(extraArgs: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [CLI, ...extraArgs], { cwd: REPO_ROOT, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// ── (a) + (b): smoke invocation, per-arm metric keys, endpoints_sha256 ──

test('endpoint-freeze: smoke run emits exactly the pre-registered per-arm metric keys and a correct endpoints_sha256', () => {
  const { spec, sha256 } = parsedEndpointsMd();
  const outPath = scratchPath('report.json');
  const summaryPath = scratchPath('summary.md');

  const result = runCli([
    '--out', outPath,
    '--summary', summaryPath,
    '--allow-nonregistered-params',
    '--healthy-windows', '8',
    '--tuning-windows', '16',
    '--repeats-per-profile', '1',
  ]);
  assert.equal(result.status, 0, `CLI smoke run must succeed; stderr:\n${result.stderr}`);

  const report = JSON.parse(fs.readFileSync(outPath, 'utf8')) as ComparatorBaselineReport;

  assert.equal(report.endpoints_version, spec.endpoints_version);
  assert.equal(report.endpoints_sha256, sha256, 'endpoints_sha256 must match an independently recomputed hash of the fenced JSON block');
  assert.equal(report.non_registered_run, true, 'a run with overridden window counts must be stamped non_registered_run:true');

  const expectedArmIds = [...spec.arms].sort();
  const actualArmIds = Object.keys(report.arms).sort();
  assert.deepEqual(actualArmIds, expectedArmIds, 'report.arms must contain exactly the frozen arm set');

  const expectedKeys = [...ARM_REPORT_KEYS].sort();
  for (const armId of actualArmIds) {
    const actualKeys = Object.keys(report.arms[armId]).sort();
    assert.deepEqual(actualKeys, expectedKeys, `arm "${armId}": metric keys must be exactly the pre-registered set (no extras, no omissions)`);
  }

  assert.ok(fs.existsSync(summaryPath), 'markdown summary must be written');
  const summary = fs.readFileSync(summaryPath, 'utf8');
  for (const armId of expectedArmIds) {
    assert.ok(summary.includes(armId), `summary table must mention arm "${armId}"`);
  }
});

// ── (c): frozen-param mismatch without the escape hatch exits non-zero ──

test('endpoint-freeze: a frozen-param mismatch without --allow-nonregistered-params exits non-zero and does not write a report', () => {
  const outPath = scratchPath('report.json');
  const summaryPath = scratchPath('summary.md');

  const result = runCli([
    '--out', outPath,
    '--summary', summaryPath,
    '--healthy-windows', '5', // disagrees with frozen_params.healthy_windows (131), no escape hatch
    '--tuning-windows', '5',
    '--repeats-per-profile', '0',
  ]);

  assert.notEqual(result.status, 0, 'CLI must exit non-zero on an unacknowledged frozen-param mismatch');
  assert.ok(/frozen/i.test(result.stderr), 'stderr should explain the frozen-param disagreement');
  assert.ok(!fs.existsSync(outPath), 'no report should be written when the run is refused');
});

test('endpoint-freeze: an --arms subset without --allow-nonregistered-params exits non-zero', () => {
  const outPath = scratchPath('report.json');
  const summaryPath = scratchPath('summary.md');

  const result = runCli([
    '--out', outPath,
    '--summary', summaryPath,
    '--arms', 'portfolio_alpha,portfolio_combined', // subset of the frozen arm list
    '--healthy-windows', '5',
    '--tuning-windows', '5',
    '--repeats-per-profile', '0',
  ]);

  assert.notEqual(result.status, 0, 'CLI must exit non-zero on an unacknowledged --arms subset');
  assert.ok(!fs.existsSync(outPath), 'no report should be written when the run is refused');
});
