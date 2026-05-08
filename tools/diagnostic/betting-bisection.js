#!/usr/bin/env node
// tools/diagnostic/betting-bisection.js — V1.H3 orchestrator-scale
// bisection per ARCHITECT-REPLY-52gg. Reuses the V1.H3 single-detector
// loop with parameterized (μ, σ²) so we can sweep regimes and isolate
// what reproduces the Q3 60% Ville violation.
//
// Step 1: small-σ sweep at μ=0.
// Step 2: large-μ at σ=1.
// Step 3: (μ, σ) combos at firing-cell calibrations.
// Step 4: 6-signal concurrent.
//
// Decision rule (each step): any (μ, σ) producing > 1/131 fires under
// 131-trajectory × 100-tick iid-Gaussian sweep is a candidate
// reproduction of the Q3 violation; halt + report. Per architect
// REPLY-52gg §175.

const path = require('node:path');
const {
  freshBettingState, updateBettingState,
} = require(path.join(process.cwd(),
  'dist/engine/detectors/betting-e-process'));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const ALPHA_BETTING = 3.33e-5;
const THRESHOLD = 1 / ALPHA_BETTING;
const TRAJECTORIES = 131;
const TICKS = 100;

/** Single-detector V1.H3 sweep with parameterized (μ, σ²). Returns
 *  { fires, max_wealth_seen } per the V1.H3 unit-test convention.
 *  α matches v5's per-signal betting allocation. */
function singleDetectorSweep(mu, sigmaSquared, seedBase) {
  const sigma = Math.sqrt(Math.max(sigmaSquared, 0));
  let fires = 0;
  let maxWealth = 1;
  for (let traj = 0; traj < TRAJECTORIES; traj++) {
    const state = freshBettingState();
    const rng = mulberry32(seedBase + traj);
    for (let t = 0; t < TICKS; t++) {
      const x = mu + gaussian(rng) * sigma;
      updateBettingState(state, x, mu, sigmaSquared, ALPHA_BETTING);
      if (state.M > maxWealth) maxWealth = state.M;
      if (state.M >= THRESHOLD) { fires++; break; }
    }
  }
  return { fires, maxWealth };
}

const STEP = parseInt(process.argv[2] ?? '1', 10);

