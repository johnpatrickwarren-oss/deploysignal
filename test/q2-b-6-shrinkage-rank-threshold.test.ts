// test/q2-b-6-shrinkage-rank-threshold.test.ts — Q2.B.6a regression
// test per ARCHITECT-REPLY-Q2-B-5-DISPOSITION §57-66.
//
// Verifies that post-Q2.B.6a, every cell's `family_C.shrinkage_alpha`
// is binary {0, 1}. Q2.B.4 introduced fractional α via convex blending
// `α = clamp(n / mcdFloor, 0, 1)`; Q2.B.6a drops the blend in favor of
// a binary rank-sufficient threshold (n ≥ p+1 → α=1, Σ_pc;
// n < p+1 → α=0, Σ_aggregate). Discontinuity is intentional —
// architect §61 picked the simpler "rank-sufficient vs rank-deficient"
// semantic over the smooth-shrinkage convex blend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CFG_PATH = path.join(process.cwd(),
  'runs/compiled-configs/v5.3-q2b6.json');

test('Q2.B.6a shrinkage_alpha ∈ {0, 1} per cell (no fractional values)', () => {
  if (!fs.existsSync(CFG_PATH)) {
    console.log(`[Q2.B.6a test] skip — ${CFG_PATH} not yet emitted; recompile first.`);
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const cells = cfg.baseline_cells?.cells ?? [];
  let total = 0;
  let fractional = 0;
  let zeroCount = 0;
  let oneCount = 0;
  const fractionalSamples: Array<{ key: unknown; alpha: number }> = [];
  for (const c of cells) {
    const a = c.family_C?.shrinkage_alpha;
    if (a === undefined) continue;
    total++;
    if (a === 0) zeroCount++;
    else if (a === 1) oneCount++;
    else {
      fractional++;
      if (fractionalSamples.length < 3) fractionalSamples.push({ key: c.key, alpha: a });
    }
  }
  assert.equal(fractional, 0,
    `Q2.B.6a: ${fractional}/${total} cells have fractional shrinkage_alpha; `
    + `samples: ${JSON.stringify(fractionalSamples)}`);
  assert.ok(total > 0, 'Q2.B.6a: no cells with shrinkage_alpha emitted; substrate empty?');
});

test('Q2.B.6a aggregate_fallback_used iff shrinkage_alpha === 0', () => {
  if (!fs.existsSync(CFG_PATH)) return;
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const cells = cfg.baseline_cells?.cells ?? [];
  for (const c of cells) {
    const fc = c.family_C;
    if (!fc || fc.shrinkage_alpha === undefined) continue;
    const aggUsed = fc.aggregate_fallback_used === true;
    const expected = fc.shrinkage_alpha === 0;
    assert.equal(aggUsed, expected,
      `Q2.B.6a: cell ${JSON.stringify(c.key)}: `
      + `aggregate_fallback_used=${aggUsed}, expected=${expected} `
      + `(shrinkage_alpha=${fc.shrinkage_alpha}; binary semantic dictates `
      + `flag=true iff alpha=0)`);
  }
});

test('Q2.B.6a applyAggregateShrinkage: rankFloor selects {Σ_pc, Σ_aggregate}', () => {
  // Spot-check at the function level (the semantics already verified in
  // calibration-coherence.test.ts; this is a per-Q2.B.6 PR regression
  // sentinel against any future re-introduction of fractional blending).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { applyAggregateShrinkage } = require('../tools/calibrators/family-c.js');
  const perCell = [[1, 0], [0, 1]];
  const aggregate = [[10, 0], [0, 10]];
  // n at the boundary
  const at = applyAggregateShrinkage(perCell, aggregate, 12, 12);
  assert.equal(at.alpha, 1);
  assert.deepStrictEqual(at.cov, perCell);
  // n one below boundary
  const below = applyAggregateShrinkage(perCell, aggregate, 11, 12);
  assert.equal(below.alpha, 0);
  assert.deepStrictEqual(below.cov, aggregate);
});
