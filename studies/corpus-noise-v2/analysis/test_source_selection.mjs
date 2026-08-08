// test_source_selection.mjs — the regression test for the run-20260805T231835Z defect.
//
// Written before the fix. Run: node --test studies/corpus-noise-v2/analysis/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSource, canSupply, barsFailedBy } from './_source_selection.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');

// The two real sources that carry cost_req, as inventoried.
const LMSYS = { bundle: 'real-huggingface-lmsys-arena-v1', ticks: 39712, cells: 56 };
const BURSTGPT = { bundle: 'real-burstgpt-v1', ticks: 34202, cells: 48 };

test('A3 bars a synthetic-timestamp bundle from serial and periodic', () => {
  assert.deepEqual(barsFailedBy(LMSYS), ['A3']);
  assert.equal(canSupply(LMSYS, 'serial'), false);
  assert.equal(canSupply(LMSYS, 'periodic'), false);
  assert.equal(canSupply(LMSYS, 'marginal'), true);
});

test('a real-timestamp bundle passes every bar checked at selection time', () => {
  assert.deepEqual(barsFailedBy(BURSTGPT), []);
  for (const g of ['marginal', 'serial', 'periodic']) {
    assert.equal(canSupply(BURSTGPT, g), true);
  }
});

test('THE DEFECT: length alone must not select LMSYS over BurstGPT for cost_req', () => {
  // LMSYS is the longer series (39,712 > 34,202). The superseded run picked it
  // for every group on that basis and fitted phi on fabricated time order.
  const sel = selectSource([LMSYS, BURSTGPT]);
  assert.equal(sel.primary.bundle, 'real-burstgpt-v1',
    'primary must be the bundle failing fewer bars, not the longer one');
  assert.equal(sel.per_group.serial.bundle, 'real-burstgpt-v1');
  assert.equal(sel.per_group.periodic.bundle, 'real-burstgpt-v1');
  assert.equal(sel.per_group.marginal.bundle, 'real-burstgpt-v1');
  assert.equal(sel.cross_checks.length, 1);
  assert.equal(sel.cross_checks[0].bundle, 'real-huggingface-lmsys-arena-v1');
});

test('a signal with no source selects nothing', () => {
  const sel = selectSource([]);
  assert.equal(sel.primary, null);
  for (const g of ['marginal', 'serial', 'periodic']) assert.equal(sel.per_group[g], null);
});

test('when only a synthetic-timestamp bundle exists, serial and periodic get no source', () => {
  const sel = selectSource([LMSYS]);
  assert.equal(sel.primary.bundle, 'real-huggingface-lmsys-arena-v1');
  assert.equal(sel.per_group.marginal.bundle, 'real-huggingface-lmsys-arena-v1');
  assert.equal(sel.per_group.serial, null);
  assert.equal(sel.per_group.periodic, null);
});

// ── the same assertion against what the current run actually emitted ───────
test('the current run sources cost_req from a real-timestamp bundle', () => {
  const runs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('run-')).sort();
  const latest = runs[runs.length - 1];
  const fit = JSON.parse(readFileSync(join(STUDY, 'results', latest, 'fit.json'), 'utf8'));
  const prov = fit.signals.cost_req.provenance;
  assert.equal(prov.real_timestamps, true,
    `cost_req sourced from ${prov.bundle}, which has no real timestamps`);
  assert.equal(prov.bundle, 'real-burstgpt-v1');
});
