// tools/_per-tick-detector-trace-memo.ts — Q63 SPEC-3 implementation.
//
// Standardized diagnostic memo emission. Extracted verbatim from
// tools/per-tick-detector-trace.ts during a mechanical god-file split
// (no behavior change).

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  DetectorFamily,
  PerTickRecord,
  PerTickTraceSummary,
} from './_per-tick-detector-trace-types.js';

export function emitDiagnosticMemo(
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
