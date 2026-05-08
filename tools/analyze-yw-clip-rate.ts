// tools/analyze-yw-clip-rate.ts — Q66 item (h) follow-up.
//
// Standalone post-hoc static analyzer for Yule-Walker AR(1) phi
// clip-rate distribution across compiled configs. Reads per-cell
// `family_A.per_signal[<sig>].ar1_phi` from one or more compiled
// configs and reports the fraction of cells where |phi| ≥ 0.95
// (the architect's clip-boundary threshold per Q66 .A.b H1' spec).
//
// Per architect halt boundary "post-hoc static on existing ar1_phi
// field expected sufficient" — does not invoke any sweep machinery
// or Mac mini compute. Pure read-only inspection.
//
// Usage:
//   node tools/analyze-yw-clip-rate.ts \
//     --configs runs/compiled-configs/v5-q2-b-4-coherence.json,runs/compiled-configs/v8a-real-burstgpt-v1.json,... \
//     [--threshold 0.95] [--emit <path.json>]
//
// Acceptance per Q66 item (h) halt boundary (c): clip-rate must be
// < ~5% per substrate for empirical sweep PASS. This script reports
// per-substrate clip-rate so the operator can verify before+after
// dispatching the Mac mini sweep.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompiledConfig, BaselineCellEntry, FamilyAPerSignalParams } from '../engine/types';

const DEFAULT_CLIP_THRESHOLD = 0.95;

export interface PerSignalClipStat {
  signal: string;
  n_cells: number;
  n_clipped: number;
  clip_rate: number;
  /** Phi distribution summary for diagnostic; min/max give the
   *  range, mean centers the distribution. Cells with phi=0
   *  (degenerate input or pre-Q66.A.b configs) are included. */
  phi_min: number;
  phi_max: number;
  phi_mean: number;
}

export interface PerSubstrateClipReport {
  substrate_label: string;
  config_path: string;
  n_cells_total: number;
  n_signals_with_phi: number;
  per_signal: PerSignalClipStat[];
  /** Aggregated clip-rate across all (cell, signal) pairs that
   *  carry an ar1_phi field. Cells without phi are excluded. */
  aggregate_clip_rate: number;
  aggregate_n_cells_with_phi: number;
  aggregate_n_clipped: number;
}

export interface ClipRateReport {
  generated_at: string;
  clip_threshold: number;
  per_substrate: PerSubstrateClipReport[];
  /** Global clip-rate across all substrates × cells × signals. */
  global_clip_rate: number;
  global_n_cells_with_phi: number;
  global_n_clipped: number;
  /** Q66 item (h) halt-boundary (c) verdict: pass if every per-
   *  substrate clip-rate is below 5%. */
  halt_boundary_c_pass: boolean;
  halt_boundary_c_threshold: number;
}

const HALT_BOUNDARY_C_THRESHOLD = 0.05;

function listCellsWithFamilyA(cfg: CompiledConfig): BaselineCellEntry[] {
  const cells = cfg.baseline_cells?.cells ?? [];
  return cells.filter((c) => c.family_A !== undefined);
}

function collectPhiBySignal(
  cells: BaselineCellEntry[],
  aggregateFallback?: { family_A?: { per_signal: Record<string, FamilyAPerSignalParams> } },
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const cell of cells) {
    const perSignal = cell.family_A?.per_signal ?? {};
    for (const [sig, params] of Object.entries(perSignal)) {
      if (params.ar1_phi === undefined) continue;
      if (!out[sig]) out[sig] = [];
      out[sig].push(params.ar1_phi);
    }
  }
  // Aggregate fallback: include per-signal phi values from the
  // aggregate-fallback block since they're consumed by cells with
  // confidence ∈ {aggregate, none}. Avoid double-counting against
  // strict-confidence cells (those use direct family_A.per_signal).
  const fallback = aggregateFallback?.family_A?.per_signal ?? {};
  for (const [sig, params] of Object.entries(fallback)) {
    if (params.ar1_phi === undefined) continue;
    if (!out[sig]) out[sig] = [];
    out[sig].push(params.ar1_phi);
  }
  return out;
}

