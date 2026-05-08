// tools/per-tick-detector-trace.ts — Q63 SPEC-3 implementation.
//
// Per-tick detector trace tool primitive. Systematizes per-tick
// detector trace methodology that was applied 6+ times ad-hoc across
// Q-cycles (Phase-2.4-v2 + Q57 Step-1 + Q57 Path-3 + Q58 Step-4 +
// Q59 5-variant + Q60 multi-layer). Wraps existing orchestrate(...)
// engine dispatch via the existing return value's per-detector
// state surfaces (HealthResult.family_X_verdict / family_X_shadow);
// emits standardized diagnostic memo at coordination/DIAGNOSTIC-PER-
// TICK-TRACE-{DATE}.md.
//
// Q63 LS-1 verification outcome: existing DetectorVerdict surfaces
// (statistic + threshold + verdict + reason_code + family + signal)
// are sufficient for the per-(tick × detector) record schema. No
// orchestrator amendment needed; intermediate_state field stays
// optional/empty in SLICE 1 (Q60 Phase-3.d.1 multi-layer detail can
// be added at future Phase-3.c.2 / Phase-3.d cycles via additive
// orchestrator amendment if needed). Acceptance criterion #6
// byte-identical default-mode preserved trivially.
//
// Anti-scope (per Q63 spec):
//   - NO engine/detectors/* runtime code modifications.
//   - NO orchestrator default-mode behavior change.
//   - NO new compile-output schema fields.
//   - NO retroactive reformat of existing diagnostic memos.

import * as fs from 'node:fs';
import * as path from 'node:path';

// Direct imports from engine source. Aligns with tools/calibrate.ts +
// tools/run-shadow-compare.ts pattern (no shared.js bridge); avoids
// CJS/ESM dual-path require/createRequire complexity.
import { evaluate as orchestrate } from '../engine/orchestrator.js';
import { TrendBuffer } from '../engine/core.js';

// ── Public types ─────────────────────────────────────────────────

export type DetectorFamily =
  | 'family_A_betting' | 'family_A_page_cusum'
  | 'family_C_safe_test' | 'family_C_chi_square'
  | 'family_D_spectral' | 'family_D_kv_cache'
  | 'family_E_conformal'
  | 'mmd_betting' | 'mmd_bootstrap_null'
  | 'family_B_pattern_match';

export interface PerTickDetectorTraceOpts {
  /** Compiled config substrate path. */
  substrate: string;
  /** Demo scenario name (looks up demos/scripts/<name>.json) OR
   *  absolute path to demo JSON. */
  scenario: string;
  /** Tick range to trace. Format: 'all' | 'N:M' (inclusive) | 'N,M,P,…'. */
  ticks: string;
  /** Detector subset to trace. 'all' | comma-separated DetectorFamily. */
  detectors: string;
  /** Diagnostic memo emission path. */
  outputPath: string;
  /** Optional override (skips file read; used by tests). */
  compiledConfigOverride?: unknown;
  /** Optional override (skips demo JSON read; used by tests). */
  scenarioOverride?: DemoScenario;
}

export interface PerTickRecord {
  tick: number;
  timestamp_offset_ms?: number;
  detector: DetectorFamily;
  detector_variant?: string;
  cell_lookup: {
    requested_key: { hour_of_day?: number; day_of_week?: number; tenant_tier?: string };
    resolved_key: { hour_of_day?: number; day_of_week?: number; tenant_tier?: string } | null;
    resolution_path: 'per_cell' | 'aggregate_fallback' | 'sliding_buffer' | 'no_match';
  };
  compile_source: {
    object_path: string;
    object_subset?: unknown;
  };
  per_detector_input: {
    live_metrics: Record<string, number>;
    trend_buffer_state?: unknown;
  };
  per_detector_computation: {
    statistic_value: number | null;
    threshold: number | null;
    intermediate_state?: Record<string, unknown>;
  };
  firing_decision: 'fire' | 'clean' | 'suppressed' | 'no_data' | 'indeterminate';
  firing_id?: string;
  signal?: string;
}

