// test/conformal-header-consistency.test.ts — Addition #19 D2 fold
// regression guard.
//
// The pre-#19 Family E implementation header claimed calibration came
// from a "10% held-out slice" of the synthetic baseline. That was
// inaccurate — calibration is actually a parametric Gaussian bootstrap
// (see tools/calibrate.ts#buildFamilyEPerCell). ARCHITECT-REPLY-35 D2
// folds the header rewrite into Addition #19 since this PR rewires the
// calibration path anyway. This test locks the rewrite in place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CONFORMAL_PATH = path.resolve(__dirname, '..', 'engine', 'detectors', 'conformal.ts');

test('conformal.ts header: no "held-out slice" phrasing (D2 fold)', () => {
  const body = fs.readFileSync(CONFORMAL_PATH, 'utf8');
  // Header is lines 1-~50; whole file check is sufficient.
  assert.ok(!/held-out slice/i.test(body),
    `conformal.ts still contains "held-out slice" — D2 fold did not land`);
});

test('conformal.ts header: names the parametric Gaussian bootstrap + weighted extension', () => {
  const body = fs.readFileSync(CONFORMAL_PATH, 'utf8');
  assert.ok(/parametric\s+Gaussian\s+bootstrap/i.test(body),
    'header must describe the parametric Gaussian bootstrap calibration');
  assert.ok(/weighted/i.test(body),
    'header must describe the Addition #19 weighted extension');
});
