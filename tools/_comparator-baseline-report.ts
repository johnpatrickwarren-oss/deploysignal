// tools/_comparator-baseline-report.ts — WS6.2 Task 7: report/summary
// assembly for the comparator-baseline harness. Pure transform functions
// (no CLI/orchestration here — that's tools/run-comparator-baseline.ts):
// parse the frozen ENDPOINTS.md JSON block (+ its sha256), fold a full
// evaluation run's per-window arm results into the frozen primary/secondary
// endpoint shape, and render the markdown summary table.
//
// Escape/delay rule (per ENDPOINTS.md): an injected window is an "escape"
// for an arm if the arm produces no fire at any tick t in
// [injection_tick, canary_ticks); otherwise the detection delay is
// first_post_injection_fire_tick - injection_tick.
//
// Portfolio-arm subtlety (ArmResult's JSDoc in _comparator-baseline-types.ts,
// reviewer finding I1): portfolio_alpha/portfolio_combined only expose a
// single first-fire tick per window (`firstFireTick`/degenerate `fireTicks`),
// not a full firing history — a pre-injection false fire there would make
// the degenerate fireTicks list wrongly look like "no post-injection fire"
// even when the underlying detector family never got a chance to signal
// after injection (or, symmetrically, would hide a real post-injection
// detection behind an earlier pre-injection tick). `perFamilyFirstFireTick`
// is carried specifically so this module can apply the D1 rule used
// elsewhere in the report-card machinery (`runProfileSweep`): a family's
// fire only counts as a detection if THAT FAMILY's own first-ever fire
// tick is >= injection_tick. Comparator arms (threshold/canary/combined)
// don't have this problem — their `fireTicks` already carries every tick
// a breach/rejection was observed, pre- and post-injection alike — so they
// use the plain fireTicks-based rule directly.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type {
  ArmResult,
  Baseline,
  EndpointsSpec,
  ReportCardGateModule,
  ReportCardIoModule,
  WindowProvenance,
} from './_comparator-baseline-types';
import type { ThresholdParams } from './_comparator-baseline-threshold';
import type { CanaryParams } from './_comparator-baseline-canary';
import type { TuningAudit } from './_comparator-baseline-tune';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gateModule = require('./_build-report-card-gate') as ReportCardGateModule;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ioModule = require('./_build-report-card-io') as ReportCardIoModule;

/** Thin re-export of `_build-report-card-io.js`'s `loadBaseline`, so the
 *  CLI entry (tools/run-comparator-baseline.ts) can reach it without a raw
 *  top-level `require()` of its own. That entry file is executed directly
 *  (`node tools/run-comparator-baseline.ts`) and Node's native TS support
 *  reparses it as ESM (import/export syntax detected) — under which a
 *  bare `require()` call is a ReferenceError. This module, by contrast, is
 *  only ever reached via one of the entry's `.js`-suffixed sibling
 *  imports, which resolves to a tsc-compiled, plain-CommonJS `.js` file —
 *  `require()` works there exactly as it does elsewhere in this harness
 *  (see file-level comments on `gateModule` above). */
export function loadBaselineForCli(dir: string): Baseline {
  return ioModule.loadBaseline(dir);
}

// ── ENDPOINTS.md parsing ──────────────────────────────────────────────

/** Parse the single fenced ```json block out of ENDPOINTS.md, returning
 *  the parsed spec, the raw (unparsed) JSON text, and its sha256 hex
 *  digest. The raw text is hashed verbatim (not re-serialized) so the
 *  hash is sensitive to any whitespace/formatting drift in the frozen
 *  document, not just its parsed semantics. */
export function parseEndpointsFile(filePath: string): { spec: EndpointsSpec; raw: string; sha256: string } {
  const md = fs.readFileSync(filePath, 'utf8');
  const match = md.match(/```json\n([\s\S]*?)```/);
  if (!match) {
    throw new Error(`parseEndpointsFile: ${filePath} does not contain a fenced \`\`\`json block`);
  }
  const raw = match[1];
  const spec = JSON.parse(raw) as EndpointsSpec;
  const sha256 = createHash('sha256').update(raw).digest('hex');
  return { spec, raw, sha256 };
}

/** Resolve the installed deploysignal-engine package version for the
 *  report's `generated_with.engine_version` field. Falls back to
 *  'unknown' rather than throwing — a missing/unreadable node_modules
 *  entry shouldn't abort report generation. */
