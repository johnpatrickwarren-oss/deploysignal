// test/calibrate-bonferroni-floor.test.ts — PR #112 fix round 1.
//
// The calibrator stamped bonferroni_factor = family_a_signals.length and split the Family A α by
// the same length (tools/calibrate/_calibrate-config-build.ts emitFamilyABlock,
// tools/calibrate/_calibrate-family-d-stamp.ts stampBettingSlidingBufferAll). A twin profile has an
// empty sli_list, so the factor was 0 and every split divided by zero (validPathAlpha: 0/0 = NaN).
// The factor is now floored at 1, matching engine v0.12.1-pre familyABonferroni.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { emitFamilyABlock } from '../tools/calibrate/_calibrate-config-build';
import { validPathAlpha } from '../dist/engine/gates/_health-valid-path';

const ROOT = path.resolve(__dirname, '..');

test('compiling twin-generic yields bonferroni_factor 1 and a finite validPathAlpha', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-bonf-floor-'));
  const out = path.join(dir, 'twin.json');
  execFileSync('node', [path.join(ROOT, 'tools', 'calibrate.js'),
    '--baseline', path.join(ROOT, 'runs', 'baselines', 'synthetic-v1'),
    '--alpha', '0', '--families', 'A,B', '--profile_ref', 'twin-generic@1.0.0', '--out', out,
  ], { cwd: ROOT, stdio: 'pipe' });
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(cfg.family_a_signals, []);
  assert.equal(cfg.bonferroni_factor, 1);
  const a = validPathAlpha(cfg);
  assert.ok(Number.isFinite(a), `validPathAlpha is ${a}`);
  assert.equal(a, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

function familyAArgs(signals: string[], alphaA: number) {
  const perSignal = { q: { baseline_mean: 0, baseline_sigma_squared: 1, tau_squared: 1, delta_min: 1 } };
  return {
    config: {} as never,
    baselineCells: { dimensions: [], cells: [], aggregate_fallback: { family_A: { per_signal: perSignal } } } as never,
    compileDefaults: { family_a_signals: signals } as never,
    effective: null, tenantTierMap: null, tenantTierConfig: {} as never, alphaA,
  };
}

test('emitFamilyABlock: an empty signal list stamps factor 1 and a finite per-signal betting α', () => {
  for (const alphaA of [0, 4e-4]) {
    const args = familyAArgs([], alphaA);
    emitFamilyABlock(args);
    const cfg = args.config as { bonferroni_factor: number };
    assert.equal(cfg.bonferroni_factor, 1);
    const stamped = (args.baselineCells as { aggregate_fallback: { family_A: { per_signal: { q: { betting_e_process_alpha: number } } } } })
      .aggregate_fallback.family_A.per_signal.q.betting_e_process_alpha;
    assert.ok(Number.isFinite(stamped), `α_A ${alphaA}: betting α is ${stamped}`);
    assert.equal(stamped, alphaA * 0.5);
  }
});

test('emitFamilyABlock: a non-empty list is unchanged (factor = length, betting α = α_A / N / 2)', () => {
  const args = familyAArgs(['a', 'b', 'c', 'd'], 4e-4);
  emitFamilyABlock(args);
  assert.equal((args.config as { bonferroni_factor: number }).bonferroni_factor, 4);
  const stamped = (args.baselineCells as { aggregate_fallback: { family_A: { per_signal: { q: { betting_e_process_alpha: number } } } } })
    .aggregate_fallback.family_A.per_signal.q.betting_e_process_alpha;
  assert.equal(stamped, (4e-4 / 4) * 0.5);
});