export interface PerTickTraceSummary {
  total_ticks_traced: number;
  total_detectors_traced: number;
  total_firings: number;
  per_detector_firing_counts: Record<string, number>;
}

export interface PerTickDetectorTraceReport {
  per_tick_records: PerTickRecord[];
  summary: PerTickTraceSummary;
  first_divergence_tick: number | null;
  first_divergence_detector: DetectorFamily | null;
  diagnostic_memo_path: string;
}

interface DemoScenario {
  id?: string;
  name?: string;
  baseline_ref?: string;
  baseline?: Record<string, number>;
  total_ticks: number;
  currentHourOfDay?: number;
  currentDayOfWeek?: number;
  bakeHours?: number;
  cadence_ms?: number;
  ticks: Array<{ metrics: Record<string, number>; pause_beat?: boolean }>;
}

// ── Detector enumeration ─────────────────────────────────────────

const ALL_DETECTORS: readonly DetectorFamily[] = [
  'family_A_betting', 'family_A_page_cusum',
  'family_C_safe_test', 'family_C_chi_square',
  'family_D_spectral', 'family_D_kv_cache',
  'family_E_conformal',
  'mmd_betting', 'mmd_bootstrap_null',
  'family_B_pattern_match',
];

// ── Helpers ──────────────────────────────────────────────────────

