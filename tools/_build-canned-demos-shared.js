'use strict';
/**
 * tools/_build-canned-demos-shared.js — shared constants + helpers for the
 * canned demo generator (split out of build-canned-demos.js verbatim).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'demos', 'scripts');

// Common scenario context — Tuesday 2pm cell (matches §6.3 default).
const COMMON_CTX = {
  riskLevel: 'high',
  author: 'human',
  changeType: 'serving_code',
  timeWindow: 'ok',
  bakeHours: 6,
  flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
  // Cell context for the demo harness — matches embedded v4 config's hour=14, day=2 cell.
  currentHourOfDay: 14,
  currentDayOfWeek: 2,
};

// Baseline values for cell hour=14, day=2 (Tuesday 2pm). Synthesized to match
// the demo template's existing scenario shape; engine consumes via scenario.baseline.
const BASELINE = {
  p99_latency:    185,
  ttft:           220,
  tokens_turn:    418,
  kv_cache:       0.89,
  cost_req:       0.0042,
  downstream_err: 0.0012,
  mfu:            0.72,
  hbm_spill:      0.02,
  collective_ops: 0.9997,
  corpus_delta:   0.04,
  traffic_pct:    0.10,  // matches §6.3 traffic_pct
};

// Seeded LCG for deterministic noise.
function seededLCG(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

// ── Per-demo cell-patch builder ─────────────────────────────────────
//
// v4 cell calibration produces means that diverge from §6.3's specified
// baseline values (notably downstream_err: cell ≈ 0.12, spec ≈ 0.0011).
// Running the §6.3 trajectory against v4 fires mSPRT immediately on
// "stable" rows because they're 100× off the cell mean.
//
// To preserve determinism + spec fidelity without re-shipping the entire
// 1.7 MB v4 config per demo, each canned demo carries a small `cell_patch`:
// a sparse override that the demo template applies to the embedded v4
// config's targeted cell at run time.
//
// Variance estimates: σ² and τ² are scaled so a ≤ 4% deviation from
// baseline doesn't exceed the mSPRT threshold within the bake window.
// Concretely: tau² = (2% × baseline)² so δ_min = 4% of baseline.
const FAMILY_A_SIGNALS = ['p99_latency', 'ttft', 'eval_score', 'tool_success_rate', 'downstream_err', 'cost_req'];
const FAMILY_C_SIGNALS = ['p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops', 'corpus_delta', 'traffic_pct'];

module.exports = {
  fs,
  path,
  ROOT,
  OUT_DIR,
  COMMON_CTX,
  BASELINE,
  seededLCG,
  FAMILY_A_SIGNALS,
  FAMILY_C_SIGNALS,
};
