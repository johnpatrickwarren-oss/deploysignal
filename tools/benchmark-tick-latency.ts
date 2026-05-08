// tools/benchmark-tick-latency.ts — per-tick gate-evaluation latency benchmark.
//
// Measures the cost of a single orchestrator evaluation across the full
// post-SOTA-Tier-1 surface: Family A (Page-CUSUM + betting e-processes),
// Family B (structural), Family C (Hotelling T² + Sequential MMD with
// MCD/MRCD/Ledoit-Wolf covariance paths), Family D (spectral ACF + BOCPD),
// Family E (weighted conformal). Exercises the same `orchestrate()` entry
// point the test suite and runtime use, with default NoOp lifecycle emitter
// (Addition #14) and NoOp reversibility source (Addition #5).
//
// Scenarios:
//   - demo-clean            (healthy path — no fires, full detector evaluation)
//   - demo-anthropic-2025   (regression path — C+E co-fire at t=11)
//
// Both drive the `v4-fusion-novelty` compiled config in portfolio mode so
// every family is active. The scenarios each carry 32 ticks; we loop the
// tick array across fresh 32-tick deploy simulations to build up 1000 warm-up
// ticks + 5000 measured ticks per scenario.
//
// Output:
//   runs/benchmarks/tick-latency-baseline.json — machine-readable evidence
//   stdout — human-readable summary
//
// Invocation:
//   npm run build && tsc -p tsconfig.test.json
//   node tools/benchmark-tick-latency.js

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CompiledConfig, OrchestrateParams,
} from '../engine/types';

const ROOT = path.resolve(__dirname, '..');
const DEMOS_DIR = path.join(ROOT, 'demos', 'scripts');
const V4_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');
const OUT_PATH = path.join(ROOT, 'runs', 'benchmarks', 'tick-latency-baseline.json');

const WARMUP_TICKS = 1000;
const MEASURED_TICKS = 5000;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

// Mirror demos/demo.template.html / canned-demo-right-reasons test helper.
// Applies the demo's cell_patch onto the compiled config so the scenario's
// baseline + calibration lands on the target cell the detectors evaluate
// against — required for the detector surface to be exercised as designed.
function applyCellPatch(src: CompiledConfig, patch: any): CompiledConfig {
  if (!src || !patch) return src;
  const cfg = JSON.parse(JSON.stringify(src)) as CompiledConfig;
  const target = patch.target_cell || {};
  const cell = (cfg.baseline_cells?.cells || []).find((c: any) =>
    c.key && c.key.hour_of_day === target.hour_of_day && c.key.day_of_week === target.day_of_week);
  if (!cell) return cfg;
  if (patch.family_A_per_signal && (cell as any).family_A) {
    for (const sig of Object.keys(patch.family_A_per_signal)) {
      (cell as any).family_A.per_signal[sig] = patch.family_A_per_signal[sig];
    }
  }
  if (patch.family_C_mean_vector && (cell as any).family_C) {
    (cell as any).family_C.mean_vector = patch.family_C_mean_vector.slice();
  }
  return cfg;
}

interface Stats {
  scenario: string;
  n_warmup: number;
  n_measured: number;
  median_ns: number;
  p95_ns: number;
  p99_ns: number;
  p999_ns: number;
  max_ns: number;
  min_ns: number;
  mean_ns: number;
  stddev_ns: number;
  median_us: number;
  p99_us: number;
  max_ms: number;
  short_circuits_during_measured: number;
}

function computeStats(scenario: string, latencies: Float64Array, shortCircuits: number): Stats {
  const sorted = Float64Array.from(latencies).sort();
  const n = sorted.length;
  const pick = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const mean = sum / n;
  let sqErr = 0;
  for (let i = 0; i < n; i++) { const d = sorted[i] - mean; sqErr += d * d; }
  const stddev = Math.sqrt(sqErr / n);
  const median = pick(0.5);
  const p95 = pick(0.95);
  const p99 = pick(0.99);
  const p999 = pick(0.999);
  const max = sorted[n - 1];
  const min = sorted[0];
  return {
    scenario,
    n_warmup: WARMUP_TICKS,
    n_measured: n,
    median_ns: median,
    p95_ns: p95,
    p99_ns: p99,
    p999_ns: p999,
    max_ns: max,
    min_ns: min,
    mean_ns: mean,
    stddev_ns: stddev,
    median_us: +(median / 1000).toFixed(3),
    p99_us:    +(p99    / 1000).toFixed(3),
    max_ms:    +(max    / 1e6 ).toFixed(3),
    short_circuits_during_measured: shortCircuits,
  };
}

