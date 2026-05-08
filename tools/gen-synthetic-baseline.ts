// tools/gen-synthetic-baseline.ts — Week-1 NS synthetic healthy-baseline generator.
//
// Produces a BaselineBundle (one JSONL file per invocation, plus a manifest.json)
// for the calibration compiler (tools/calibrate.ts) to consume.
//
// Each signal is modeled as:
//   x_t = μ * (1 + drift_t + loadings · F_t + ε_t + tenantOffset)
//
//   drift_t       — slow sinusoid, amplitude ≲ 0.01 (captures within-deploy drift)
//   F_t           — two latent factors: latency & utilization (shared across
//                   signals, produces p99/ttft correlation and mfu/cost correlation
//                   per handoff acceptance)
//   ε_t           — per-signal AR(1) private noise
//   tenantOffset  — fixed per-tenant per-signal bias
//
// Deterministic: same seed → byte-identical output on two invocations.
// Output: runs/baselines/<out>/bundle.jsonl + manifest.json + README.md
//
// CLI (Node 25 runs .ts natively; no tsx needed):
//   node tools/gen-synthetic-baseline.ts \
//     --out runs/baselines/synthetic-v1 --n 500 --ticks 32 --tenants 4 --seed 42

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BaselineBundle } from '../engine/types';

// ── Deterministic PRNG (mulberry32) ──────────────────────────────
// Pure function of u32 state; no Math.random. Two invocations with the same
// seed produce identical streams on any machine.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller: pairs of independent N(0,1). We draw a pair and return both so
 * the stream is fully consumed (no discarded values that would silently affect
 * determinism if we later added a second RNG consumer). */
