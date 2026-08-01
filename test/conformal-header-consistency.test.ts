// test/conformal-header-consistency.test.ts — Addition #19 D2 fold
// regression guard.
//
// The pre-#19 Family E implementation header claimed calibration came
// from a "10% held-out slice" of the synthetic baseline. That was
// inaccurate — calibration is actually a parametric Gaussian bootstrap
// (see tools/calibrate.ts#buildFamilyEPerCell). ARCHITECT-REPLY-35 D2
// folds the header rewrite into Addition #19 since this PR rewires the
// calibration path anyway. This test locks the rewrite in place.
//
// RETARGETED when engine/detectors/conformal.ts migrated to
// @johnpatrickwarren-oss/deploysignal-engine. The guard used to read that
// local source; DeploySignal no longer owns it. Two targets replace it,
// and between them they carry both original assertions:
//
//   1. tools/calibrators/family-e.ts — the DeploySignal-owned code that
//      IS the parametric Gaussian bootstrap, and the ground truth the
//      retired header cited. Both the positive and the negative claim
//      are checked here.
//   2. the engine package's shipped Family E module — the negative claim
//      only. tsc keeps the vendoring banner but drops the descriptive
//      header block, so the shipped artifact cannot be linted for the
//      positive phrasing. It can still be checked for the phrasing the
//      D2 fold removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FAMILY_E_CALIBRATOR = path.resolve(
  __dirname, '..', 'tools', 'calibrators', 'family-e.ts',
);

const PACKAGED_CONFORMAL = require.resolve(
  '@johnpatrickwarren-oss/deploysignal-engine/detectors/conformal',
);

test('Family E calibrator: no "held-out slice" phrasing (D2 fold)', () => {
  const body = fs.readFileSync(FAMILY_E_CALIBRATOR, 'utf8');
  assert.ok(!/held-out slice/i.test(body),
    'tools/calibrators/family-e.ts still contains "held-out slice" — D2 fold did not land');
});

test('Family E calibrator: names the parametric Gaussian bootstrap + weighted extension', () => {
  const body = fs.readFileSync(FAMILY_E_CALIBRATOR, 'utf8');
  assert.ok(/parametric\s+Gaussian\s+bootstrap/i.test(body),
    'calibrator must describe the parametric Gaussian bootstrap calibration');
  assert.ok(/weighted/i.test(body),
    'calibrator must describe the Addition #19 weighted extension');
});

test('packaged Family E detector: no "held-out slice" phrasing (D2 fold, upstream)', () => {
  const body = fs.readFileSync(PACKAGED_CONFORMAL, 'utf8');
  assert.ok(!/held-out slice/i.test(body),
    'the engine package\'s Family E module reintroduced "held-out slice" — D2 fold regressed upstream');
});
