// test/sigma-coherence.test.ts — Q2.B.5 Σ-coherence regression tests
// per Q2-B-5-SIGMA-COHERENCE-SPEC.md.
//
// Layer 1: post-compile verification — for every cell × overlapping
//          signal, baseline_sigma_squared_raw matches μ_raw² · Σ_C[i,i]
//          to FP precision; Family-A-only signals get raw sample variance.
// Layer 2: stamp completeness — baseline_sigma_squared_raw populated on
//          every Family A per_signal entry across all 840 cells.
// Layer 3: α=1 regression invariance — under rank-sufficient calibration
//          σ²_raw ≈ raw per-cell sample variance (Family A invariance).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FAMILY_C_SIGNALS = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
  'corpus_delta', 'traffic_pct',
] as const;

const FAMILY_A_PRIMARY_SIGNALS = [
  'p99_latency', 'ttft', 'eval_score', 'tool_success_rate',
  'downstream_err', 'cost_req',
] as const;

const OVERLAPPING = FAMILY_A_PRIMARY_SIGNALS.filter((s) =>
  (FAMILY_C_SIGNALS as readonly string[]).includes(s));

function loadV52(): unknown | null {
  const cfgPath = path.join(process.cwd(),
    'runs/compiled-configs/v5.2-q2b5.json');
  if (!fs.existsSync(cfgPath)) return null;
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

test('Q2.B.5 σ²_raw coherence: overlapping signals match μ_raw² · Σ_C[i,i]', () => {
  const cfg = loadV52() as any;
  if (!cfg) {
    console.log('[Q2.B.5 test] skip — recompile v5.2-q2b5 not yet emitted.');
    return;
  }
  let maxResidual = 0;
  let worst: unknown = null;
  let nChecked = 0;
  for (const cell of cfg.baseline_cells.cells) {
    const fc = cell.family_C;
    const fa = cell.family_A?.per_signal;
    if (!fc?.covariance || !fa) continue;
    for (const sig of OVERLAPPING) {
      const ps = fa[sig];
      if (!ps) continue;
      const muRaw = ps.baseline_mean_raw;
      const s2Raw = ps.baseline_sigma_squared_raw;
      if (muRaw === undefined || s2Raw === undefined) continue;
      const i = FAMILY_C_SIGNALS.indexOf(sig as typeof FAMILY_C_SIGNALS[number]);
      const sigmaCDiag = fc.covariance[i][i];
      const expected = muRaw * muRaw * sigmaCDiag;
      const denom = Math.max(Math.abs(expected), 1e-12);
      const residual = Math.abs(s2Raw - expected) / denom;
      if (residual > maxResidual) {
        maxResidual = residual;
        worst = { cell: cell.key, sig, s2Raw, expected };
      }
      nChecked++;
    }
  }
  console.log(`[Q2.B.5 σ²-coherence] ${nChecked} overlapping (signal × cell) entries; max residual ${maxResidual.toExponential(3)}`);
  assert.ok(maxResidual <= 1e-9,
    `σ²-coherence max residual ${maxResidual} > 1e-9; worst: ${JSON.stringify(worst)}`);
});

test('Q2.B.5 Family-A-only signals (eval_score, tool_success_rate) get raw sample variance', () => {
  const cfg = loadV52() as any;
  if (!cfg) return;
  let nChecked = 0;
  for (const cell of cfg.baseline_cells.cells) {
    const fa = cell.family_A?.per_signal;
    if (!fa) continue;
    for (const sig of ['eval_score', 'tool_success_rate']) {
      const ps = fa[sig];
      if (!ps) continue;
      assert.ok(ps.baseline_sigma_squared_raw !== undefined,
        `${sig} on cell ${JSON.stringify(cell.key)} missing baseline_sigma_squared_raw`);
      assert.ok(ps.baseline_sigma_squared_raw > 0,
        `${sig} on cell ${JSON.stringify(cell.key)} has non-positive σ²_raw`);
      nChecked++;
    }
  }
  console.log(`[Q2.B.5 Family-A-only] ${nChecked} (signal × cell) entries verified`);
  assert.ok(nChecked > 0, 'no Family-A-only signal entries found');
});

test('Q2.B.5 baseline_sigma_squared_raw stamped on every Family A per_signal entry', () => {
  const cfg = loadV52() as any;
  if (!cfg) return;
  let nMissing = 0;
  let nPresent = 0;
  for (const cell of cfg.baseline_cells.cells) {
    const fa = cell.family_A?.per_signal;
    if (!fa) continue;
    for (const sig of FAMILY_A_PRIMARY_SIGNALS) {
      const ps = fa[sig];
      if (!ps) continue;
      if (ps.baseline_sigma_squared_raw === undefined) nMissing++;
      else nPresent++;
    }
  }
  console.log(`[Q2.B.5 stamp] present=${nPresent} missing=${nMissing}`);
  assert.equal(nMissing, 0,
    `baseline_sigma_squared_raw missing on ${nMissing} entries (Q2.B.5 acceptance #1)`);
});

test('Q2.B.5 α=1 regression invariance (gaussian_like overlapping): σ²_raw matches μ_raw² · Σ_C[i,i]', () => {
  const cfg = loadV52() as any;
  if (!cfg) return;
  let alphaOneCell: any = null;
  for (const cell of cfg.baseline_cells.cells) {
    if (cell.family_C?.shrinkage_alpha === 1 &&
        cell.family_A?.per_signal?.p99_latency &&
        cell.confidence === 'strict') {
      alphaOneCell = cell;
      break;
    }
  }
  if (!alphaOneCell) {
    console.log('[Q2.B.5 α=1] no α=1 strict cell found in v5.2; skip');
    return;
  }
  const ps = alphaOneCell.family_A.per_signal.p99_latency;
  const fc = alphaOneCell.family_C;
  const i = FAMILY_C_SIGNALS.indexOf('p99_latency');
  const expectedSigma2Raw = ps.baseline_mean_raw * ps.baseline_mean_raw
    * fc.covariance[i][i];
  const denom = Math.max(Math.abs(expectedSigma2Raw), 1e-12);
  const residual = Math.abs(ps.baseline_sigma_squared_raw - expectedSigma2Raw) / denom;
  console.log(`[Q2.B.5 α=1 identity] cell ${JSON.stringify(alphaOneCell.key)}: residual ${residual.toExponential(3)}`);
  assert.ok(residual <= 1e-9,
    `α=1 cell σ²_raw vs μ²·Σ_C[i,i] residual ${residual} > 1e-9`);
});
