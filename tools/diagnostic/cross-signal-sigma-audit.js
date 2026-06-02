#!/usr/bin/env node
// tools/diagnostic/cross-signal-sigma-audit.js — V1.H1 cross-signal grep
// per ARCHITECT-REPLY-52ge §79-124. Three-layer diagnostic before P1
// variance-floor brief lands.
//
// Layer 1 — per-signal σ²/cv distribution histogram (CSV + summary stats).
// Layer 2 — pre-P1-floor RED flag identification (cv < 1e-3).
// Layer 3 — post-P1-floor predicted clipping rate (re-reads baseline
//           bundle for sample-level ground truth).
//
// Anti-scope: no fix code; diagnostic-only. Read-only on v5 + bundle.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const CFG_PATH = path.join(ROOT, 'runs/compiled-configs/v5-sequential-e-process.json');
const BUNDLE_PATH = path.join(ROOT, 'runs/baselines/synthetic-v1/bundle.jsonl');
const MANIFEST_PATH = path.join(ROOT, 'runs/baselines/synthetic-v1/manifest.json');
const OUT_DIR = path.join(ROOT, 'runs/diagnostics');

const FAMILY_A_SIGNALS = [
  'p99_latency', 'ttft', 'eval_score',
  'tool_success_rate', 'downstream_err', 'cost_req',
];

const CV_RED_THRESHOLD = 1e-3;
const VARIANCE_FLOOR_COEFF = 1e-6;        // sigma²_floor = 1e-6 · μ²
const POSTFLOOR_CLIP_RATE_INSUFFICIENT = 0.01;  // > 1% clip = P1-INSUFFICIENT
const BOUNDED_SCALE_B = 3;                // matches betting-e-process

function quantile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1,
    Math.max(0, Math.floor(p * sortedArr.length)));
  return sortedArr[idx];
}

function readCellSamples(bundlePath, manifestPath) {
  // Synthetic-v1: hour_of_day + day_of_week are PER-TICK arrays.
  // Build a Map<"h-d", { signal: number[] }> by collecting samples
  // from all runs at ticks where (hour, day) match.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const signals = manifest.signals;
  const cellSamples = new Map();  // "h-d" → { signal: [values] }
  const lines = fs.readFileSync(bundlePath, 'utf8').trim().split('\n');
  for (const line of lines) {
    const r = JSON.parse(line);
    if (!r.signal_series) continue;
    const hods = r.hour_of_day, dows = r.day_of_week;
    if (!Array.isArray(hods) || !Array.isArray(dows)) continue;
    const len = Math.min(hods.length, dows.length,
      r.signal_series[signals[0]]?.length ?? 0);
    for (let t = 0; t < len; t++) {
      const h = hods[t], d = dows[t];
      const key = `${h}-${d}`;
      let entry = cellSamples.get(key);
      if (!entry) {
        entry = {};
        for (const s of signals) entry[s] = [];
        cellSamples.set(key, entry);
      }
      for (const s of signals) {
        const v = r.signal_series[s]?.[t];
        if (v !== undefined) entry[s].push(v);
      }
    }
  }
  return cellSamples;
}

function computePerSignalRecords(allCells) {
  // Per-signal CSV + summary stats.
  const perSignalRecords = {};   // signal → [{cell_key, mu, sigma_squared, cv_squared, cv}]
  for (const sig of FAMILY_A_SIGNALS) perSignalRecords[sig] = [];

  for (const cell of allCells) {
    const fa = cell.family_A?.per_signal;
    if (!fa) continue;
    const cellKey = JSON.stringify(cell.key);
    for (const sig of FAMILY_A_SIGNALS) {
      const ps = fa[sig];
      if (!ps) continue;
      const mu = ps.baseline_mean;
      const s2 = ps.baseline_sigma_squared;
      if (mu === undefined || s2 === undefined) continue;
      const cv2 = (mu !== 0) ? s2 / (mu * mu) : Infinity;
      const cv = (mu !== 0) ? Math.sqrt(s2) / Math.abs(mu) : Infinity;
      perSignalRecords[sig].push({
        cell_key: cellKey, mu, sigma_squared: s2, cv_squared: cv2, cv,
        confidence: cell.confidence,
      });
    }
  }
  return perSignalRecords;
}

