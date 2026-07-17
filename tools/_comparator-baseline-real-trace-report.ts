// tools/_comparator-baseline-real-trace-report.ts — report/summary
// assembly for the v8/v9 real-trace healthy-FP-only secondary study
// (ENDPOINTS.md Open Question 4's deferred follow-up). Deliberately a
// SEPARATE report shape from `_comparator-baseline-report.ts`'s
// `ComparatorBaselineReport` / `ARM_REPORT_KEYS` — this study has no
// injected split, so it has no `escaped_regressions` or
// `detection_delay_ticks` to report, and forcing those primary-endpoint
// keys onto a report with no injected windows to compute them from would
// either fabricate na/null values or silently violate the primary
// report's own endpoint-freeze invariant (which asserts the emitted
// per-arm key set is EXACTLY `ARM_REPORT_KEYS` — see
// test/comparator-baseline-endpoints.test.ts). Keeping this a distinct
// shape, written to a distinct file
// (`runs/comparator-baseline/report-real-traces.json`), makes that
// separation structural rather than a convention someone could violate by
// accident.

import { createHash } from 'node:crypto';
import type { RealTraceSubstrateResult } from './_comparator-baseline-real-trace';

export const REAL_TRACE_ARM_KEYS = ['false_rollbacks'] as const;

export interface TunedParamsProvenance {
  source_report: string;
  sha256: string;
}

export interface RealTraceReport {
  endpoints_version: string;
  endpoints_sha256: string;
  secondary: true;
  metric_scope: 'real_trace_healthy_fp';
  generated_at: string;
  generated_with: { engine_version: string };
  non_registered_run?: true;
  methodology_note: string;
  tuned_params_provenance: TunedParamsProvenance;
  window_generation: { resampler: string; healthy_windows: number; seed: number };
  substrates: RealTraceSubstrateResult[];
  skipped_substrates: Array<{ id: string; reason: string }>;
}

export const METHODOLOGY_NOTE =
  'Secondary rows only (ENDPOINTS.md Open Question 4\'s deferred v8/v9 real-trace ' +
  'healthy-FP-only follow-up). threshold_tuned/canary_tuned parameters are REUSED ' +
  'verbatim from the pre-registered primary run (tuned_params_provenance below), ' +
  'restricted per substrate to the signals that substrate\'s own compiled config/' +
  'manifest can resolve (never re-tuned against real-trace data). No injected ' +
  'regression profiles are run against these substrates — false_rollbacks is the ' +
  'only metric reported; escaped_regressions and detection_delay_ticks (the primary ' +
  'endpoints) do not apply here and are intentionally absent, not na/null.';

export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface BuildRealTraceReportParams {
  endpointsVersion: string;
  endpointsSha256: string;
  engineVersion: string;
  tunedParamsProvenance: TunedParamsProvenance;
  healthyWindows: number;
  seed: number;
  resampler: string;
  substrates: RealTraceSubstrateResult[];
  skippedSubstrates: Array<{ id: string; reason: string }>;
}

export function buildRealTraceReport(p: BuildRealTraceReportParams): RealTraceReport {
  return {
    endpoints_version: p.endpointsVersion,
    endpoints_sha256: p.endpointsSha256,
    secondary: true,
    metric_scope: 'real_trace_healthy_fp',
    generated_at: new Date().toISOString(),
    generated_with: { engine_version: p.engineVersion },
    methodology_note: METHODOLOGY_NOTE,
    tuned_params_provenance: p.tunedParamsProvenance,
    window_generation: { resampler: p.resampler, healthy_windows: p.healthyWindows, seed: p.seed },
    substrates: p.substrates,
    skipped_substrates: p.skippedSubstrates,
  };
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Render the markdown summary: one table per substrate (arm x
 *  false-rollback count/rate), plus a skipped-substrates section when any
 *  substrate failed the OQ-4 feasibility gate. */
export function renderRealTraceMarkdownSummary(report: RealTraceReport): string {
  const lines: string[] = [];
  lines.push('# Comparator-Baseline Real-Trace Report (SECONDARY)');
  lines.push('');
  lines.push('**SECONDARY per ENDPOINTS.md — real_trace_healthy_fp.** ' + report.methodology_note);
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Endpoints version: \`${report.endpoints_version}\` (sha256 \`${report.endpoints_sha256}\`)`);
  if (report.non_registered_run) {
    lines.push('');
    lines.push('**⚠ non_registered_run: true** — this report was produced with CLI overrides that ' +
      'disagree with the frozen `runs/comparator-baseline/ENDPOINTS.md` parameters. Not a registered result.');
  }
  lines.push(`Engine: \`${report.generated_with.engine_version}\``);
  lines.push(
    `Tuned params reused from: \`${report.tuned_params_provenance.source_report}\` ` +
      `(sha256 \`${report.tuned_params_provenance.sha256}\`)`,
  );
  lines.push(
    `Window generation: \`${report.window_generation.resampler}\`, ` +
      `${report.window_generation.healthy_windows} windows, seed ${report.window_generation.seed}`,
  );
  lines.push('');

  if (report.substrates.length === 0) {
    lines.push('**All substrates were skipped by the OQ-4 feasibility gate — see below.**');
    lines.push('');
  }

  for (const substrate of report.substrates) {
    lines.push(`## ${substrate.id}`);
    lines.push('');
    lines.push(`Populated cells: ${substrate.populated_cells} · Eval-healthy windows: ${substrate.window_count}`);
    lines.push('');
    lines.push('| Arm | False rollbacks | Notes |');
    lines.push('|---|---|---|');
    for (const armId of Object.keys(substrate.arms)) {
      const a = substrate.arms[armId];
      const fr = a.false_rollbacks;
      const notes: string[] = [];
      if (a.skipped) notes.push(`SKIPPED: ${a.skip_reason ?? ''}`);
      if (a.dropped_signals && a.dropped_signals.length > 0) notes.push(`dropped signals: ${a.dropped_signals.join(', ')}`);
      if (a.usable_signals) notes.push(`usable signals: ${a.usable_signals.length}`);
      lines.push(`| \`${armId}\` | ${fr.count}/${fr.total} (${pct(fr.rate)}) | ${notes.join('; ') || '—'} |`);
    }
    lines.push('');
  }

  if (report.skipped_substrates.length > 0) {
    lines.push('## Skipped substrates (OQ-4 feasibility gate)');
    lines.push('');
    lines.push('| Substrate | Reason |');
    lines.push('|---|---|');
    for (const s of report.skipped_substrates) {
      lines.push(`| \`${s.id}\` | ${s.reason} |`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}