// Run one deploy simulation of `demo.ticks.length` ticks, invoking the
// orchestrator exactly as a canary harness would. State (TrendBuffer,
// detector sequential state) is held per-deploy and discarded between
// deploys. Returns one latency sample per tick evaluated.
function runOneDeploy(
  demo: any,
  cfg: CompiledConfig,
  samples: Float64Array,
  offset: number,
  budget: number,
): { consumed: number; shortCircuits: number } {
  const tb = new TrendBuffer(10);
  const totalTicks = demo.ticks.length;
  let shortCircuits = 0;
  let consumed = 0;
  for (let t = 0; t < totalTicks && consumed < budget; t++) {
    const live = demo.ticks[t].metrics;
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live,
      scenario: demo,
      hoursElapsed: t * (demo.bakeHours / totalTicks),
      trendBuffer: tb,
      tick: t,
      totalTicks,
      compiledConfig: cfg,
      currentHourOfDay: demo.currentHourOfDay,
      currentDayOfWeek: demo.currentDayOfWeek,
      fusionTopology: 'portfolio',
    };
    const t0 = process.hrtime.bigint();
    const res = orchestrate(params);
    const t1 = process.hrtime.bigint();
    samples[offset + consumed] = Number(t1 - t0);
    if (res.shortCircuit) shortCircuits++;
    consumed++;
  }
  return { consumed, shortCircuits };
}

// Fill `samples` with `target` latency observations by looping fresh
// deploy simulations until we have enough measurements. Returns the number
// of short-circuit ticks observed during the window.
function fillSamples(
  demo: any,
  cfg: CompiledConfig,
  samples: Float64Array,
  target: number,
): number {
  let filled = 0;
  let shortCircuits = 0;
  while (filled < target) {
    const { consumed, shortCircuits: sc } = runOneDeploy(
      demo, cfg, samples, filled, target - filled,
    );
    filled += consumed;
    shortCircuits += sc;
    if (consumed === 0) break; // safety: empty scenario
  }
  return shortCircuits;
}

function benchmarkScenario(demoName: string, v4: CompiledConfig): Stats {
  const demo = JSON.parse(fs.readFileSync(path.join(DEMOS_DIR, `${demoName}.json`), 'utf8'));
  const cfg = applyCellPatch(v4, demo.cell_patch);

  // Warm-up — discarded. JIT + detector state settle in.
  const warm = new Float64Array(WARMUP_TICKS);
  fillSamples(demo, cfg, warm, WARMUP_TICKS);

  // Measured window.
  const measured = new Float64Array(MEASURED_TICKS);
  const shortCircuits = fillSamples(demo, cfg, measured, MEASURED_TICKS);

  return computeStats(demoName, measured, shortCircuits);
}

function formatStats(s: Stats): string {
  return [
    `  ${s.scenario}`,
    `    median    : ${(s.median_ns / 1000).toFixed(2)} μs`,
    `    p95       : ${(s.p95_ns    / 1000).toFixed(2)} μs`,
    `    p99       : ${(s.p99_ns    / 1000).toFixed(2)} μs`,
    `    p99.9     : ${(s.p999_ns   / 1000).toFixed(2)} μs`,
    `    max       : ${(s.max_ns    / 1e6 ).toFixed(3)} ms`,
    `    mean      : ${(s.mean_ns   / 1000).toFixed(2)} μs  (stddev ${(s.stddev_ns / 1000).toFixed(2)} μs)`,
    `    min       : ${(s.min_ns    / 1000).toFixed(2)} μs`,
    `    short-circuits observed during measured window: ${s.short_circuits_during_measured} / ${s.n_measured}`,
  ].join('\n');
}

function main(): void {
  const v4: CompiledConfig = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  const scenarios = ['demo-clean', 'demo-anthropic-2025'];

  console.log(`[benchmark-tick-latency] node=${process.version}`);
  console.log(`[benchmark-tick-latency] compiled_config=${v4.version} compiler_version=${v4.compiler_version}`);
  console.log(`[benchmark-tick-latency] warmup=${WARMUP_TICKS} measured=${MEASURED_TICKS} ticks per scenario`);
  console.log('');

  const results: Stats[] = [];
  for (const name of scenarios) {
    console.log(`[benchmark-tick-latency] running ${name} …`);
    const stats = benchmarkScenario(name, v4);
    results.push(stats);
    console.log(formatStats(stats));
    console.log('');
  }

  const out = {
    measured_at: new Date().toISOString(),
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    compiled_config_version: v4.version,
    compiler_version: v4.compiler_version,
    fusion_topology: 'portfolio',
    surface: {
      family_A: ['page_cusum', 'betting_e_process'],
      family_B: ['structural_signatures'],
      family_C: ['hotelling_t2', 'sequential_mmd', 'mcd_mrcd_lw_covariance'],
      family_D: ['spectral_acf', 'bocpd'],
      family_E: ['weighted_conformal'],
    },
    warmup_ticks: WARMUP_TICKS,
    measured_ticks: MEASURED_TICKS,
    scenarios: results,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`[benchmark-tick-latency] wrote ${path.relative(ROOT, OUT_PATH)}`);
}

main();