function runLayer1(perSignalRecords) {
  console.log('\n[v1.h1-grep] LAYER 1 — per-signal CV distribution:');
  console.log('  signal               n_cells  cv_min     cv_p25     cv_median  cv_p75     cv_p99     cv_max');
  for (const sig of FAMILY_A_SIGNALS) {
    const recs = perSignalRecords[sig];
    if (recs.length === 0) {
      console.log(`  ${sig.padEnd(20)} (no entries)`);
      continue;
    }
    const cvs = recs.map((r) => r.cv).filter(Number.isFinite).sort((a, b) => a - b);
    const fmt = (x) => x === null ? '-' : x.toExponential(2);
    console.log(
      `  ${sig.padEnd(20)} ${String(cvs.length).padEnd(8)} ` +
      `${fmt(cvs[0]).padEnd(10)} ${fmt(quantile(cvs, 0.25)).padEnd(10)} ` +
      `${fmt(quantile(cvs, 0.5)).padEnd(10)} ${fmt(quantile(cvs, 0.75)).padEnd(10)} ` +
      `${fmt(quantile(cvs, 0.99)).padEnd(10)} ${fmt(cvs[cvs.length - 1])}`);

    // Emit CSV
    const csvPath = path.join(OUT_DIR, `signal-distribution-${sig}.csv`);
    const lines = ['cell_key,confidence,mu,sigma_squared,cv_squared,cv'];
    for (const r of recs) {
      lines.push(`${JSON.stringify(r.cell_key)},${r.confidence},` +
        `${r.mu},${r.sigma_squared},${r.cv_squared},${r.cv}`);
    }
    fs.writeFileSync(csvPath, lines.join('\n') + '\n');
  }
  console.log(`[v1.h1-grep] wrote 6 per-signal CSVs to ${path.relative(ROOT, OUT_DIR)}/`);
}

function runLayer2(perSignalRecords, allCells) {
  // RED flags: cv < 1e-3 → would trigger P1 floor.
  console.log('\n[v1.h1-grep] LAYER 2 — RED flag identification (cv < 1e-3):');
  console.log('  signal               RED_count / total_cells   RED_pct');
  const redFlagsBySignal = {};
  for (const sig of FAMILY_A_SIGNALS) {
    const recs = perSignalRecords[sig];
    const red = recs.filter((r) => r.cv < CV_RED_THRESHOLD);
    redFlagsBySignal[sig] = red;
    const pct = recs.length > 0 ? (100 * red.length / recs.length) : 0;
    console.log(`  ${sig.padEnd(20)} ${String(red.length).padStart(4)} / ${String(recs.length).padStart(4)}            ` +
      `${pct.toFixed(1)}%`);
  }
  // Emit summary
  const sumPath = path.join(OUT_DIR, 'red-flags-summary.txt');
  const sumLines = [
    'V1.H1 cross-signal RED-flag summary (cv < 1e-3) — generated 2026-04-26',
    `compiled config: ${path.relative(ROOT, CFG_PATH)}`,
    `total cells: ${allCells.length}`,
    '',
    'signal_name         | RED_count | total_cells | RED_pct',
    '--------------------|-----------|-------------|--------',
  ];
  for (const sig of FAMILY_A_SIGNALS) {
    const recs = perSignalRecords[sig];
    const red = redFlagsBySignal[sig];
    const pct = recs.length > 0 ? (100 * red.length / recs.length).toFixed(1) : '0.0';
    sumLines.push(`${sig.padEnd(20)} | ${String(red.length).padStart(9)} | ${String(recs.length).padStart(11)} | ${pct.padStart(6)}%`);
  }
  fs.writeFileSync(sumPath, sumLines.join('\n') + '\n');
  return redFlagsBySignal;
}

