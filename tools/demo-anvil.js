#!/usr/bin/env node
/**
 * tools/demo-anvil.js — Anvil (Addition #29) end-to-end CLI walkthrough.
 *
 * Runs a synthetic chaos experiment through orchestrate() with
 * expectedFailurePattern set. Demonstrates the three regimes:
 *
 *   1. Pre-window  (ticks 0–3): expectedFailurePattern absent;
 *                  detectors run normally; clean signals → proceed.
 *   2. Fault window (ticks 4–8): expectedFailurePattern present with
 *                  suppress_families=['A']; p99_latency injection spikes
 *                  the signal; Family A would normally fire but is
 *                  suppressed (chaos operator declared the fault expected).
 *                  Family C (multivariate) still active to catch
 *                  unexpected-blast on other signals.
 *   3. Post-recovery (ticks 9–11): fault window elapsed; suppression
 *                  releases; signals recover; clean → proceed.
 *
 * Output:
 *   - Stylized ASCII walkthrough to stdout (per-tick verdict + family
 *     status + suppression annotation).
 *   - Audit JSON saved to demos/anvil-chaos-walkthrough.json (one
 *     AuditRecord per tick).
 *
 * Deterministic: fixed seed; re-runs produce byte-identical output.
 *
 * Usage:
 *   node tools/demo-anvil.js                          # run + print + save
 *   node tools/demo-anvil.js --check                  # exit 1 if saved JSON is stale
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'demos', 'anvil-chaos-walkthrough.json');
const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

// ── Synthetic chaos experiment ──────────────────────────────────────
//
// A 12-tick run modeling a Chaos Mesh NetworkChaos(delay) experiment
// against a generic microservice. Baseline p99_latency = 185ms.
// Fault window starts at tick 4 (T_fault_start = T0 + 4 ticks at 30s
// per tick → fault_start_unix = T0 + 120s); recovery_seconds = 150
// (5-tick window). Operator declares suppress_families=['A'] because
// the entire point of the experiment is to inject latency and verify
// the system tolerates it without unexpected blast on OTHER signals.

const TICK_INTERVAL_SECONDS = 30;
const T0 = 1_700_000_000;
const FAULT_START_TICK = 4;
const FAULT_END_TICK = 8;
const FAULT_START_UNIX = T0 + FAULT_START_TICK * TICK_INTERVAL_SECONDS;
const RECOVERY_SECONDS = (FAULT_END_TICK - FAULT_START_TICK + 1) * TICK_INTERVAL_SECONDS;
const TOTAL_TICKS = 12;

const BASELINE = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

const SCENARIO = {
  id: 'anvil-chaos-walkthrough',
  riskLevel: 'medium',
  changeType: 'serving_code',
  author: 'human',
  timeWindow: 'ok',
  flags: {
    security: false, artifact_content: false, provenance: false,
    contract: false, toolchain: false, zeta: true, approval: true,
  },
  baseline: BASELINE,
};

const EXPECTED_PATTERN = {
  kind: 'network_delay',
  affected_signals: ['p99_latency', 'downstream_err'],
  magnitude: 1.0,
  magnitude_unit: 'sigma',
  recovery_seconds: RECOVERY_SECONDS,
  suppress_families: ['A'],
  fault_start_unix: FAULT_START_UNIX,
};

/** Per-tick metrics trajectory. Pre-window clean; in-window p99 spikes
 *  to 280ms (expected fault); post-window recovers to baseline. */
function liveMetricsForTick(tick) {
  const m = { ...BASELINE };
  if (tick >= FAULT_START_TICK && tick <= FAULT_END_TICK) {
    // Fault injection: ~50% relative latency spike on p99 + ttft.
    m.p99_latency = 280;
    m.ttft = 320;
    // downstream_err climbs mildly (timeouts cascading).
    m.downstream_err = 0.17;
  }
  return m;
}

function nowUnixForTick(tick) {
  return T0 + tick * TICK_INTERVAL_SECONDS;
}

// ── Driver ──────────────────────────────────────────────────────────

