// test/calibrate-guarantee-manifest-sidecar.test.ts — WS2 deliverable 3:
// tools/calibrate.ts must emit a `<config-basename>.guarantee-manifest.json`
// sidecar next to every CompiledConfig it writes, non-breaking (existing
// CLI output/behavior otherwise unchanged).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

function compile(outPath: string, extra: string[] = []): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
    + `--out ${outPath} ${extra.join(' ')}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
}

function manifestPathFor(outPath: string): string {
  return outPath.replace(/\.json$/, '') + '.guarantee-manifest.json';
}

test('calibrate CLI: existing CompiledConfig output is unchanged (non-breaking) '
  + 'while a guarantee-manifest sidecar is additionally written', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-ws2-sidecar-basic.json');
  compile(outPath, ['--families A,B,C,D,E']);

  // Existing behavior: the CompiledConfig itself still looks like a
  // CompiledConfig (spot-check a couple of fields the pre-WS2 tests
  // already assert on, e.g. compiled-config-family-b-optional.test.ts).
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(cfg.family_B, 'family_B still emitted (CLI default families include B)');
  assert.ok(cfg.alpha_budget, 'alpha_budget still emitted');
  assert.ok(cfg.compiler_version, 'compiler_version still emitted');

  // New behavior: the sidecar exists, next to the config, same basename.
  const manifestPath = manifestPathFor(outPath);
  assert.ok(fs.existsSync(manifestPath), `expected sidecar at ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 1);
  assert.deepEqual(manifest.alpha_budget, cfg.alpha_budget);
  assert.equal(manifest.compiler_version, cfg.compiler_version);
  assert.equal(manifest.config_version, cfg.version);
  assert.equal(manifest.baseline_ref, cfg.baseline_ref);
});

test('calibrate CLI: the sidecar\'s generated_at is the config\'s own compiled_at '
  + '(deterministic — calibrate\'s compiled_at defaults to a fixed epoch, not '
  + 'wall-clock, so two compiles of the same inputs produce byte-identical manifests)', () => {
  const outPathA = path.join(REPO_ROOT, 'runs/compiled-configs/test-ws2-sidecar-detA.json');
  const outPathB = path.join(REPO_ROOT, 'runs/compiled-configs/test-ws2-sidecar-detB.json');
  compile(outPathA, ['--families A,B,C,D,E']);
  compile(outPathB, ['--families A,B,C,D,E']);

  const cfgA = JSON.parse(fs.readFileSync(outPathA, 'utf8'));
  const manifestA = JSON.parse(fs.readFileSync(manifestPathFor(outPathA), 'utf8'));
  const manifestB = JSON.parse(fs.readFileSync(manifestPathFor(outPathB), 'utf8'));

  assert.equal(manifestA.generated_at, cfgA.compiled_at);
  assert.deepEqual(manifestA, manifestB, 'identical compile inputs → byte-identical manifests');
});

test('calibrate CLI: sidecar reports the CONFIGURED reality (Family E kind actually '
  + 'compiled from synthetic-v1, not an assumed default)', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-ws2-sidecar-familye.json');
  compile(outPath, ['--families A,B,C,D,E']);
  const manifest = JSON.parse(fs.readFileSync(manifestPathFor(outPath), 'utf8'));
  const conformal = manifest.families.E.detectors[0];
  assert.ok(conformal.cell_counts, 'Family E entry carries configured cell_counts');
  assert.equal(
    Object.values(conformal.cell_counts as Record<string, number>)
      .reduce((a: number, b: number) => a + b, 0),
    conformal.cell_total,
    'cell_counts sums to cell_total',
  );
});
