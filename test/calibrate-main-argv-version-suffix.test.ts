// test/calibrate-main-argv-version-suffix.test.ts — R2 Task 3.
//
// main(argv) programmatic invocation (mirrors _recalibrate-cli.ts's
// main(argv = process.argv.slice(2)) pattern) + --version_suffix. The
// repo's tool-to-tool convention is direct function import, not
// spawning a child process — this is what the refresh orchestrator
// (R2 Task 7, out of this scope) will rely on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { main } from '../tools/calibrate/_calibrate-main';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

test('main(argv): programmatic invocation compiles without touching process.argv', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-calibrate-main-argv-'));
  const outPath = path.join(outDir, 'compiled.json');
  return main(['--baseline', BASELINE, '--alpha', '1e-3', '--families', 'B', '--out', outPath]).then(() => {
    const config = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(config.version, 'v1-legacy-equivalent');
  });
});

test('main(argv): --version_suffix appends to the derived version string', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-calibrate-main-argv-'));
  const outPath = path.join(outDir, 'compiled.json');
  return main([
    '--baseline', BASELINE, '--alpha', '1e-3', '--families', 'B', '--out', outPath,
    '--version_suffix', 'refresh-candidate-1',
  ]).then(() => {
    const config = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.ok(config.version.endsWith('+refresh-candidate-1'),
      `expected version to end with +refresh-candidate-1, got ${config.version}`);
    assert.equal(config.version, 'v1-legacy-equivalent+refresh-candidate-1');
  });
});

test('main(argv): absence of --version_suffix leaves the version string unchanged (determinism guard)', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-calibrate-main-argv-'));
  const outPath = path.join(outDir, 'compiled.json');
  return main(['--baseline', BASELINE, '--alpha', '1e-3', '--families', 'B', '--out', outPath]).then(() => {
    const config = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(config.version, 'v1-legacy-equivalent');
    assert.ok(!config.version.includes('+'));
  });
});