function gaussian(rng: () => number): number {
  // Guard u against exactly 0 → log(0) = -Inf.
  let u = rng(); while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── Signal configuration ─────────────────────────────────────────
// Healthy means are pulled from the "clean" scenario in shared.js. Loadings
// produce ≥0.3 Pearson between (p99, ttft) via the shared latency factor and
// between (mfu, cost_req) via the utilization factor — per WEEK1-HANDOFF.md
// §1.1.c acceptance. Private std per signal is tuned so the 99.9th percentile
// of |ratio - 1| lands near today's hand-tuned threshold (1.20 p99/ttft,
// 1.25 tokens, 1.20 cost, 1.18 behavioral, 1.50 downstream — see
// engine/gates/policy.ts THRESHOLD_PROFILES._default).
//
// Week 2 addition (PM-critique item 2): diurnal structure. Each run carries
// an `hour_of_day[]` array, and each signal gets a multiplicative diurnal
// component cos((h - phase) · 2π/24) · amplitude so the compiler can derive
// per-hour Family A priors. Amplitude default 0.10, phase default 14 (2pm
// peak). Runs span 32 ticks at 1-per-hour, so each covers ~1.3 diurnal cycles.
interface SignalCfg {
  mean: number;
  latencyLoading: number;
  utilLoading: number;
  privateStd: number;
  /** Optional hard clamp (e.g. kv_cache ∈ [0, 1]). */
  min?: number;
  max?: number;
}

const SIGNALS: Record<string, SignalCfg> = {
  p99_latency:    { mean: 185,    latencyLoading: 1.00, utilLoading: 0.00, privateStd: 0.02 },
  ttft:           { mean: 220,    latencyLoading: 0.80, utilLoading: 0.00, privateStd: 0.025 },
  tokens_turn:    { mean: 418,    latencyLoading: 0.00, utilLoading: 0.40, privateStd: 0.06 },
  kv_cache:       { mean: 0.89,   latencyLoading: 0.00, utilLoading: 0.00, privateStd: 0.015, min: 0, max: 1 },
  cost_req:       { mean: 0.0042, latencyLoading: 0.00, utilLoading: 0.50, privateStd: 0.04 },
  downstream_err: { mean: 0.12,   latencyLoading: 0.00, utilLoading: 0.00, privateStd: 0.16 },
  mfu:            { mean: 0.72,   latencyLoading: 0.00, utilLoading: 0.50, privateStd: 0.02, min: 0, max: 1 },
  hbm_spill:      { mean: 0.02,   latencyLoading: 0.00, utilLoading: 0.00, privateStd: 0.06 },
  collective_ops: { mean: 0.9997, latencyLoading: 0.00, utilLoading: 0.00, privateStd: 0.0002, min: 0, max: 1 },
  corpus_delta:   { mean: 0.04,   latencyLoading: 0.00, utilLoading: 0.00, privateStd: 0.045 },
  traffic_pct:    { mean: 1.0,    latencyLoading: 0.00, utilLoading: 0.00, privateStd: 0.02, min: 0, max: 1.2 },
  eval_score:     { mean: 0.85,   latencyLoading: 0.00, utilLoading: 0.00, privateStd: 0.012, min: 0, max: 1 },
  refusal_rate:   { mean: 0.02,   latencyLoading: 0.00, utilLoading: 0.00, privateStd: 0.08, min: 0 },
  output_len_p50: { mean: 220,    latencyLoading: 0.00, utilLoading: 0.20, privateStd: 0.03 },
  // W2: added so Family A can derive priors for tool_success_rate (one of the
  // 6 primary SLIs per roadmap §Week 2). Healthy range [0.50, 0.999] per
  // runner.js; privateStd tuned conservatively so post-diurnal values stay
  // inside the clamp most of the time.
  tool_success_rate: { mean: 0.95, latencyLoading: 0.00, utilLoading: 0.00, privateStd: 0.010, min: 0.50, max: 0.999 },
};

// Latent factors: zero-mean normal. std tuned so the shared component dominates
// private noise for the correlated pairs while leaving private noise enough
// bandwidth to keep 99.9th-percentile ratios near legacy cutoffs.
const LATENCY_FACTOR_STD = 0.055;
const UTIL_FACTOR_STD    = 0.050;

const AR1_PHI = 0.30;   // persistence for private-noise process
const DRIFT_AMP = 0.008;

// Diurnal defaults (W2). Amplitude = 10% of signal mean at peak; phase = 14
// puts the peak at 2pm. Trough at 2am (phase+12 wrap).
const DEFAULT_DIURNAL_AMP = 0.10;
const DEFAULT_DIURNAL_PHASE = 14;
// Day-of-week diurnal (W3). Amplitude half the hour amplitude so the week
// structure doesn't dominate the hour-of-day signal. Phase = 3 puts the
// weekly peak midweek (day 3 = Wednesday with Sun=0); weekends (6, 0) sit
// at the trough, separating weekday and weekend patterns in the
// baseline — Family C's motivation for hour × day cells.
const DEFAULT_DOW_DIURNAL_AMP = 0.05;
const DEFAULT_DOW_DIURNAL_PHASE = 3;

// ── Generation ───────────────────────────────────────────────────

interface Args {
  out: string;
  n: number;
  ticks: number;
  tenants: number;
  seed: number;
  hourDiurnalAmp: number;
  hourDiurnalPhase: number;
  dowDiurnalAmp: number;
  dowDiurnalPhase: number;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1] !== undefined) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return {
    out:              args.out     ?? 'runs/baselines/synthetic-v1',
    n:                args.n       ? parseInt(args.n, 10)       : 500,
    ticks:            args.ticks   ? parseInt(args.ticks, 10)   : 32,
    tenants:          args.tenants ? parseInt(args.tenants, 10) : 4,
    seed:             args.seed    ? parseInt(args.seed, 10)    : 42,
    hourDiurnalAmp:   args.hour_diurnal_amplitude ? parseFloat(args.hour_diurnal_amplitude) : DEFAULT_DIURNAL_AMP,
    hourDiurnalPhase: args.hour_diurnal_phase     ? parseFloat(args.hour_diurnal_phase)     : DEFAULT_DIURNAL_PHASE,
    dowDiurnalAmp:   args.day_of_week_diurnal_amplitude ? parseFloat(args.day_of_week_diurnal_amplitude) : DEFAULT_DOW_DIURNAL_AMP,
    dowDiurnalPhase: args.day_of_week_diurnal_phase     ? parseFloat(args.day_of_week_diurnal_phase)     : DEFAULT_DOW_DIURNAL_PHASE,
  };
}