export function parseTicks(spec: string, totalTicks: number): number[] {
  if (spec === 'all') {
    return Array.from({ length: totalTicks }, (_, i) => i);
  }
  if (spec.includes(':')) {
    const [a, b] = spec.split(':').map((x) => parseInt(x, 10));
    if (Number.isNaN(a) || Number.isNaN(b) || a < 0 || b < a) {
      throw new Error(`--ticks 'N:M' invalid range: ${spec}`);
    }
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  if (spec.includes(',')) {
    return spec.split(',').map((x) => parseInt(x.trim(), 10)).filter((x) => !Number.isNaN(x));
  }
  const n = parseInt(spec, 10);
  if (Number.isNaN(n)) throw new Error(`--ticks invalid: ${spec}`);
  return [n];
}

export function parseDetectors(spec: string): DetectorFamily[] {
  if (spec === 'all') return [...ALL_DETECTORS];
  const parts = spec.split(',').map((x) => x.trim()) as DetectorFamily[];
  for (const p of parts) {
    if (!ALL_DETECTORS.includes(p)) {
      throw new Error(`--detectors unknown family: ${p}. Valid: ${ALL_DETECTORS.join(', ')}`);
    }
  }
  return parts;
}

function resolveScenarioPath(scenario: string): string {
  if (scenario.endsWith('.json') && fs.existsSync(scenario)) return scenario;
  const demoPath = path.join('demos', 'scripts', `${scenario}.json`);
  if (fs.existsSync(demoPath)) return demoPath;
  throw new Error(`Scenario not found: ${scenario}. Looked at ${demoPath} and direct path.`);
}

function loadDemoScenario(scenarioArg: string): DemoScenario {
  const p = resolveScenarioPath(scenarioArg);
  const demo = JSON.parse(fs.readFileSync(p, 'utf8')) as DemoScenario;
  // Resolve baseline_ref relative to demos/ if present + baseline absent.
  if (!demo.baseline && demo.baseline_ref) {
    const refPath = path.join('demos', demo.baseline_ref);
    if (fs.existsSync(refPath)) {
      const refDoc = JSON.parse(fs.readFileSync(refPath, 'utf8')) as { baseline?: Record<string, number> };
      demo.baseline = refDoc.baseline ?? {};
    }
  }
  return demo;
}

function loadCompiledConfig(substratePath: string): unknown {
  return JSON.parse(fs.readFileSync(substratePath, 'utf8'));
}

// ── Detector mapping from HealthResult ───────────────────────────

interface DetectorVerdictLite {
  verdict: 'fire' | 'indeterminate' | 'clean' | 'suppressed';
  statistic: number | null;
  threshold: number | null;
  signal?: string;
  reason_code?: string;
  family: 'A' | 'B' | 'C' | 'D' | 'E';
}

interface HealthResultLite {
  rollback?: Array<{ id?: string }>;
  suppressed?: string[];
  family_A_shadow?: DetectorVerdictLite[];
  family_C_verdict?: DetectorVerdictLite;
  family_C_mmd_verdict?: DetectorVerdictLite;
  family_D_shadow?: DetectorVerdictLite[];
  family_E_verdict?: DetectorVerdictLite;
}

function mapHealthResultToDetectorRecords(
  hr: HealthResultLite | null | undefined,
  ctx: {
    tick: number;
    timestampOffsetMs: number;
    cellKey: PerTickRecord['cell_lookup']['requested_key'];
    liveMetrics: Record<string, number>;
    selectedDetectors: ReadonlyArray<DetectorFamily>;
  },
): PerTickRecord[] {
  if (!hr) return [];
  const out: PerTickRecord[] = [];
  const wanted = new Set(ctx.selectedDetectors);

  const baseRecord = (
    detector: DetectorFamily,
    objectPath: string,
    verdict: DetectorVerdictLite | null,
    extras: { detector_variant?: string; signal?: string; firing_id?: string } = {},
  ): PerTickRecord => ({
    tick: ctx.tick,
    timestamp_offset_ms: ctx.timestampOffsetMs,
    detector,
    detector_variant: extras.detector_variant,
    cell_lookup: {
      requested_key: ctx.cellKey,
      resolved_key: ctx.cellKey, // existing orchestrator return doesn't disambiguate per_cell vs aggregate; populated as best-effort
      resolution_path: verdict ? 'per_cell' : 'no_match',
    },
    compile_source: { object_path: objectPath },
    per_detector_input: { live_metrics: ctx.liveMetrics },
    per_detector_computation: {
      statistic_value: verdict?.statistic ?? null,
      threshold: verdict?.threshold ?? null,
    },
    firing_decision: verdict
      ? (verdict.verdict === 'fire' ? 'fire'
        : verdict.verdict === 'suppressed' ? 'suppressed'
        : verdict.verdict === 'indeterminate' ? 'indeterminate' : 'clean')
      : 'no_data',
    firing_id: extras.firing_id,
    signal: extras.signal ?? verdict?.signal,
  });

  // family_A_page_cusum — surfaces per-signal in family_A_shadow[].
  if (wanted.has('family_A_page_cusum')) {
    const shadows = hr.family_A_shadow ?? [];
    if (shadows.length === 0) {
      out.push(baseRecord('family_A_page_cusum',
        'baseline_cells.cells[].family_A.per_signal[].{baseline_mean,baseline_sigma_squared,tau_squared,delta_min}',
        null));
    } else {
      for (const v of shadows) {
        out.push(baseRecord('family_A_page_cusum',
          `baseline_cells.cells[].family_A.per_signal[${v.signal ?? '?'}].page_cusum`,
          v, { signal: v.signal, firing_id: v.verdict === 'fire' ? `family_A_page_cusum_${v.signal ?? 'unknown'}` : undefined }));
      }
    }
  }

  // family_A_betting — Q58 Step-4 split alongside page_cusum on Family A signals.
  // Existing DetectorVerdict path doesn't disambiguate; surface the same shadows tagged as betting variant.
  if (wanted.has('family_A_betting')) {
    const shadows = hr.family_A_shadow ?? [];
    if (shadows.length === 0) {
      out.push(baseRecord('family_A_betting',
        'baseline_cells.cells[].family_A.per_signal[].betting_sliding_buffer_threshold',
        null));
    } else {
      for (const v of shadows) {
        out.push(baseRecord('family_A_betting',
          `baseline_cells.cells[].family_A.per_signal[${v.signal ?? '?'}].betting_e_process`,
          v, { signal: v.signal, detector_variant: 'betting', firing_id: v.verdict === 'fire' ? `family_A_betting_${v.signal ?? 'unknown'}` : undefined }));
      }
    }
  }

  // family_C_safe_test — Hotelling T².
  if (wanted.has('family_C_safe_test')) {
    out.push(baseRecord('family_C_safe_test',
      'baseline_cells.cells[].family_C.{mean_vector,covariance,cholesky_L}',
      hr.family_C_verdict ?? null,
      { detector_variant: 'hotelling_t2', firing_id: hr.family_C_verdict?.verdict === 'fire' ? 'family_C' : undefined }));
  }

  // family_C_chi_square — variant of Hotelling χ² threshold (same source object).
  if (wanted.has('family_C_chi_square')) {
    out.push(baseRecord('family_C_chi_square',
      'baseline_cells.cells[].family_C.chi_square_threshold',
      hr.family_C_verdict ?? null,
      { detector_variant: 'chi_square', firing_id: hr.family_C_verdict?.verdict === 'fire' ? 'family_C_chi_square' : undefined }));
  }

  // mmd_betting + mmd_bootstrap_null — both surface via family_C_mmd_verdict.
  if (wanted.has('mmd_betting')) {
    out.push(baseRecord('mmd_betting',
      'baseline_cells.cells[].family_C.mmd_params.e_mmd_params',
      hr.family_C_mmd_verdict ?? null,
      { detector_variant: 'betting', firing_id: hr.family_C_mmd_verdict?.verdict === 'fire' ? 'family_C_mmd' : undefined }));
  }
  if (wanted.has('mmd_bootstrap_null')) {
    out.push(baseRecord('mmd_bootstrap_null',
      'baseline_cells.cells[].family_C.mmd_params.{null_quantile,bandwidth}',
      hr.family_C_mmd_verdict ?? null,
      { detector_variant: 'bootstrap_null', firing_id: hr.family_C_mmd_verdict?.verdict === 'fire' ? 'family_C_mmd_bootstrap' : undefined }));
  }

  // family_D_spectral + family_D_kv_cache — split family_D_shadow by signal.
  const fD = hr.family_D_shadow ?? [];
  if (wanted.has('family_D_kv_cache')) {
    const v = fD.find((x) => x.signal === 'kv_cache');
    out.push(baseRecord('family_D_kv_cache',
      'baseline_cells.cells[].family_D[kv_cache].{ar1_phi,peak_acf_threshold}',
      v ?? null,
      { signal: 'kv_cache', firing_id: v?.verdict === 'fire' ? 'family_D_kv_cache' : undefined }));
  }
  if (wanted.has('family_D_spectral')) {
    const nonKv = fD.filter((x) => x.signal !== 'kv_cache');
    if (nonKv.length === 0) {
      out.push(baseRecord('family_D_spectral',
        'baseline_cells.cells[].family_D[non-kv-cache signals].{ar1_phi,peak_acf_threshold}',
        null));
    } else {
      for (const v of nonKv) {
        out.push(baseRecord('family_D_spectral',
          `baseline_cells.cells[].family_D[${v.signal ?? '?'}].{ar1_phi,peak_acf_threshold}`,
          v, { signal: v.signal, firing_id: v.verdict === 'fire' ? `family_D_${v.signal ?? 'unknown'}` : undefined }));
      }
    }
  }

  // family_E_conformal.
  if (wanted.has('family_E_conformal')) {
    out.push(baseRecord('family_E_conformal',
      'baseline_cells.cells[].family_E.{conformal_calibration,mahalanobis_quantile}',
      hr.family_E_verdict ?? null,
      { firing_id: hr.family_E_verdict?.verdict === 'fire' ? 'family_E' : undefined }));
  }

  // family_B_pattern_match — surfaced via rollback[] entries with id starting family_b_.
  if (wanted.has('family_B_pattern_match')) {
    const familyBFires = (hr.rollback ?? []).filter((r) => r.id?.startsWith('family_b_'));
    if (familyBFires.length === 0) {
      out.push(baseRecord('family_B_pattern_match',
        'family_B.{cutoffs,vote_thresholds}',
        null));
    } else {
      for (const r of familyBFires) {
        out.push({
          ...baseRecord('family_B_pattern_match',
            `family_B.cutoffs.${r.id}`,
            { verdict: 'fire', statistic: null, threshold: null, family: 'B' } as DetectorVerdictLite,
            { firing_id: r.id }),
        });
      }
    }
  }

  return out;
}

// ── Memo emission ────────────────────────────────────────────────

function emitDiagnosticMemo(
  outPath: string,
  records: PerTickRecord[],
  summary: PerTickTraceSummary,
  meta: {
    substrate: string;
    scenario: string;
    ticks: string;
    detectors: string;
    firstDivergenceTick: number | null;
    firstDivergenceDetector: DetectorFamily | null;
  },
): void {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);
  lines.push(`# DIAGNOSTIC-PER-TICK-TRACE-${date}`, '');
  lines.push(`_Tool: tools/per-tick-detector-trace.ts. Substrate: ${meta.substrate}. Scenario: ${meta.scenario}. Tick range: ${meta.ticks}. Detectors: ${meta.detectors}._`, '');
  lines.push('## Summary', '');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Total ticks traced | ${summary.total_ticks_traced} |`);
  lines.push(`| Total detectors traced | ${summary.total_detectors_traced} |`);
  lines.push(`| First divergence tick | ${meta.firstDivergenceTick ?? 'none'} |`);
  lines.push(`| First divergence detector | ${meta.firstDivergenceDetector ?? 'none'} |`);
  lines.push(`| Total firings | ${summary.total_firings} |`);
  lines.push('');
  lines.push('### Per-detector firing counts', '');
  for (const [d, c] of Object.entries(summary.per_detector_firing_counts)) {
    lines.push(`- ${d}: ${c}`);
  }
  lines.push('');
  if (meta.firstDivergenceTick !== null) {
    lines.push('## First divergence localization', '');
    const fdRecs = records.filter((r) => r.tick === meta.firstDivergenceTick && r.firing_decision === 'fire');
    for (const r of fdRecs) {
      lines.push(`- **Tick ${r.tick} / ${r.detector}${r.signal ? ` (${r.signal})` : ''}**: statistic=${r.per_detector_computation.statistic_value} threshold=${r.per_detector_computation.threshold} firing_id=${r.firing_id ?? 'n/a'}`);
      lines.push(`  - compile_source: \`${r.compile_source.object_path}\``);
      lines.push(`  - cell_lookup: requested=${JSON.stringify(r.cell_lookup.requested_key)} resolution=\`${r.cell_lookup.resolution_path}\``);
    }
    lines.push('');
  }
  lines.push('## Per-tick × per-detector records', '');
  const ticks = Array.from(new Set(records.map((r) => r.tick))).sort((a, b) => a - b);
  for (const t of ticks) {
    lines.push(`### Tick ${t}`, '');
    const tickRecs = records.filter((r) => r.tick === t);
    for (const r of tickRecs) {
      const stat = r.per_detector_computation.statistic_value;
      const thr = r.per_detector_computation.threshold;
      lines.push(`- **${r.detector}${r.detector_variant ? ` (${r.detector_variant})` : ''}${r.signal ? ` / ${r.signal}` : ''}**: ${r.firing_decision}; statistic=${stat ?? 'null'} threshold=${thr ?? 'null'}; cell=${r.cell_lookup.resolution_path}; src=\`${r.compile_source.object_path}\``);
    }
    lines.push('');
  }
  fs.writeFileSync(outPath, lines.join('\n'));
}

