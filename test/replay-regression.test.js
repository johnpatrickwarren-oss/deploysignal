'use strict';
/**
 * test/replay-regression.test.js — Golden-fixture replay regression test
 *
 * Feeds the golden JSONL audit fixture back through the engine and asserts
 * every verdict matches. A failure means decision semantics changed between
 * the commit that generated the fixture and the current engine code.
 *
 * Run: node test/replay-regression.test.js
 */
const fs   = require('fs');
const path = require('path');

const GOLDEN = path.join(__dirname, 'fixtures', 'audit', 'golden.jsonl');

if (!fs.existsSync(GOLDEN)) {
  console.error('Golden fixture not found: ' + GOLDEN);
  process.exit(1);
}

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

const lines = fs.readFileSync(GOLDEN, 'utf8').trim().split('\n');
const records = lines.map(l => JSON.parse(l));

let matches = 0;
let divergences = 0;
const divergeDetails = [];

// Split into sequences (tick 0 = new sequence)
const sequences = [];
let seq = [];
for (const r of records) {
  if (r.tick === 0 && seq.length > 0) { sequences.push(seq); seq = []; }
  seq.push(r);
}
if (seq.length > 0) sequences.push(seq);

for (const s of sequences) {
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
        flags: ctx.flags || {}
      },
      hoursElapsed: r.hours_elapsed || 0,
      trendBuffer: tb,
      tick: r.tick,
      totalTicks: r.total_ticks
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
        replayReason: result.reason
      });
    }
  }
}

console.log('Golden-fixture replay regression test');
console.log('─'.repeat(50));
console.log('Records: ' + records.length + '  Sequences: ' + sequences.length);
console.log('Match: ' + matches + '  Diverge: ' + divergences);

if (divergences > 0) {
  console.log('\nDivergences:');
  for (const d of divergeDetails) {
    console.log('  tick ' + d.tick + ': logged=' + d.logged + ' replayed=' + d.replayed + ' (' + d.replayReason + ')');
  }
  console.log('\nFAIL — decision semantics have changed.');
  process.exit(1);
} else {
  console.log('\nPASS — all verdicts match.');
  process.exit(0);
}