interface RunOutput {
  signal_series: Record<string, number[]>;
  hour_of_day: number[];
  day_of_week: number[];
}

function generateRun(
  rng: () => number,
  ticks: number,
  tenantId: string,
  tenantOffsets: Record<string, number>,
  diurnalAmp: number,
  diurnalPhase: number,
  dowDiurnalAmp: number,
  dowDiurnalPhase: number,
): RunOutput {
  const series: Record<string, number[]> = {};
  for (const k of Object.keys(SIGNALS)) series[k] = new Array(ticks);
  const hourOfDay: number[] = new Array(ticks);
  const dayOfWeek: number[] = new Array(ticks);

  // Pre-allocate AR(1) state per signal.
  const arState: Record<string, number> = {};
  for (const k of Object.keys(SIGNALS)) arState[k] = gaussian(rng) * SIGNALS[k].privateStd;

  // Per-run drift phase so different runs aren't identical.
  const driftPhase = rng() * 2 * Math.PI;
  const driftPeriod = 6 + rng() * 10;  // period in ticks
  // Per-run start hour and start day. Each run begins at a deterministic
  // (hour_of_day, day_of_week) drawn from the RNG. Uniform starts across
  // runs balance per-cell sample counts across the 168 (24×7) cells.
  const startHour = Math.floor(rng() * 24);
  const startDay  = Math.floor(rng() * 7);

  for (let t = 0; t < ticks; t++) {
    const absHour = startHour + t;
    const h = absHour % 24;
    const d = (startDay + Math.floor(absHour / 24)) % 7;
    hourOfDay[t] = h;
    dayOfWeek[t] = d;
    // cos((h - phase) · 2π/24): peak at h=phase, trough 12 hours away.
    const diurnalH = diurnalAmp * Math.cos((h - diurnalPhase) * 2 * Math.PI / 24);
    // cos((d - phase) · 2π/7): peak at d=phase (default Wed), trough over
    // the weekend (Sat/Sun).
    const diurnalD = dowDiurnalAmp * Math.cos((d - dowDiurnalPhase) * 2 * Math.PI / 7);

    const drift = DRIFT_AMP * Math.sin(driftPhase + 2 * Math.PI * t / driftPeriod);
    const latencyFactor = gaussian(rng) * LATENCY_FACTOR_STD;
    const utilFactor    = gaussian(rng) * UTIL_FACTOR_STD;

    for (const k of Object.keys(SIGNALS)) {
      const cfg = SIGNALS[k];
      // AR(1): ε_t = φ·ε_{t-1} + sqrt(1-φ²)·σ·z_t so stationary std stays = σ.
      const innovation = gaussian(rng) * cfg.privateStd * Math.sqrt(1 - AR1_PHI * AR1_PHI);
      arState[k] = AR1_PHI * arState[k] + innovation;

      const rel = 1 + drift
                    + diurnalH
                    + diurnalD
                    + cfg.latencyLoading * latencyFactor
                    + cfg.utilLoading    * utilFactor
                    + arState[k]
                    + (tenantOffsets[k] ?? 0);
      let val = cfg.mean * rel;
      if (cfg.min !== undefined) val = Math.max(cfg.min, val);
      if (cfg.max !== undefined) val = Math.min(cfg.max, val);
      series[k][t] = val;
    }
  }

  return { signal_series: series, hour_of_day: hourOfDay, day_of_week: dayOfWeek };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const rng = mulberry32(args.seed);

  // Pre-compute tenant offsets deterministically before generating runs.
  const tenantOffsets: Record<string, Record<string, number>> = {};
  for (let t = 0; t < args.tenants; t++) {
    const id = `tenant-${t}`;
    tenantOffsets[id] = {};
    for (const k of Object.keys(SIGNALS)) {
      // ±0.008 offset per signal per tenant.
      tenantOffsets[id][k] = (rng() - 0.5) * 0.016;
    }
  }

  const runs: BaselineBundle['runs'] = [];
  // Per-cell sample counts so the generator can warn on sparse cells (W3
  // acceptance: warn if any of the 168 cells drops below 20 samples).
  const cellCounts = new Array(24 * 7).fill(0);
  for (let r = 0; r < args.n; r++) {
    const tenant = `tenant-${r % args.tenants}`;
    const { signal_series, hour_of_day, day_of_week } = generateRun(
      rng, args.ticks, tenant, tenantOffsets[tenant],
      args.hourDiurnalAmp, args.hourDiurnalPhase,
      args.dowDiurnalAmp, args.dowDiurnalPhase,
    );
    runs.push({ tenant_id: tenant, signal_series, hour_of_day, day_of_week });
    for (let t = 0; t < args.ticks; t++) {
      cellCounts[day_of_week[t] * 24 + hour_of_day[t]]++;
    }
  }

  const bundle: BaselineBundle = {
    version: 'synthetic-v1',
    generated_at: new Date(0).toISOString(), // fixed; seed-determinism means
                                              // we deliberately drop wall-clock
                                              // time from the output
    seed: args.seed,
    cell_dim: 'hour_of_day_x_day_of_week',
    runs,
  };

  const bundlePath = path.join(outDir, 'bundle.jsonl');
  // Stream one run per line so large bundles don't blow RAM on the compiler side.
  const fd = fs.openSync(bundlePath, 'w');
  try {
    for (const run of bundle.runs) fs.writeSync(fd, JSON.stringify(run) + '\n');
  } finally {
    fs.closeSync(fd);
  }

  // Manifest = header minus runs (small, one file, human-readable).
  const manifest = {
    version: bundle.version,
    generated_at: bundle.generated_at,
    seed: bundle.seed,
    cell_dim: bundle.cell_dim,
    n_runs: bundle.runs.length,
    ticks_per_run: args.ticks,
    tenants: args.tenants,
    signals: Object.keys(SIGNALS),
    factor_stds: { latency: LATENCY_FACTOR_STD, utilization: UTIL_FACTOR_STD },
    ar1_phi: AR1_PHI,
    hour_diurnal_amplitude: args.hourDiurnalAmp,
    hour_diurnal_phase: args.hourDiurnalPhase,
    day_of_week_diurnal_amplitude: args.dowDiurnalAmp,
    day_of_week_diurnal_phase: args.dowDiurnalPhase,
  };

  // Per-W3 §3.1.b acceptance: warn if any 2-D cell drops below 20 samples.
  let minCell = Infinity, sparseCount = 0;
  for (const c of cellCounts) {
    if (c < minCell) minCell = c;
    if (c < 20) sparseCount++;
  }
  if (sparseCount > 0) {
    console.warn(`WARN: ${sparseCount}/168 cells below 20 samples (min=${minCell}). Compiler will pool or fall back for these.`);
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Short README documenting the output format. Keeps the compiler's
  // assumptions about structure in one place alongside the data.
  const readme =
`# ${path.basename(outDir)}

Synthetic healthy-baseline bundle, emitted by \`tools/gen-synthetic-baseline.ts\`.

## Files
- \`manifest.json\` — header (version, seed, n_runs, ticks, signals, factor stds)
- \`bundle.jsonl\` — one run per line; each line = \`{ tenant_id, signal_series: { <signal>: number[ticks] }, hour_of_day: number[ticks] }\` (W2: hour_of_day per-tick labels enable cell-wise compilation)

## Determinism
Seeded with \`--seed ${args.seed}\` → identical bytes on re-run. Verify with \`diff bundle.jsonl <re-run>/bundle.jsonl\`.

## Consumption
\`tools/calibrate.ts\` loads \`bundle.jsonl\` line-by-line and reconstructs a \`BaselineBundle\` (see \`engine/types.ts\`).
`;
  fs.writeFileSync(path.join(outDir, 'README.md'), readme);

  console.log(`Wrote ${bundle.runs.length} runs × ${args.ticks} ticks × ${Object.keys(SIGNALS).length} signals → ${outDir}`);
}

main();