function runLayer3(redFlagsBySignal, cellSamples) {
  // Post-P1-floor predicted clipping rate. For each RED (signal, cell),
  // simulate σ_postfloor = max(σ_empirical, sqrt(VARIANCE_FLOOR_COEFF · μ²))
  // and count what fraction of baseline samples lie outside ±3·σ_postfloor
  // around μ. > 0.01 → P1-INSUFFICIENT (asymmetric H₀ bias persists).
  console.log('\n[v1.h1-grep] LAYER 3 — post-P1-floor clipping-rate analysis:');
  const insufficient = [];
  for (const sig of FAMILY_A_SIGNALS) {
    const reds = redFlagsBySignal[sig];
    if (reds.length === 0) continue;
    let p1InsufficientCount = 0;
    for (const r of reds) {
      const cellKey = JSON.parse(r.cell_key);
      const sampleKey = `${cellKey.hour_of_day}-${cellKey.day_of_week}`;
      const samples = cellSamples.get(sampleKey)?.[sig];
      if (!samples || samples.length === 0) continue;
      // Empirical σ from samples
      let sum = 0, sumSq = 0;
      for (const x of samples) { sum += x; sumSq += x * x; }
      const empMean = sum / samples.length;
      const empVar = Math.max(0, sumSq / samples.length - empMean * empMean);
      const sigmaEmp = Math.sqrt(empVar);
      const sigmaFloor = Math.sqrt(VARIANCE_FLOOR_COEFF * r.mu * r.mu);
      const sigmaPostfloor = Math.max(sigmaEmp, sigmaFloor);
      // Predicted clipping rate (using compiled-config baseline mean μ
      // since runtime z = (x − μ_calibration) / (B · σ_postfloor)).
      let clipped = 0;
      for (const x of samples) {
        if (Math.abs(x - r.mu) > BOUNDED_SCALE_B * sigmaPostfloor) clipped++;
      }
      const clipRate = clipped / samples.length;
      if (clipRate > POSTFLOOR_CLIP_RATE_INSUFFICIENT) {
        p1InsufficientCount++;
        insufficient.push({
          signal: sig, cell_key: r.cell_key,
          mu: r.mu, sigma_empirical: sigmaEmp,
          sigma_postfloor: sigmaPostfloor,
          predicted_clip_rate: clipRate,
        });
      }
    }
    console.log(`  ${sig.padEnd(20)} P1-INSUFFICIENT ${p1InsufficientCount} / ${reds.length} RED cells`);
  }
  // Emit P1-INSUFFICIENT cells list
  const insufPath = path.join(OUT_DIR, 'p1-insufficient-cells.txt');
  const insufLines = [
    'V1.H1 P1-INSUFFICIENT cells (post-P1-floor predicted clipping rate > 1%)',
    `floor coefficient ε_f = ${VARIANCE_FLOOR_COEFF} (σ²_floor = ε_f · μ²)`,
    `bounded-z scale B = ${BOUNDED_SCALE_B}`,
    `clip-rate insufficient threshold = ${POSTFLOOR_CLIP_RATE_INSUFFICIENT}`,
    '',
    'signal_name        | cell_key                                 | mu          | sigma_empirical  | sigma_postfloor  | clip_rate',
    '-------------------|------------------------------------------|-------------|------------------|------------------|----------',
  ];
  insufficient.sort((a, b) => b.predicted_clip_rate - a.predicted_clip_rate);
  for (const r of insufficient) {
    insufLines.push(
      `${r.signal.padEnd(18)} | ${r.cell_key.padEnd(40)} | ${r.mu.toExponential(3).padEnd(11)} | ${r.sigma_empirical.toExponential(3).padEnd(16)} | ${r.sigma_postfloor.toExponential(3).padEnd(16)} | ${r.predicted_clip_rate.toFixed(4)}`);
  }
  fs.writeFileSync(insufPath, insufLines.join('\n') + '\n');
  console.log(`\n[v1.h1-grep] P1-INSUFFICIENT total: ${insufficient.length} (cv-thresh ${CV_RED_THRESHOLD}, clip-thresh ${POSTFLOOR_CLIP_RATE_INSUFFICIENT})`);
  console.log(`[v1.h1-grep] outputs:`);
  console.log(`  ${path.relative(ROOT, OUT_DIR)}/signal-distribution-<signal>.csv (×6)`);
  console.log(`  ${path.relative(ROOT, OUT_DIR)}/red-flags-summary.txt`);
  console.log(`  ${path.relative(ROOT, OUT_DIR)}/p1-insufficient-cells.txt`);
}

function runArchitectComparison(redFlagsBySignal, perSignalRecords) {
  // Architect-prediction comparison
  console.log('\n[v1.h1-grep] architect prediction comparison:');
  const predicted = {
    tool_success_rate: 600, eval_score: 500, downstream_err: 400,
    p99_latency: 5, ttft: 5, cost_req: 5,
  };
  for (const sig of FAMILY_A_SIGNALS) {
    const observed = redFlagsBySignal[sig].length;
    const pred = predicted[sig];
    const total = perSignalRecords[sig].length;
    const dev = Math.abs(observed - pred);
    const tag = (dev > 50 || (pred < 50 && observed > 50)) ? 'DEVIATION' : 'in-line';
    console.log(`  ${sig.padEnd(20)} predicted=${String(pred).padStart(4)}  observed=${String(observed).padStart(4)} / ${total}  ${tag}`);
  }
}

function main() {
  console.log('[v1.h1-grep] reading v5 compiled config...');
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const allCells = cfg.baseline_cells.cells;
  console.log(`[v1.h1-grep]   ${allCells.length} cells in v5`);

  console.log('[v1.h1-grep] reading bundle samples...');
  const cellSamples = readCellSamples(BUNDLE_PATH, MANIFEST_PATH);
  console.log(`[v1.h1-grep]   ${cellSamples.size} distinct cells in bundle`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ── LAYER 1 ──────────────────────────────────────────────────────
  const perSignalRecords = computePerSignalRecords(allCells);
  runLayer1(perSignalRecords);

  // ── LAYER 2 ──────────────────────────────────────────────────────
  const redFlagsBySignal = runLayer2(perSignalRecords, allCells);

  // ── LAYER 3 ──────────────────────────────────────────────────────
  runLayer3(redFlagsBySignal, cellSamples);

  runArchitectComparison(redFlagsBySignal, perSignalRecords);
}

main();