if (STEP === 1) {
  // Step 1: small-σ sweep at μ=0.
  // Hypothesis: small σ post-floor cells trigger numerical instability.
  console.log('=== Step 1: small-σ sweep at μ=0 ===');
  console.log(`α_betting=${ALPHA_BETTING.toExponential(3)}; threshold=${THRESHOLD.toFixed(0)}; trials=${TRAJECTORIES}; ticks=${TICKS}`);
  console.log('');
  console.log('  σ            μ        fires     max_wealth   ratio_vs_α');
  const SIGMAS = [0.001, 0.01, 0.1, 1.0, 10, 100];
  const results = [];
  for (let i = 0; i < SIGMAS.length; i++) {
    const sigma = SIGMAS[i];
    const sigma2 = sigma * sigma;
    const { fires, maxWealth } = singleDetectorSweep(0, sigma2, 0x51500000 + i * 1000);
    const fpr = fires / TRAJECTORIES;
    const ratio = fpr / ALPHA_BETTING;
    results.push({ sigma, fires, maxWealth, fpr, ratio });
    const flag = fires > 1 ? '  ← REPRO' : '';
    console.log(`  ${sigma.toString().padStart(8)}    0        ${String(fires).padStart(3)}/${TRAJECTORIES}  ${maxWealth.toFixed(2).padStart(11)}   ${ratio.toFixed(1)}×${flag}`);
  }
  console.log('');
  const reproCount = results.filter((r) => r.fires > 1).length;
  if (reproCount > 0) {
    console.log(`Step 1 RESULT: ${reproCount}/${SIGMAS.length} σ regimes reproduce Q3 violation. σ-dependence localized.`);
  } else {
    console.log(`Step 1 RESULT: NO σ-only reproduction at μ=0. Advance to Step 2 (μ-dependence).`);
  }
} else if (STEP === 4) {
  // Step 4: 6-signal concurrent. 6 betting-e-processes against
  // 6 independent N(μ_signal, σ_signal²) streams. Per-signal AND
  // any-signal fire counts. Decision: > 6× single-signal expectation
  // → cross-signal correlation effect (orchestrator-level bug).
  const fs = require('node:fs');
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(),
    'runs/compiled-configs/v5-sequential-e-process.json'), 'utf8'));
  const Q3 = JSON.parse(fs.readFileSync(path.join(process.cwd(),
    'runs/validation-reports/report-card-v1-parametric_gaussian.json'), 'utf8'));
  const FAMILY_A_SIGNALS = ['p99_latency','ttft','eval_score','tool_success_rate','downstream_err','cost_req'];
  const firingKeys = Object.keys(Q3.fpr_calibration.fpr_ville_bounded.per_cell_fires);
  console.log('=== Step 4: 6-signal concurrent (firing cells) ===');
  console.log(`Q3 firing cells: ${firingKeys.length}; per-cell α_betting=${ALPHA_BETTING.toExponential(3)} per signal; trials=${TRAJECTORIES}; ticks=${TICKS}`);

  const cellsByKey = new Map();
  for (const c of cfg.baseline_cells.cells) {
    if (c.confidence !== 'strict' || !c.family_A?.per_signal) continue;
    const k = `${c.key.hour_of_day}-${c.key.day_of_week}`;
    if (!cellsByKey.has(k)) cellsByKey.set(k, []);
    cellsByKey.get(k).push(c);
  }

  // For each firing cell, run 6-signal concurrent V1.H3.
  // Per trial: 6 fresh betting states; per tick, draw 6 independent
  // N(μ_sig, σ_sig²) values; update each state; "fire" iff ANY state
  // crosses 1/α threshold.
  let totalCellsTested = 0;
  let cellsWithAnyFire = 0;
  let totalAnyFires = 0;
  const perSignalFires = {};
  for (const sig of FAMILY_A_SIGNALS) perSignalFires[sig] = 0;

  console.log('\n  cell    any-signal fires   per-signal fire counts');
  for (const fk of firingKeys) {
    const cellList = cellsByKey.get(fk) ?? [];
    if (cellList.length === 0) continue;
    const cell = cellList.find((c) => c.key.tenant_tier === 'large') ?? cellList[0];
    const fa = cell.family_A.per_signal;
    const sigs = FAMILY_A_SIGNALS.filter((s) => fa[s] !== undefined);
    if (sigs.length === 0) continue;
    totalCellsTested++;

    let anyFire = 0;
    const sigFires = {};
    for (const s of sigs) sigFires[s] = 0;

    for (let traj = 0; traj < TRAJECTORIES; traj++) {
      const states = {};
      const rngs = {};
      for (let i = 0; i < sigs.length; i++) {
        states[sigs[i]] = freshBettingState();
        rngs[sigs[i]] = mulberry32(0x54000000 +
          (cell.key.hour_of_day * 137 + cell.key.day_of_week * 41) * 1000 +
          traj * 10 + i);
      }
      let fired = false;
      const firedSet = new Set();
      for (let t = 0; t < TICKS && !fired; t++) {
        for (const s of sigs) {
          const ps = fa[s];
          const mu = ps.baseline_mean;
          const s2 = Math.max(ps.baseline_sigma_squared, 0);
          const sigma = Math.sqrt(s2);
          const x = mu + gaussian(rngs[s]) * sigma;
          updateBettingState(states[s], x, mu, s2, ALPHA_BETTING);
          if (states[s].M >= THRESHOLD && !firedSet.has(s)) {
            firedSet.add(s);
            sigFires[s]++;
            if (!fired) {
              fired = true;
              anyFire++;
            }
          }
        }
      }
    }
    if (anyFire > 0) {
      cellsWithAnyFire++;
      totalAnyFires += anyFire;
      const sigStr = sigs.map((s) => `${s}=${sigFires[s]}`).filter((kv) => !kv.endsWith('=0')).join(',');
      console.log(`  ${fk.padEnd(6)}  ${String(anyFire).padStart(3)}/131           [${sigStr || 'none'}]`);
      for (const s of sigs) perSignalFires[s] += sigFires[s];
    }
  }
  console.log('');
  console.log(`Step 4 RESULT: ${cellsWithAnyFire}/${totalCellsTested} cells fire under 6-signal concurrent isolation; total any-signal fires = ${totalAnyFires}.`);
  console.log('  Per-signal fire totals across all firing cells:');
  for (const s of FAMILY_A_SIGNALS) {
    if (perSignalFires[s] > 0) {
      console.log(`    ${s.padEnd(20)} ${perSignalFires[s]}`);
    }
  }

  if (cellsWithAnyFire === 0) {
    console.log('\n  6-signal concurrent at firing-cell calibrations does NOT reproduce. Bug is orchestrator-integration-level (bake profile / schema_continuity / state-machinery wrapper). Bisection passes V1.H3 unit-test boundary; full orchestrator simulation needed.');
  } else {
    console.log('\n  6-signal concurrent reproduces. Cross-signal correlation effect localized — bug bisected.');
  }
} else if (STEP === 3) {
  // Step 3: (μ, σ) combos at exact firing-cell calibrations.
  // Hypothesis: combined regime (specific μ-σ pairing) reproduces Q3.
  const fs = require('node:fs');
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(),
    'runs/compiled-configs/v5-sequential-e-process.json'), 'utf8'));
  const Q3 = JSON.parse(fs.readFileSync(path.join(process.cwd(),
    'runs/validation-reports/report-card-v1-parametric_gaussian.json'), 'utf8'));
  const FAMILY_A_SIGNALS = ['p99_latency','ttft','eval_score','tool_success_rate','downstream_err','cost_req'];
  // Extract firing-cell keys from per_cell_fires
  const firingKeys = Object.keys(Q3.fpr_calibration.fpr_ville_bounded.per_cell_fires);
  console.log('=== Step 3: firing-cell (μ, σ) combos ===');
  console.log(`Q3 firing cells: ${firingKeys.length}`);
  console.log(`α_betting=${ALPHA_BETTING.toExponential(3)}; threshold=${THRESHOLD.toFixed(0)}; trials=${TRAJECTORIES}; ticks=${TICKS}`);

  // Build a map: "h-d" → array of strict cells (one per tier) with family_A
  const cellsByKey = new Map();
  for (const c of cfg.baseline_cells.cells) {
    if (c.confidence !== 'strict' || !c.family_A?.per_signal) continue;
    const k = `${c.key.hour_of_day}-${c.key.day_of_week}`;
    if (!cellsByKey.has(k)) cellsByKey.set(k, []);
    cellsByKey.get(k).push(c);
  }

  // For each firing cell × Family A signal, run single-detector V1.H3
  const reproCells = [];
  let totalCellsTested = 0;
  let totalSignalsTested = 0;
  let cellsWithFires = 0;
  console.log('\n  cell    sig                  μ            σ           fires    max_wealth');
  for (const fk of firingKeys) {
    const cellList = cellsByKey.get(fk) ?? [];
    if (cellList.length === 0) continue;
    // Use the 'large' tier if present, else first
    const cell = cellList.find((c) => c.key.tenant_tier === 'large') ?? cellList[0];
    const fa = cell.family_A.per_signal;
    let cellFires = 0;
    for (const sig of FAMILY_A_SIGNALS) {
      const ps = fa[sig];
      if (!ps) continue;
      const mu = ps.baseline_mean;
      const s2 = Math.max(ps.baseline_sigma_squared, 0);
      totalSignalsTested++;
      const seedBase = 0x53000000 + (cell.key.hour_of_day * 137 + cell.key.day_of_week * 41) * 100 + FAMILY_A_SIGNALS.indexOf(sig);
      const { fires, maxWealth } = singleDetectorSweep(mu, s2, seedBase);
      if (fires > 0) {
        cellFires += fires;
        const sigma = Math.sqrt(s2);
        console.log(`  ${fk.padEnd(6)}  ${sig.padEnd(20)} ${mu.toExponential(3).padEnd(11)}  ${sigma.toExponential(3).padEnd(10)}  ${String(fires).padStart(3)}/131  ${maxWealth.toFixed(2)}`);
      }
    }
    if (cellFires > 0) cellsWithFires++;
    totalCellsTested++;
  }
  console.log('');
  console.log(`Step 3 RESULT: ${cellsWithFires}/${totalCellsTested} firing cells reproduce when run at their exact (μ, σ_postfloor) per signal in isolation; total signal-trials with fires = visible above.`);
  if (cellsWithFires === 0) {
    console.log('  No (μ, σ) combo reproduces single-detector single-cell. Advance to Step 4 (6-signal concurrent).');
  } else {
    console.log('  Reproduction localized to specific (μ, σ) regimes — bug bisected to single-detector at certain calibrations. Halt + route through TPM.');
  }
} else if (STEP === 2) {
  // Step 2: large-μ at fixed σ=1. Tests whether μ scale alone matters.
  console.log('=== Step 2: large-μ sweep at σ=1 ===');
  console.log(`α_betting=${ALPHA_BETTING.toExponential(3)}; threshold=${THRESHOLD.toFixed(0)}; trials=${TRAJECTORIES}; ticks=${TICKS}`);
  console.log('');
  console.log('  μ            σ        fires     max_wealth   ratio_vs_α');
  const MUS = [0, 1, 10, 100, 1000, 10000];
  const results = [];
  for (let i = 0; i < MUS.length; i++) {
    const mu = MUS[i];
    const { fires, maxWealth } = singleDetectorSweep(mu, 1, 0x52000000 + i * 1000);
    const fpr = fires / TRAJECTORIES;
    const ratio = fpr / ALPHA_BETTING;
    results.push({ mu, fires, maxWealth, fpr, ratio });
    const flag = fires > 1 ? '  ← REPRO' : '';
    console.log(`  ${String(mu).padStart(8)}     1        ${String(fires).padStart(3)}/${TRAJECTORIES}  ${maxWealth.toFixed(2).padStart(11)}   ${ratio.toFixed(1)}×${flag}`);
  }
  console.log('');
  const reproCount = results.filter((r) => r.fires > 1).length;
  if (reproCount > 0) {
    console.log(`Step 2 RESULT: ${reproCount}/${MUS.length} μ regimes reproduce. μ-dependence localized.`);
  } else {
    console.log(`Step 2 RESULT: NO μ-only reproduction at σ=1. Advance to Step 3 (firing-cell (μ,σ) combos).`);
  }
}