function runWalkthrough() {
  let compiledConfig = null;
  if (fs.existsSync(CONFIG_PATH)) {
    compiledConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  const tb = new TrendBuffer(15);
  const records = [];
  for (let tick = 0; tick < TOTAL_TICKS; tick++) {
    const live = liveMetricsForTick(tick);
    for (const k of Object.keys(live)) tb.push(k, live[k]);

    const params = {
      liveMetrics: live,
      scenario: SCENARIO,
      hoursElapsed: tick * (TICK_INTERVAL_SECONDS / 3600),
      trendBuffer: tb,
      tick,
      totalTicks: TOTAL_TICKS,
      compiledConfig,
      currentHourOfDay: 14,
      currentDayOfWeek: 3,
      fusionTopology: 'portfolio',
      // Anvil hook: pattern is consulted on every tick; the helper
      // tickWithinFaultWindow() gates whether suppression actually
      // applies. Outside the declared fault window, families evaluate
      // normally (PRD-29 AC-11 byte-identical to pre-Anvil).
      expectedFailurePattern: EXPECTED_PATTERN,
      nowSeconds: nowUnixForTick(tick),
    };
    const result = orchestrate(params);
    const audit = buildAuditRecord(params, result, { service: 'anvil-demo' });
    records.push(audit);
  }
  return records;
}

// ── ASCII rendering ─────────────────────────────────────────────────

function chaosVerdictLabel(engineVerdict) {
  switch (engineVerdict) {
    case 'proceed': return 'experiment_passed';
    case 'rollback': return 'experiment_failed_unexpectedly';
    case 'extend': return 'experiment_still_running';
    default: return engineVerdict;
  }
}

function familyStatus(record, fam) {
  const f = record.families && record.families[fam];
  if (!f) return 'n/a';
  if (f.verdict === 'suppressed') {
    const reason = f.suppression_reason || '?';
    return `suppressed[${reason}]`;
  }
  return f.verdict;
}

function inFaultWindow(tick) {
  return tick >= FAULT_START_TICK && tick <= FAULT_END_TICK;
}

function render(records) {
  const lines = [];
  lines.push('━'.repeat(78));
  lines.push('  Anvil chaos-verdict walkthrough — NetworkChaos(delay), 12 ticks @ 30s');
  lines.push('━'.repeat(78));
  lines.push('');
  lines.push('  Experiment: synthetic Chaos Mesh NetworkChaos(delay)');
  lines.push(`  Fault window: ticks ${FAULT_START_TICK}–${FAULT_END_TICK} (${RECOVERY_SECONDS}s); suppress_families=['A']`);
  lines.push('  Expected: Family A fires on p99 → suppressed (operator declared);');
  lines.push('            Family C still listens for unexpected blast on other signals.');
  lines.push('');
  lines.push('  ' + 'tick'.padEnd(5) + 'p99'.padEnd(7) + 'phase'.padEnd(16) + 'engine '.padEnd(12) + 'chaos verdict'.padEnd(34) + 'fam A      fam C');
  lines.push('  ' + '─'.repeat(98));
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const phase = i < FAULT_START_TICK ? 'pre-window'
      : i <= FAULT_END_TICK ? 'FAULT WINDOW'
      : 'post-recovery';
    const engineV = r.verdict;
    const chaosV = chaosVerdictLabel(engineV);
    const famA = familyStatus(r, 'A');
    const famC = familyStatus(r, 'C');
    const p99 = liveMetricsForTick(i).p99_latency;
    const marker = inFaultWindow(i) ? '▌' : ' ';
    lines.push(
      `  ${marker}${String(i).padEnd(4)}${String(p99).padEnd(7)}${phase.padEnd(16)}${engineV.padEnd(12)}${chaosV.padEnd(34)}${famA.padEnd(11)}${famC}`,
    );
  }
  lines.push('');
  lines.push('  What the proof-of-life demonstrates:');
  lines.push('    • The `fam A` column inside the fault window (▌ markers) shows');
  lines.push('      `suppressed[expected_failure_pattern]` — Anvil intercepted what would');
  lines.push('      otherwise be a Family A fire on the injected latency spike, and');
  lines.push('      rewrote it to suppressed with the new reason_code.');
  lines.push('    • Outside the fault window, Family A evaluates normally — PRD-29 AC-11');
  lines.push('      byte-identical preservation in action (the suppression hook is gated');
  lines.push('      on tickWithinFaultWindow()).');
  lines.push('    • Family C runs unconditionally — the multivariate "unexpected blast"');
  lines.push('      catcher continues to fire independently if any non-suppressed family');
  lines.push('      crosses its threshold.');
  lines.push('');
  lines.push('  Note: The compiled config used (v4-fusion-novelty.json) is calibrated');
  lines.push('  against an LLM-inference baseline; the synthetic chaos baseline here');
  lines.push('  diverges enough that some families fire outside the fault window too.');
  lines.push('  That divergence is not the demo subject — the demo subject is the');
  lines.push('  suppression annotation visible on Family A inside the window. A future');
  lines.push('  cycle ships a calibrated anvil-chaos-experiment compiled config + a');
  lines.push('  matching synthetic substrate for clean pitch-quality storytelling.');
  lines.push('');
  lines.push('  Audit JSON (1 record/tick) saved to demos/anvil-chaos-walkthrough.json');
  lines.push('━'.repeat(78));
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');

  const records = runWalkthrough();
  const out = render(records);
  console.log(out);

  const json = JSON.stringify(records, null, 2);
  if (check) {
    if (!fs.existsSync(OUT)) {
      console.error('\n[--check] demos/anvil-chaos-walkthrough.json missing — re-run without --check to regenerate');
      process.exit(1);
    }
    const onDisk = fs.readFileSync(OUT, 'utf8');
    if (onDisk.trim() !== json.trim()) {
      console.error('\n[--check] demos/anvil-chaos-walkthrough.json is STALE — re-run without --check to regenerate');
      process.exit(1);
    }
    console.log('\n[--check] demos/anvil-chaos-walkthrough.json is up-to-date.');
    process.exit(0);
  }
  fs.writeFileSync(OUT, json + '\n');
}

main();