// ── Main entrypoint ──────────────────────────────────────────────

export function runPerTickDetectorTrace(
  opts: PerTickDetectorTraceOpts,
): PerTickDetectorTraceReport {
  const compiledConfig = (opts.compiledConfigOverride ?? loadCompiledConfig(opts.substrate)) as { [k: string]: unknown };
  const scenario = opts.scenarioOverride ?? loadDemoScenario(opts.scenario);
  const totalTicks = scenario.total_ticks ?? scenario.ticks.length;
  const ticks = parseTicks(opts.ticks, totalTicks);
  const detectors = parseDetectors(opts.detectors);

  const tb = new (TrendBuffer as new (n: number) => unknown)(10) as { push: (s: string, v: number) => void };
  const records: PerTickRecord[] = [];
  let firstDivergenceTick: number | null = null;
  let firstDivergenceDetector: DetectorFamily | null = null;
  const perDetectorFiringCounts: Record<string, number> = {};
  for (const d of detectors) perDetectorFiringCounts[d] = 0;

  const cadenceMs = scenario.cadence_ms ?? 5000;
  const totalCanaryTicks = scenario.total_ticks ?? scenario.ticks.length;
  const bakeHours = scenario.bakeHours ?? 0.5;

  const cellKey = {
    hour_of_day: scenario.currentHourOfDay,
    day_of_week: scenario.currentDayOfWeek,
  };

  for (const t of ticks) {
    const liveMetrics = scenario.ticks[t]?.metrics ?? {};
    for (const [s, v] of Object.entries(liveMetrics)) tb.push(s, v);
    const hoursElapsed = t * (bakeHours / Math.max(1, totalCanaryTicks));
    const result = orchestrate({
      liveMetrics,
      scenario: { id: scenario.id ?? opts.scenario, baseline: scenario.baseline ?? {} },
      hoursElapsed,
      trendBuffer: tb,
      tick: t,
      totalTicks: totalCanaryTicks,
      compiledConfig,
      currentHourOfDay: scenario.currentHourOfDay,
      currentDayOfWeek: scenario.currentDayOfWeek,
      fusionTopology: 'portfolio',
            // Q63 wrapper-layer dispatch — types deliberately loose because
            // tool consumes minimal subset of orchestrate inputs / outputs.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as { healthResult?: HealthResultLite | null };

    const tickRecords = mapHealthResultToDetectorRecords(result.healthResult, {
      tick: t,
      timestampOffsetMs: t * cadenceMs,
      cellKey,
      liveMetrics,
      selectedDetectors: detectors,
    });
    for (const r of tickRecords) {
      records.push(r);
      if (r.firing_decision === 'fire') {
        perDetectorFiringCounts[r.detector] = (perDetectorFiringCounts[r.detector] ?? 0) + 1;
        if (firstDivergenceTick === null) {
          firstDivergenceTick = t;
          firstDivergenceDetector = r.detector;
        }
      }
    }
  }

  const summary: PerTickTraceSummary = {
    total_ticks_traced: ticks.length,
    total_detectors_traced: detectors.length,
    total_firings: Object.values(perDetectorFiringCounts).reduce((a, b) => a + b, 0),
    per_detector_firing_counts: perDetectorFiringCounts,
  };

  emitDiagnosticMemo(opts.outputPath, records, summary, {
    substrate: opts.substrate,
    scenario: opts.scenario,
    ticks: opts.ticks,
    detectors: opts.detectors,
    firstDivergenceTick,
    firstDivergenceDetector,
  });

  return {
    per_tick_records: records,
    summary,
    first_divergence_tick: firstDivergenceTick,
    first_divergence_detector: firstDivergenceDetector,
    diagnostic_memo_path: opts.outputPath,
  };
}

// ── CLI ──────────────────────────────────────────────────────────

export function parseCliArgs(argv: string[]): PerTickDetectorTraceOpts {
  const out: Partial<PerTickDetectorTraceOpts> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--substrate': out.substrate = v; i++; break;
      case '--scenario':  out.scenario = v;  i++; break;
      case '--ticks':     out.ticks = v;     i++; break;
      case '--detectors': out.detectors = v; i++; break;
      case '--out':       out.outputPath = v; i++; break;
    }
  }
  if (!out.substrate || !out.scenario || !out.ticks || !out.detectors || !out.outputPath) {
    throw new Error(
      'Required CLI flags: --substrate <path> --scenario <name> --ticks <range> '
      + '--detectors <list> --out <path>');
  }
  return out as PerTickDetectorTraceOpts;
}

if (process.argv.some((a) => a === '--substrate')) {
  const opts = parseCliArgs(process.argv.slice(2));
  const r = runPerTickDetectorTrace(opts);
  console.log(`[per-tick-detector-trace] memo emitted: ${r.diagnostic_memo_path}`);
  if (r.first_divergence_tick !== null) {
    console.log(`[per-tick-detector-trace] first divergence: tick ${r.first_divergence_tick} detector ${r.first_divergence_detector}`);
  } else {
    console.log('[per-tick-detector-trace] no divergence across traced ticks');
  }
}
