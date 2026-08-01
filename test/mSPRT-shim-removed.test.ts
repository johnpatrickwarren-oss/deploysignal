// test/mSPRT-shim-removed.test.ts — ARCHITECT-REPLY-53 R5.
//
// Lightweight guard against re-introduction of the deprecated
// `mSPRT` path name. The one-line re-export shim at
// `engine/detectors/mSPRT.ts` and the companion
// `test/page-cusum-rename-parity.test.ts` were kept for one PR cycle
// after the Page-CUSUM rename (ARCHITECT-REPLY-34 D1) — retirement
// closes that deprecation window. Page-CUSUM is the shipping
// detector; mSPRT is a dormant file-level alias with zero non-test
// consumers per the REPLY-53 pre-route grep verification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

test('mSPRT-shim-removed: engine/detectors/mSPRT.ts absent', () => {
  const p = path.join(REPO_ROOT, 'engine', 'detectors', 'mSPRT.ts');
  assert.ok(!fs.existsSync(p),
    `engine/detectors/mSPRT.ts should be absent post-REPLY-53 R5; found at ${p}`);
});

test('mSPRT-shim-removed: test/page-cusum-rename-parity.test.ts absent', () => {
  const p = path.join(REPO_ROOT, 'test', 'page-cusum-rename-parity.test.ts');
  assert.ok(!fs.existsSync(p),
    `test/page-cusum-rename-parity.test.ts should be absent post-REPLY-53 R5; found at ${p}`);
});

test('mSPRT-shim-removed: test/page-cusum.test.ts imports from page-cusum (not mSPRT)', () => {
  const p = path.join(REPO_ROOT, 'test', 'page-cusum.test.ts');
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes("from '@johnpatrickwarren-oss/deploysignal-engine/detectors/page-cusum'"),
    'test/page-cusum.test.ts must import from page-cusum (not mSPRT)');
  assert.ok(!src.includes("from '../dist/engine/detectors/mSPRT'"),
    'test/page-cusum.test.ts must not import from the retired mSPRT shim');
});
