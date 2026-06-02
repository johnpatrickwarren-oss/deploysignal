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
//
// Structure note: this entrypoint was split out of a single god-file
// into cohesive sibling modules (tools/_per-tick-detector-trace-*.ts)
// with no behavior change. Public exports are re-exported below so the
// import surface from 'tools/per-tick-detector-trace' is unchanged.

// Direct imports from engine source. Aligns with tools/calibrate.ts +
// tools/run-shadow-compare.ts pattern (no shared.js bridge); avoids
// CJS/ESM dual-path require/createRequire complexity.
import { evaluate as orchestrate } from '../engine/orchestrator.js';
import { TrendBuffer } from '../engine/core.js';

import type {
  PerTickDetectorTraceOpts,
  PerTickRecord,
  PerTickTraceSummary,
  PerTickDetectorTraceReport,
  DetectorFamily,
  HealthResultLite,
} from './_per-tick-detector-trace-types.js';
import { parseTicks, parseDetectors, loadDemoScenario, loadCompiledConfig } from './_per-tick-detector-trace-parse.js';
import { mapHealthResultToDetectorRecords } from './_per-tick-detector-trace-mapping.js';
import { emitDiagnosticMemo } from './_per-tick-detector-trace-memo.js';

// ── Public re-exports (preserve exact import surface) ────────────

export type {
  DetectorFamily,
  PerTickDetectorTraceOpts,
  PerTickRecord,
  PerTickTraceSummary,
  PerTickDetectorTraceReport,
} from './_per-tick-detector-trace-types.js';
export { parseTicks, parseDetectors } from './_per-tick-detector-trace-parse.js';

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