export function analyzeOneConfig(
  configPath: string,
  threshold: number,
  substrateLabel?: string,
): PerSubstrateClipReport {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as CompiledConfig;
  const cells = listCellsWithFamilyA(cfg);
  const perSignalPhis = collectPhiBySignal(cells, cfg.baseline_cells?.aggregate_fallback);
  const perSignal: PerSignalClipStat[] = [];
  let aggClipped = 0;
  let aggN = 0;
  for (const [sig, phis] of Object.entries(perSignalPhis)) {
    let nClipped = 0;
    let phiMin = Infinity;
    let phiMax = -Infinity;
    let phiSum = 0;
    for (const p of phis) {
      if (Math.abs(p) >= threshold) nClipped++;
      if (p < phiMin) phiMin = p;
      if (p > phiMax) phiMax = p;
      phiSum += p;
    }
    perSignal.push({
      signal: sig,
      n_cells: phis.length,
      n_clipped: nClipped,
      clip_rate: phis.length > 0 ? nClipped / phis.length : 0,
      phi_min: phis.length > 0 ? phiMin : 0,
      phi_max: phis.length > 0 ? phiMax : 0,
      phi_mean: phis.length > 0 ? phiSum / phis.length : 0,
    });
    aggClipped += nClipped;
    aggN += phis.length;
  }
  perSignal.sort((a, b) => b.clip_rate - a.clip_rate);
  return {
    substrate_label: substrateLabel ?? path.basename(configPath, '.json'),
    config_path: configPath,
    n_cells_total: cells.length,
    n_signals_with_phi: Object.keys(perSignalPhis).length,
    per_signal: perSignal,
    aggregate_clip_rate: aggN > 0 ? aggClipped / aggN : 0,
    aggregate_n_cells_with_phi: aggN,
    aggregate_n_clipped: aggClipped,
  };
}

export function analyzeConfigs(
  configPaths: ReadonlyArray<{ path: string; label?: string }>,
  threshold: number = DEFAULT_CLIP_THRESHOLD,
): ClipRateReport {
  const perSubstrate = configPaths.map(({ path: p, label }) =>
    analyzeOneConfig(p, threshold, label),
  );
  const globalClipped = perSubstrate.reduce((s, r) => s + r.aggregate_n_clipped, 0);
  const globalN = perSubstrate.reduce((s, r) => s + r.aggregate_n_cells_with_phi, 0);
  const haltBoundaryCPass = perSubstrate.every(
    (r) => r.aggregate_clip_rate < HALT_BOUNDARY_C_THRESHOLD,
  );
  return {
    generated_at: new Date().toISOString(),
    clip_threshold: threshold,
    per_substrate: perSubstrate,
    global_clip_rate: globalN > 0 ? globalClipped / globalN : 0,
    global_n_cells_with_phi: globalN,
    global_n_clipped: globalClipped,
    halt_boundary_c_pass: haltBoundaryCPass,
    halt_boundary_c_threshold: HALT_BOUNDARY_C_THRESHOLD,
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────

interface CliArgs {
  configs: string;
  threshold: number;
  emit?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = { threshold: DEFAULT_CLIP_THRESHOLD };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--configs':    out.configs = v; i++; break;
      case '--threshold':  out.threshold = parseFloat(v); i++; break;
      case '--emit':       out.emit = v; i++; break;
      default:
        if (k.startsWith('--')) throw new Error(`Unknown flag: ${k}`);
    }
  }
  if (!out.configs) {
    throw new Error(
      'Required: --configs <path1.json,path2.json,...> '
      + '[--threshold 0.95] [--emit <path>]',
    );
  }
  return out as CliArgs;
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const paths = args.configs.split(',').map((p) => ({ path: p.trim() }));
  const report = analyzeConfigs(paths, args.threshold);
  console.log(`[analyze-yw-clip-rate] threshold=${report.clip_threshold}`);
  console.log(`[analyze-yw-clip-rate] global clip-rate: ${(report.global_clip_rate * 100).toFixed(2)}% (${report.global_n_clipped}/${report.global_n_cells_with_phi} cells)`);
  for (const r of report.per_substrate) {
    console.log(
      `[analyze-yw-clip-rate]   ${r.substrate_label}: `
      + `clip-rate ${(r.aggregate_clip_rate * 100).toFixed(2)}% `
      + `(${r.aggregate_n_clipped}/${r.aggregate_n_cells_with_phi}); `
      + `top: ${r.per_signal.slice(0, 3).map((s) => `${s.signal} ${(s.clip_rate * 100).toFixed(1)}%`).join(', ')}`,
    );
  }
  console.log(
    `[analyze-yw-clip-rate] halt-boundary-c (per-substrate clip-rate < ${(HALT_BOUNDARY_C_THRESHOLD * 100).toFixed(0)}%): `
    + `${report.halt_boundary_c_pass ? 'PASS ✓' : 'FAIL ✗'}`,
  );
  if (args.emit) {
    fs.mkdirSync(path.dirname(args.emit), { recursive: true });
    fs.writeFileSync(args.emit, JSON.stringify(report, null, 2) + '\n');
    console.log(`[analyze-yw-clip-rate] emitted: ${args.emit}`);
  }
}

if (process.argv.some((a) => a === '--configs')) {
  main();
}
