'use strict';
/**
 * tools/build-canned-demos.js — WS3.5 canned demo generator.
 *
 * Produces three deterministic canned demo JSON files under demos/scripts/
 * per WS3-INTERFACE-WEEK5.md §6:
 *
 *   demo-clean.json        — happy-path, all families clean, proceed.
 *   demo-novelty.json      — Family E (conformal) catches an unknown-unknown.
 *   demo-github-2020.json  — GitHub Jan 2020 Redis cascade reconstruction
 *                            using the §6.3 32-tick signal trajectory.
 *
 * Determinism: fixed seed (42) for any synthetic noise injection. Re-runs
 * produce byte-identical files.
 *
 * Each file's per-tick `pause_beat` flags are set on architecturally
 * significant moments (first fire per family, rollback decision tick,
 * peak degradation) per §6.4.
 *
 * Usage:
 *   node tools/build-canned-demos.js          # write all three demos
 *   node tools/build-canned-demos.js --check  # exit 1 if any demo is stale
 *
 * Module layout (split out of the original 811-line god-file; each
 * sibling holds a cohesive group, moved verbatim):
 *   _build-canned-demos-shared.js   — constants, BASELINE, seededLCG, signals
 *   _build-canned-demos-patch.js    — cell-patch + Family-E calibration
 *   _build-canned-demos-demos-1.js  — buildDemo1..3
 *   _build-canned-demos-demos-2.js  — buildDemo4..6
 *   _build-canned-demos-output.js   — writeIfChanged, toRefShape, diff
 */

const { path, OUT_DIR, fs } = require('./_build-canned-demos-shared');
const { attachPatch } = require('./_build-canned-demos-patch');
const { buildDemo1, buildDemo2, buildDemo3 } = require('./_build-canned-demos-demos-1');
const { buildDemo4, buildDemo5, buildDemo6 } = require('./_build-canned-demos-demos-2');
const { writeIfChanged, toRefShape } = require('./_build-canned-demos-output');

const checkMode = process.argv.includes('--check');

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Calibration slice counts: take the demo's pre-onset clean rows so the
  // calibration distribution mirrors what the engine sees on healthy ticks.
  // Demo 1: full run is clean → first 16 ticks. Demo 2: pre-onset is t=0..9.
  // Demo 3: pre-incident is t=0..4 (incident starts at tick 5).
  const demos = [
    { id: 'demo-clean',          data: attachPatch(buildDemo1(), 16) },
    { id: 'demo-novelty',        data: attachPatch(buildDemo2(), 9) },
    { id: 'demo-github-2020',    data: attachPatch(buildDemo3(), 5) },
    // W10 additions per ARCHITECT-REPLY-20 Items B + C.
    { id: 'demo-anthropic-2025',      data: attachPatch(buildDemo4(), 5) },
    { id: 'demo-tokens-creep',        data: attachPatch(buildDemo5(), 3) },
    // W13 addition per ARCHITECT-REPLY-24 — baseline maintenance +
    // maturity dashboard. Pre-onset slice is just ticks 0..1.
    { id: 'demo-baseline-maintenance', data: attachPatch(buildDemo6(), 2) },
  ];
  let stale = 0;
  for (const d of demos) {
    // D-54-4 slice 2b: transform flat → baseline_ref + overrides shape.
    const shaped = toRefShape(d.data);
    const out = JSON.stringify(shaped, null, 2) + '\n';
    const changed = writeIfChanged(path.join(OUT_DIR, d.id + '.json'), out, checkMode);
    if (changed) {
      stale++;
      console.log((checkMode ? 'STALE' : 'WROTE') + ' ' + d.id + '.json (' + d.data.ticks.length + ' ticks)');
    } else {
      console.log('OK    ' + d.id + '.json');
    }
  }
  if (checkMode && stale > 0) {
    console.error('\nFAIL: ' + stale + ' canned demo(s) stale. Run: node tools/build-canned-demos.js');
    process.exit(1);
  }
  if (checkMode) console.log('\nOK: all canned demos up to date.');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message || e); process.exit(1); }
}

module.exports = { buildDemo1, buildDemo2, buildDemo3, buildDemo4, buildDemo5, buildDemo6 };
