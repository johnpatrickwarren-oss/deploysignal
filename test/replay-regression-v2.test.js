'use strict';
/**
 * test/replay-regression-v2.test.js — W4 §4.1.h: v2 fixture replay.
 *
 * Parallels the v1 replay-regression test. The v2 fixture is generated
 * deterministically from the v1 fixture's live inputs, re-running each
 * sequence through the engine with `fusionTopology: 'portfolio'`. Re-runs
 * the v2 fixture and asserts every verdict matches.
 *
 * Run: node test/replay-regression-v2.test.js
 */
const fs   = require('fs');
const path = require('path');

const V1_GOLDEN = path.join(__dirname, 'fixtures', 'audit', 'golden.jsonl');
const V2_GOLDEN = path.join(__dirname, 'fixtures', 'audit', 'golden-v2.jsonl');

if (!fs.existsSync(V1_GOLDEN)) {
  console.error('v1 golden fixture not found: ' + V1_GOLDEN);
  process.exit(1);
}

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

// ── v2 fixture (re)generation ──────────────────────────────────────────
// W5 §T1: the v2 fixture exercises all five families (A/B/C/D/E), driven
// by a curated slice of the 131-scenario adversarial pool against the v4
// compiled config under portfolio topology. The regenerator lives in
// tools/regenerate-v2-fixture.js so it can be re-run independently when
// engine semantics shift; this test self-heals if the fixture is missing
// (fresh clone, deleted artifact) by invoking it in-process.
function ensureV2Fixture() {
  if (fs.existsSync(V2_GOLDEN)) return;
  const { regenerate } = require('../tools/regenerate-v2-fixture');
  regenerate();
}

ensureV2Fixture();

// V4 compiled config + per-scenario context echo what the regenerator
// uses; both must match for replayed verdicts to align.
const V4_PATH = path.join(__dirname, '..', 'runs', 'compiled-configs', 'v4-fusion-novelty.json');
const V4 = fs.existsSync(V4_PATH) ? JSON.parse(fs.readFileSync(V4_PATH, 'utf8')) : null;
// Q68 Phase-3.d.C consolidation — `page_cusum_variant` flag retired;
// replay fixture re-baselined against mixture-supermartingale Ville-bounded
// variant unconditional dispatch.
const TEST_HOUR_OF_DAY = 20;
const TEST_DAY_OF_WEEK = 3;

// ── Replay: load v2 fixture and re-run verdicts ──────────────────────
const v2Lines = fs.readFileSync(V2_GOLDEN, 'utf8').trim().split('\n');
const v2Records = v2Lines.map((l) => JSON.parse(l));

const v2Sequences = [];
{
  let seq = [];
  for (const r of v2Records) {
    if (r.tick === 0 && seq.length > 0) { v2Sequences.push(seq); seq = []; }
    seq.push(r);
  }
  if (seq.length > 0) v2Sequences.push(seq);
}

let matches = 0;
let divergences = 0;
const divergeDetails = [];

for (const s of v2Sequences) {
  const tb = new TrendBuffer(10);
  for (const r of s) {
    if (r.inputs) {
      for (const k of Object.keys(r.inputs)) tb.push(k, r.inputs[k]);
    }
    const ctx = r.scenario_ctx || {};
    const result = orchestrate({
      liveMetrics: r.inputs,
      scenario: {
        baseline: r.baseline || {},
        riskLevel: ctx.riskLevel || 'medium',
        changeType: ctx.changeType || 'model_weights',
        author: ctx.author || 'human',
        timeWindow: ctx.timeWindow || 'ok',
        flags: ctx.flags || {},
      },
      hoursElapsed: r.hours_elapsed || 0,
      trendBuffer: tb,
      tick: r.tick,
      totalTicks: r.total_ticks,
      compiledConfig: V4,
      currentHourOfDay: TEST_HOUR_OF_DAY,
      currentDayOfWeek: TEST_DAY_OF_WEEK,
      fusionTopology: 'portfolio',
    });

    if (result.verdict === r.verdict) {
      matches++;
    } else {
      divergences++;
      divergeDetails.push({
        tick: r.tick,
        service: r.service,
        logged: r.verdict,
        replayed: result.verdict,
        loggedReason: r.reason,
        replayReason: result.reason,
      });
    }
  }
}

// ── v2-specific invariants from the fixture ──────────────────────────
const invariantFailures = [];
const KNOWN_A = new Set(['mSPRT_p99_latency', 'mSPRT_ttft', 'mSPRT_eval_score',
  'mSPRT_tool_success_rate', 'mSPRT_downstream_err', 'mSPRT_cost_req']);
const KNOWN_B = new Set(['kv_saturation', 'hbm_elevation', 'hbm_spill_roll',
  'mfu_collapse', 'slowbleed', 'collective', 'capacity', 'gpu_eff',
  'compound_lat', 'tok_econ', 'behavioral', 'eval_quality_drop',
  'refusal_spike', 'output_len_drift', 'tool_call_degradation', 'quality_warning']);
const KNOWN_C = new Set(['hotelling_t2_joint_vector']);
const KNOWN_D = new Set(['spectral_peak_acf_kv_cache']);
const KNOWN_E = new Set(['mahalanobis_conformal_baseline']);