export function resolveEngineVersion(repoRoot: string): string {
  try {
    const pkgPath = path.join(
      repoRoot, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Report shape ──────────────────────────────────────────────────────

/** The exact per-arm metric-key set this harness emits: the three primary
 *  endpoint concepts (escaped_regressions, false_rollbacks,
 *  detection_delay_ticks — the latter nesting both median and p95, per
 *  Task 7's report-shape spec) plus the one secondary metric that is
 *  meaningfully scoped PER ARM (per-signal firing attribution). The other
 *  declared secondary metrics in ENDPOINTS.md's `secondary_metrics` list
 *  are NOT per-arm fields: `tuned_parameter_values` lives once at the
 *  report's top-level `tuning` key (only the tuned arms have tunable
 *  params to report), `combined_default` is itself an arm id (a row in
 *  `arms`, not a nested field name), and `real_trace_healthy_fp` is an
 *  optional top-level key populated only when the v8/v9 real-trace rows
 *  are run (Open Question 4; deferred by default — see Task 8 notes).
 *  Single source of truth so the endpoint-freeze test asserts against
 *  this constant rather than a hand-duplicated list. */
export const ARM_REPORT_KEYS = [
  'escaped_regressions',
  'false_rollbacks',
  'detection_delay_ticks',
  'per_signal_firing_attribution',
] as const;

export interface ArmEndpointReport {
  escaped_regressions: {
    count: number;
    rate: number;
    per_profile: Record<string, { count: number; total: number; rate: number }>;
  };
  false_rollbacks: { count: number; rate: number };
  detection_delay_ticks: {
    median: number | null;
    p95: number | null;
    per_profile: Record<string, { median: number | null; p95: number | null }>;
    all_delays: number[];
  };
  per_signal_firing_attribution: Record<string, number>;
}

export interface ComparatorBaselineReport {
  endpoints_version: string;
  endpoints_sha256: string;
  generated_at: string;
  generated_with: { baseline_id: string; compiled_config_ref: string; engine_version: string };
  non_registered_run?: true;
  tuning: {
    threshold: { params: ThresholdParams; audit: TuningAudit };
    canary: { params: CanaryParams; audit: TuningAudit };
    combined: { params: { threshold: ThresholdParams; canary: CanaryParams }; audit: TuningAudit };
  };
  arms: Record<string, ArmEndpointReport>;
  windows: WindowProvenance[];
}

// ── Accumulation ───────────────────────────────────────────────────────

interface ProfileAccumulator {
  count: number;
  escapedCount: number;
  delays: number[];
}

interface ArmAccumulator {
  healthyTotal: number;
  falseRollbackCount: number;
  injectedTotal: number;
  escapedCount: number;
  allDelays: number[];
  perProfile: Map<string, ProfileAccumulator>;
  signalAttribution: Map<string, number>;
}

function newArmAccumulator(): ArmAccumulator {
  return {
    healthyTotal: 0,
    falseRollbackCount: 0,
    injectedTotal: 0,
    escapedCount: 0,
    allDelays: [],
    perProfile: new Map(),
    signalAttribution: new Map(),
  };
}

/** The earliest tick in `[injectionTick, canaryTicks)` at which the arm
 *  fired, or `null` if it never did in that window — the shared
 *  escape/delay primitive. `familiesForD1`, when given, switches to the
 *  D1 per-family rule over `r.perFamilyFirstFireTick` (portfolio arms);
 *  otherwise this is a plain filter over `r.fireTicks` (comparator arms —
 *  see file header). */
function firstPostInjectionFireTick(
  r: ArmResult,
  injectionTick: number,
  canaryTicks: number,
  familiesForD1?: string[],
): number | null {
  if (familiesForD1 && r.perFamilyFirstFireTick) {
    const candidates = familiesForD1
      .map((f) => r.perFamilyFirstFireTick![f])
      .filter((t): t is number => t !== null && t !== undefined && t >= injectionTick && t < canaryTicks);
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }
  const candidates = r.fireTicks.filter((t) => t >= injectionTick && t < canaryTicks);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** Which families the D1 post-injection rule should consider for a given
 *  arm, or `undefined` for arms that should use the plain fireTicks rule
 *  instead (see file header). `portfolio_alpha` is the fixed
 *  alpha-spending family set the report-card gate module exports;
 *  `portfolio_combined` uses whatever family keys are actually present on
 *  this window's result (always the full A-E set in practice, but read
 *  dynamically rather than hardcoded so this stays correct if the gate
 *  module's family roster ever changes). */
function familiesForD1(armId: string, r: ArmResult): string[] | undefined {
  if (armId === 'portfolio_alpha') return gateModule.ALPHA_SPENDING_FAMILIES;
  if (armId === 'portfolio_combined' && r.perFamilyFirstFireTick) return Object.keys(r.perFamilyFirstFireTick);
  return undefined;
}

function recordWindow(
  acc: ArmAccumulator,
  armId: string,
  provenance: WindowProvenance,
  r: ArmResult,
  injectionTick: number,
  canaryTicks: number,
): void {
  for (const s of r.firingSignals) acc.signalAttribution.set(s, (acc.signalAttribution.get(s) ?? 0) + 1);

  if (provenance.split === 'eval_healthy') {
    acc.healthyTotal++;
    if (r.firstFireTick !== null) acc.falseRollbackCount++;
    return;
  }
  if (provenance.split !== 'eval_injected') return; // tuning windows never reach the report

  acc.injectedTotal++;
  const profileId = provenance.profile_id ?? 'unknown';
  if (!acc.perProfile.has(profileId)) acc.perProfile.set(profileId, { count: 0, escapedCount: 0, delays: [] });
  const p = acc.perProfile.get(profileId)!;
  p.count++;

  const fireTick = firstPostInjectionFireTick(r, injectionTick, canaryTicks, familiesForD1(armId, r));
  if (fireTick === null) {
    acc.escapedCount++;
    p.escapedCount++;
  } else {
    const delay = fireTick - injectionTick;
    acc.allDelays.push(delay);
    p.delays.push(delay);
  }
}

function median(sortedAsc: number[]): number | null {
  if (sortedAsc.length === 0) return null;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

function p95(sortedAsc: number[]): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(0.95 * sortedAsc.length) - 1);
  return sortedAsc[idx];
}

function finalizeArm(acc: ArmAccumulator): ArmEndpointReport {
  const perProfileEscaped: Record<string, { count: number; total: number; rate: number }> = {};
  const perProfileDelay: Record<string, { median: number | null; p95: number | null }> = {};
  for (const [profileId, p] of acc.perProfile.entries()) {
    perProfileEscaped[profileId] = { count: p.escapedCount, total: p.count, rate: p.count > 0 ? p.escapedCount / p.count : 0 };
    const sorted = [...p.delays].sort((a, b) => a - b);
    perProfileDelay[profileId] = { median: median(sorted), p95: p95(sorted) };
  }
  const sortedAllDelays = [...acc.allDelays].sort((a, b) => a - b);

  return {
    escaped_regressions: {
      count: acc.escapedCount,
      rate: acc.injectedTotal > 0 ? acc.escapedCount / acc.injectedTotal : 0,
      per_profile: perProfileEscaped,
    },
    false_rollbacks: {
      count: acc.falseRollbackCount,
      rate: acc.healthyTotal > 0 ? acc.falseRollbackCount / acc.healthyTotal : 0,
    },
    detection_delay_ticks: {
      median: median(sortedAllDelays),
      p95: p95(sortedAllDelays),
      per_profile: perProfileDelay,
      all_delays: sortedAllDelays,
    },
    per_signal_firing_attribution: Object.fromEntries(acc.signalAttribution.entries()),
  };
}

// ── buildReport ────────────────────────────────────────────────────────

export interface WindowResultEntry {
  provenance: WindowProvenance;
  armResults: Record<string, ArmResult>;
}

export interface BuildReportParams {
  spec: EndpointsSpec;
  endpointsSha256: string;
  generatedWith: { baseline_id: string; compiled_config_ref: string; engine_version: string };
  nonRegisteredRun: boolean;
  tuning: {
    threshold: { params: ThresholdParams; audit: TuningAudit };
    canary: { params: CanaryParams; audit: TuningAudit };
    combined: { params: { threshold: ThresholdParams; canary: CanaryParams }; audit: TuningAudit };
  };
  /** eval_healthy + eval_injected window results only (tuning windows
   *  never score against the frozen endpoints). */
  evalWindowResults: WindowResultEntry[];
  injectionTick: number;
  canaryTicks: number;
  /** Full plan provenance (tuning + eval) for the report's `windows`
   *  field — kept complete so the no-leakage invariant is independently
   *  auditable from the committed report, not just from a test run. */
  allWindowProvenance: WindowProvenance[];
}

/** Fold a full evaluation run into the frozen report shape. `spec.arms`
 *  determines which arms appear in the output (the registered run always
 *  passes the full frozen set; a `--arms` CLI subset, only reachable with
 *  `--allow-nonregistered-params`, narrows it — see run-comparator-baseline.ts). */
export function buildReport(p: BuildReportParams): ComparatorBaselineReport {
  const accumulators = new Map<string, ArmAccumulator>();
  for (const armId of p.spec.arms) accumulators.set(armId, newArmAccumulator());

  for (const { provenance, armResults } of p.evalWindowResults) {
    for (const armId of p.spec.arms) {
      const r = armResults[armId];
      if (!r) continue; // arm not computed for this window (shouldn't happen for registered arms)
      recordWindow(accumulators.get(armId)!, armId, provenance, r, p.injectionTick, p.canaryTicks);
    }
  }

  const arms: Record<string, ArmEndpointReport> = {};
  for (const armId of p.spec.arms) arms[armId] = finalizeArm(accumulators.get(armId)!);

  const report: ComparatorBaselineReport = {
    endpoints_version: p.spec.endpoints_version,
    endpoints_sha256: p.endpointsSha256,
    generated_at: new Date().toISOString(),
    generated_with: p.generatedWith,
    tuning: p.tuning,
    arms,
    windows: p.allWindowProvenance,
  };
  if (p.nonRegisteredRun) report.non_registered_run = true;
  return report;
}

// ── Markdown summary ────────────────────────────────────────────────────

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtDelay(v: number | null): string {
  return v === null ? '—' : String(v);
}

/** Render the markdown summary: one row per arm × the three primary
 *  endpoints, plus a per-profile escaped_regressions breakdown table. */
export function renderMarkdownSummary(report: ComparatorBaselineReport): string {
  const lines: string[] = [];
  lines.push('# Comparator-Baseline Report');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Endpoints version: \`${report.endpoints_version}\` (sha256 \`${report.endpoints_sha256}\`)`);
  if (report.non_registered_run) {
    lines.push('');
    lines.push('**⚠ non_registered_run: true** — this report was produced with CLI overrides that ' +
      'disagree with the frozen `runs/comparator-baseline/ENDPOINTS.md` parameters (`--allow-nonregistered-params`). ' +
      'Not a registered result.');
  }
  lines.push(`Baseline: \`${report.generated_with.baseline_id}\` · Compiled config: \`${report.generated_with.compiled_config_ref}\` · Engine: \`${report.generated_with.engine_version}\``);
  lines.push('');

  lines.push('## Primary endpoints');
  lines.push('');
  lines.push('| Arm | Escaped regressions | False rollbacks | Delay median (ticks) | Delay p95 (ticks) |');
  lines.push('|---|---|---|---|---|');
  for (const armId of Object.keys(report.arms)) {
    const a = report.arms[armId];
    const esc = a.escaped_regressions;
    const fr = a.false_rollbacks;
    const d = a.detection_delay_ticks;
    lines.push(
      `| \`${armId}\` | ${esc.count} (${pct(esc.rate)}) | ${fr.count} (${pct(fr.rate)}) | ${fmtDelay(d.median)} | ${fmtDelay(d.p95)} |`,
    );
  }
  lines.push('');

  lines.push('## Escaped regressions by profile');
  lines.push('');
  const profileIds = Array.from(
    new Set(Object.values(report.arms).flatMap((a) => Object.keys(a.escaped_regressions.per_profile))),
  ).sort();
  lines.push(`| Arm | ${profileIds.join(' | ')} |`);
  lines.push(`|---|${profileIds.map(() => '---').join('|')}|`);
  for (const armId of Object.keys(report.arms)) {
    const a = report.arms[armId];
    const cells = profileIds.map((pid) => {
      const pp = a.escaped_regressions.per_profile[pid];
      return pp ? `${pp.count}/${pp.total}` : '—';
    });
    lines.push(`| \`${armId}\` | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Tuned parameters');
  lines.push('');
  lines.push(`- threshold_tuned: \`m=${report.tuning.threshold.params.consecutiveTicks}\`, k per signal: \`${JSON.stringify(report.tuning.threshold.params.kPerSignal)}\``);
  lines.push(`- canary_tuned: \`alpha=${report.tuning.canary.params.alpha}\`, \`W=${report.tuning.canary.params.windowTicks}\``);
  lines.push(`- combined_tuned escalation: chosen \`${JSON.stringify(report.tuning.combined.audit.chosen)}\``);
  lines.push('');

  return lines.join('\n') + '\n';
}
