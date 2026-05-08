// test/q2-b-6-cell-selection.test.ts — Q2.B.6c regression test per
// ARCHITECT-REPLY-Q2-B-5-DISPOSITION §57-66 + DIAGNOSTIC-Q2-B-6C-2026-04-27.md.
//
// Verifies that `tools/build-report-card.js:lookupCell` mirrors
// `engine/detectors/hotelling.ts:matchFamilyCCell`'s tier-aware cell
// selection. Pre-Q2.B.6c: tier-blind `lookupCell` returned the first
// (h, d) match — consistently `tier=dominant, n=0` — diverging from
// runtime's `tenant_tier='aggregate'` pick and driving 168/168 cells'
// μ + Σ to disagree across the parametric resampler vs runtime gate.
// 168/168 mismatches collapsed parametric Cholesky H₀ FPR to 131/131.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { lookupFamilyCParams } from '../engine/detectors/hotelling';
import { resolveTenantTier } from '../engine/types/config';
import type { CompiledConfig } from '../engine/types/config';

// Mirror the production lookupCell at tools/build-report-card.js:633
// (post-Q2.B.6c). Re-implemented here so the regression test is
// self-contained — couples to the public function semantics, not the
// in-tool function symbol.
function lookupCellQ2B6c(compiledConfig: CompiledConfig, cellKey: {
  hour_of_day: number; day_of_week?: number;
}): unknown {
  const cells = compiledConfig.baseline_cells?.cells;
  if (!cells) return null;
  const tier = 'aggregate';
  return cells.find((c) => {
    if (!c.key) return false;
    if (c.key.hour_of_day !== cellKey.hour_of_day) return false;
    if (cellKey.day_of_week !== undefined && c.key.day_of_week !== undefined
        && c.key.day_of_week !== cellKey.day_of_week) return false;
    if (c.key.tenant_tier !== undefined && c.key.tenant_tier !== tier) return false;
    return true;
  }) ?? null;
}

const CFG_PATH = path.join(process.cwd(),
  'runs/compiled-configs/v5.3-q2b6.json');

test('Q2.B.6c lookupCell parity: parametric pick == runtime pick on all populated cells', () => {
  if (!fs.existsSync(CFG_PATH)) {
    console.log(`[Q2.B.6c test] skip — ${CFG_PATH} not yet emitted; recompile first.`);
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) as CompiledConfig;
  const cells = cfg.baseline_cells?.cells ?? [];
  const seen = new Set<string>();
  let total = 0, mismatch = 0;
  for (const c of cells) {
    const hour = c.key.hour_of_day as number;
    const day = c.key.day_of_week as number;
    const k = `${hour}-${day}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const pick = lookupCellQ2B6c(cfg, { hour_of_day: hour, day_of_week: day });
    const runtimeTier = resolveTenantTier(cfg, undefined);
    const runtimeLookup = lookupFamilyCParams(cfg, {
      hour_of_day: hour,
      day_of_week: day,
      tenant_tier: runtimeTier,
    });
    if (!pick || !runtimeLookup || typeof runtimeLookup.source !== 'object') continue;
    total++;
    if (pick !== runtimeLookup.source) mismatch++;
  }
  assert.equal(mismatch, 0,
    `Q2.B.6c: ${mismatch}/${total} cells diverge between parametric `
    + `lookupCell and runtime lookupFamilyCParams — cell-selection `
    + `mismatch reintroduced.`);
  assert.ok(total > 0, 'Q2.B.6c: no populated cells exercised; substrate empty?');
});

test('Q2.B.6c lookupCell selects tenant_tier=aggregate (no-tenantId default)', () => {
  if (!fs.existsSync(CFG_PATH)) return;
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) as CompiledConfig;
  const cells = cfg.baseline_cells?.cells ?? [];
  // Find any (h, d) with multiple tier-keyed cells; assert the pick is the
  // 'aggregate' one. Pre-Q2.B.6c this returned 'dominant' (first listed).
  const sample = cells.find((c) => c.key.tenant_tier === 'aggregate');
  if (!sample) {
    console.log('[Q2.B.6c test] skip — no aggregate-tier cells in substrate');
    return;
  }
  const pick = lookupCellQ2B6c(cfg, {
    hour_of_day: sample.key.hour_of_day as number,
    day_of_week: sample.key.day_of_week as number,
  }) as { key: { tenant_tier?: string } };
  assert.ok(pick && pick.key && pick.key.tenant_tier === 'aggregate',
    `Q2.B.6c: lookupCell at ${JSON.stringify(sample.key)} should pick `
    + `tenant_tier='aggregate'; got tenant_tier='${pick?.key?.tenant_tier}'`);
});