for (const r of v2Records) {
  if (r.schema_version !== '2') {
    invariantFailures.push(`tick ${r.tick}: schema_version expected "2", got ${r.schema_version}`);
    continue;
  }
  if (r.fusion_topology !== 'portfolio') {
    invariantFailures.push(`tick ${r.tick}: fusion_topology expected "portfolio", got ${r.fusion_topology}`);
  }
  if (!r.families) {
    invariantFailures.push(`tick ${r.tick}: families block missing`);
    continue;
  }
  for (const fam of ['A', 'B', 'C', 'D', 'E']) {
    if (!r.families[fam]) {
      invariantFailures.push(`tick ${r.tick}: families.${fam} missing`);
      continue;
    }
    for (const det of r.families[fam].detectors) {
      const registry = fam === 'A' ? KNOWN_A
                     : fam === 'B' ? KNOWN_B
                     : fam === 'C' ? KNOWN_C
                     : fam === 'D' ? KNOWN_D
                     : KNOWN_E;
      if (!registry.has(det.detector_id)) {
        invariantFailures.push(`tick ${r.tick}: unknown_detector_id ${fam}.${det.detector_id}`);
      }
      // Provenance must be present on every emitted trip.
      if (!det.provenance) {
        invariantFailures.push(`tick ${r.tick}: family ${fam} detector ${det.detector_id} missing provenance`);
      }
      // cusum_progress must be present on Family A, absent on other families.
      if (fam === 'A') {
        if (det.cusum_progress === undefined) {
          invariantFailures.push(`tick ${r.tick}: Family A ${det.detector_id} missing cusum_progress`);
        }
      } else {
        if (det.cusum_progress !== undefined) {
          invariantFailures.push(`tick ${r.tick}: Family ${fam} ${det.detector_id} unexpected cusum_progress`);
        }
      }
      // alpha_consumed must NOT appear on v2 trips (deprecated).
      if (det.alpha_consumed !== undefined) {
        invariantFailures.push(`tick ${r.tick}: Family ${fam} ${det.detector_id} leaked deprecated alpha_consumed`);
      }
    }
  }
}

// W5 §T1 acceptance: each of Families A/B/C/D/E must produce a
// non-empty `detectors[]` row somewhere in the fixture, proving the
// regenerator's scenario slice exercises the full registry rather than
// only Family B (the pre-W5 v2 fixture's known gap).
//
// Q73 close: W5 §T1 family_D invariant RESTORED. Q72 SLICE 2 close
// relaxation (Q72_FAMILY_D_INVARIANT_RELAXED flag) lifted post-Q73
// Phase 2.b fixture-pipeline-modification (per
// ARCHITECT-REPLY-Q73-PHASE-1-CLOSE-INTAKE-AND-PHASE-2-ROUTING).
// Regenerator no longer short-circuits on rollback; full-tick
// evaluation lets Family D's 20-sample long-view fill + spectral
// ACF detector evaluate. Production-semantic rollback decision
// preserved per-record via `q73_first_rollback_tick` field. See
// coordination/DIAGNOSTIC-Q73-PHASE-1-FAMILY-D-FIXTURE-INVESTIGATION-
// 2026-05-07.md for one-tick-gap mechanism localization on
// adv_w4_oscillation_kv_cache (Family A fires tick 18; Family D
// long-view fills tick 19 — pre-Q73 short-circuit at tick 18 elided
// Family D evaluation).
const familiesWithFires = { A: 0, B: 0, C: 0, D: 0, E: 0 };
for (const r of v2Records) {
  if (!r.families) continue;
  for (const fam of ['A', 'B', 'C', 'D', 'E']) {
    if (r.families[fam] && r.families[fam].detectors.length > 0) familiesWithFires[fam]++;
  }
}
for (const fam of ['A', 'B', 'C', 'D', 'E']) {
  if (familiesWithFires[fam] === 0) {
    invariantFailures.push(`Family ${fam}: no record carries a non-empty detectors[] (W5 §T1 acceptance gap)`);
  }
}

console.log('v2 replay regression test');
console.log('─'.repeat(50));
console.log('Records: ' + v2Records.length + '  Sequences: ' + v2Sequences.length);
console.log('Match: ' + matches + '  Diverge: ' + divergences);
console.log('Per-family fires: A=' + familiesWithFires.A + ' B=' + familiesWithFires.B +
            ' C=' + familiesWithFires.C + ' D=' + familiesWithFires.D + ' E=' + familiesWithFires.E);
console.log('Invariant failures: ' + invariantFailures.length);

if (divergences > 0) {
  console.log('\nDivergences:');
  for (const d of divergeDetails.slice(0, 20)) {
    console.log('  tick ' + d.tick + ': logged=' + d.logged + ' replayed=' + d.replayed);
  }
}
if (invariantFailures.length > 0) {
  console.log('\nInvariant failures:');
  for (const f of invariantFailures.slice(0, 20)) console.log('  ' + f);
}

if (divergences > 0 || invariantFailures.length > 0) {
  console.log('\nFAIL');
  process.exit(1);
} else {
  console.log('\nPASS — all v2 verdicts match + invariants hold.');
  process.exit(0);
}
