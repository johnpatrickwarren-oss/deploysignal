// tools/_run-shadow-compare-cli.ts — CLI entrypoint for the Q60 Slice 1
// shadow-compare orchestrator: arg parsing, substrate registry, the
// --emit single-summary builder, and main(). Extracted from
// tools/run-shadow-compare.ts during a behavior-preserving module split;
// main()'s body is decomposed into <100-line helpers with identical
// behavior.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Q60DetectorFamily } from '../engine/types/config.js';
import {
  DEFAULT_HEALTHY_WINDOWS,
  type ShadowCompareReport,
  type SubstrateRef,
  type SweepMode,
} from './_run-shadow-compare-types';
import { isSweepModeCalibrationRegimeMatched } from './_run-shadow-compare-exemptions';
import { runShadowCompare } from './_run-shadow-compare-orchestrator';

interface CliArgs {
  substrates: string;        // comma-list e.g., 'v5,v8a,v8b,v8c'
  scenarios: string;         // comma-list e.g., 'all-5'
  seeds: string;             // comma-list of seed integers
  outputDir: string;
  dryRun: boolean;
  healthyWindows: number;
  /** Q66 item (h) follow-up — comma-list of methodology-resampler modes
   *  to declare for this sweep run. Validation-only / audit-visible
   *  metadata: modes are always composed internally per substrate inside
   *  build-report-card.js (3 internal passes per trial; parametric_ar1
   *  PASS auto-skipped on substrates that can't form the 11-signal joint
   *  cholesky_L vector per Q60 Phase-3.d.1 L3b β.1 logic). The flag is
   *  REQUIRED-but-validated-against-known-modes so routing pasteables
   *  carry mode-intent provenance forward; absence falls through to
   *  the default trio. Allowed values: iid_bootstrap | parametric_gaussian
   *  | parametric_ar1. */
  modes?: string;
  /** Q66 item (h) follow-up — single-summary JSON file path. When set,
   *  emits a consolidated summary (modes declared + per-substrate
   *  detector FPR means + acceptance gates) at this path AT END of
   *  sweep, in addition to the per-profile report cards in
   *  outputDir/. For Mac mini sweep workflows that consume one
   *  artifact via jq. */
  emit?: string;
}

const KNOWN_MODES = ['iid_bootstrap', 'parametric_gaussian', 'parametric_ar1'] as const;
type Mode = typeof KNOWN_MODES[number];

const SUBSTRATE_REGISTRY: Record<string, SubstrateRef> = {
  v5: {
    name: 'synthetic_v1',
    baselineDir: 'runs/baselines/synthetic-v1',
    compiledConfig: 'runs/compiled-configs/v5-sequential-e-process.json',
  },
  v8a: {
    name: 'real_burstgpt',
    baselineDir: 'runs/baselines/real-burstgpt-v1',
    compiledConfig: 'runs/compiled-configs/v8a-real-burstgpt-v1.json',
  },
  v8b: {
    name: 'real_azure_llm_inference',
    baselineDir: 'runs/baselines/real-azure-llm-inference-v1',
    compiledConfig: 'runs/compiled-configs/v8b-real-azure-llm-inference-v1.json',
  },
  v8c: {
    name: 'real_mooncake',
    baselineDir: 'runs/baselines/real-mooncake-v1',
    compiledConfig: 'runs/compiled-configs/v8c-real-mooncake-v1.json',
  },
  // Q62 Slice 2 H1 (HF-only narrowing per architect H1 disposition).
  // v9b/v9c reserved for Phase-3.d Slice 2.b future cycle.
  v9a: {
    name: 'real_huggingface_lmsys_arena',
    baselineDir: 'runs/baselines/real-huggingface-lmsys-arena-v1',
    compiledConfig: 'runs/compiled-configs/v9a-real-huggingface-lmsys-arena-v1.json',
  },
};

const ALL_5_SCENARIOS = [
  'anthropic_tpu_output_corruption_step_2025_09',
  'anthropic_xla_precision_drift_2025_08',
  'cloudflare_worker_kv_degradation_2024_03',
  'github_availability_latency_regression_2024_06',
  'openai_routing_error_ramp_2024_12_11',
];

function parseCliArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {
    outputDir: 'runs/validation-reports/profile-report-cards/',
    dryRun: false,
    healthyWindows: DEFAULT_HEALTHY_WINDOWS,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--substrates':       out.substrates = v; i++; break;
      case '--scenarios':         out.scenarios = v; i++; break;
      case '--seeds':             out.seeds = v; i++; break;
      case '--output-dir':        out.outputDir = v; i++; break;
      case '--dry-run':           out.dryRun = true; break;
      case '--healthy-windows':   out.healthyWindows = parseInt(v, 10); i++; break;
      case '--modes':             out.modes = v; i++; break;
      case '--emit':              out.emit = v; i++; break;
      default:
        if (k.startsWith('--')) throw new Error(`Unknown flag: ${k}`);
    }
  }
  if (!out.substrates || !out.scenarios || !out.seeds) {
    throw new Error(
      'Required flags: --substrates v5,v8a,v8b,v8c --scenarios all-5 '
      + '--seeds 42,43,44,45,46,47,48,49 [--output-dir <dir>] [--dry-run] '
      + '[--healthy-windows <N>] [--modes iid_bootstrap,parametric_gaussian,parametric_ar1] '
      + '[--emit <single-summary.json>]',
    );
  }
  if (out.modes !== undefined) {
    const declared = out.modes.split(',').map((m) => m.trim());
    for (const m of declared) {
      if (!KNOWN_MODES.includes(m as Mode)) {
        throw new Error(
          `Unknown mode '${m}' in --modes. Allowed: ${KNOWN_MODES.join(',')}.`,
        );
      }
    }
  }
  return out as CliArgs;
}

interface ResolvedSweepInputs {
  substrateNames: string[];
  substrates: SubstrateRef[];
  scenarios: string[];
  seeds: number[];
}

/** Resolve CLI args into concrete substrate refs / scenario list / seed
 *  integers, validating substrate names against the registry. */
function resolveSweepInputs(args: CliArgs): ResolvedSweepInputs {
  const substrateNames = args.substrates.split(',').map((s) => s.trim());
  const substrates: SubstrateRef[] = substrateNames.map((n) => {
    const ref = SUBSTRATE_REGISTRY[n];
    if (!ref) throw new Error(`Unknown substrate: ${n}. Known: ${Object.keys(SUBSTRATE_REGISTRY).join(',')}`);
    return ref;
  });
  const scenarios = args.scenarios === 'all-5'
    ? ALL_5_SCENARIOS
    : args.scenarios.split(',').map((s) => s.trim());
  const seeds = args.seeds.split(',').map((s) => parseInt(s.trim(), 10));
  return { substrateNames, substrates, scenarios, seeds };
}

type PerSubstratePerModeFpr = Record<string, Record<string, Record<string, number>>>;

/** Q66 Phase-3.d.A close item (h) schema 2.3.0 — read per-mode pools
 *  from per-seed report cards (build-report-card.js emits
 *  {iid_bootstrap_pool, parametric_gaussian_pool, parametric_ar1_pool}
 *  per detector). Aggregate FPR per (substrate × detector × mode) by
 *  averaging across scenarios + seeds for that substrate. Returns the
 *  per-mode map plus a backward-compat flat iid_bootstrap collapse. */
function aggregatePerModeFpr(
  inputs: ResolvedSweepInputs,
  outputDir: string,
): { perSubstratePerModeFpr: PerSubstratePerModeFpr; perSubstrateDetectorFpr: Record<string, Record<string, number>> } {
  const perSubstratePerModeFpr: PerSubstratePerModeFpr = {};
  const perSubstrateDetectorFpr: Record<string, Record<string, number>> = {};
  for (const substrateKey of inputs.substrateNames) {
    const ref = SUBSTRATE_REGISTRY[substrateKey];
    if (!ref) continue;
    perSubstratePerModeFpr[ref.name] = {
      iid_bootstrap: {}, parametric_gaussian: {}, parametric_ar1: {},
    };
    const counts: Record<string, Record<string, number>> = {
      iid_bootstrap: {}, parametric_gaussian: {}, parametric_ar1: {},
    };
    for (const scenario of inputs.scenarios) {
      for (const seed of inputs.seeds) {
        const reportPath = path.join(
          outputDir, 'per-seed-reports',
          `${ref.name}--${scenario}--${seed}.json`,
        );
        if (!fs.existsSync(reportPath)) continue;
        let report: { detectors?: Record<string, Record<string, { fpr_per_131?: number }>> };
        try {
          report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        } catch (_e) { continue; }
        const detectors = report.detectors ?? {};
        for (const [det, blocks] of Object.entries(detectors)) {
          for (const mode of KNOWN_MODES) {
            const pool = blocks[`${mode}_pool`];
            if (!pool || pool.fpr_per_131 === undefined) continue;
            const acc = perSubstratePerModeFpr[ref.name][mode];
            const cnt = counts[mode];
            const n = (cnt[det] ?? 0) + 1;
            acc[det] = ((acc[det] ?? 0) * (n - 1) + pool.fpr_per_131) / n;
            cnt[det] = n;
          }
        }
      }
    }
    // Backward-compat: collapse iid_bootstrap mode to flat field.
    perSubstrateDetectorFpr[ref.name] = { ...perSubstratePerModeFpr[ref.name].iid_bootstrap };
  }
  return { perSubstratePerModeFpr, perSubstrateDetectorFpr };
}

/** Q66 spec § item (h) addendum halt criterion (a) — per-mode FPR gate.
 *  Detector exempted from a mode → that mode's gate auto-passes. Q60 L3b
 *  parametric_ar1-sparse-substrate exemption preserved via existing
 *  detector_exemption_reason mechanism at orchestrator layer; here the
 *  Q66 .A.c.γ calibration-regime-match check short-circuits gate
 *  evaluation per architect addendum pseudo-code. */
function computePerModeAcceptanceGates(
  perSubstratePerModeFpr: PerSubstratePerModeFpr,
  substrates: SubstrateRef[],
): { perModeAcceptanceGates: Record<string, boolean>; regimeMismatchExemptions: Record<string, string> } {
  const PER_DETECTOR_ALPHA_BUDGETS: Record<string, number> = {
    family_A_betting: 2e-4, family_A_page_cusum: 1e-4,
    family_B_pattern_match: 0,
    family_C_safe_test: 1e-4, family_C_chi_square: 1e-4,
    family_D_spectral: 5e-5, family_D_kv_cache: 5e-5,
    family_E_conformal: 1e-4,
    mmd_betting: 1e-4, mmd_bootstrap_null: 1e-4,
  };
  const regimeMismatchExemptions: Record<string, string> = {};
  const perModeAcceptanceGates: Record<string, boolean> = {};
  for (const [substrateName, byMode] of Object.entries(perSubstratePerModeFpr)) {
    const ref = substrates.find((s) => s.name === substrateName);
    for (const [mode, byDetector] of Object.entries(byMode)) {
      for (const [det, fpr] of Object.entries(byDetector)) {
        const budget = PER_DETECTOR_ALPHA_BUDGETS[det] ?? 0;
        if (budget === 0) continue;
        const gateKey = `per_mode_fpr_${det}_${mode}_${substrateName}`;
        let regimeExempt = false;
        if (ref) {
          const decision = isSweepModeCalibrationRegimeMatched(
            ref, mode as SweepMode, det as Q60DetectorFamily,
          );
          if (!decision.matched && decision.reason) {
            regimeMismatchExemptions[gateKey] = decision.reason;
            regimeExempt = true;
          }
        }
        // Exempted triples auto-pass the gate (architect § (b.2)
        // sweep dispatch behavior: emit detector_exemption_reason;
        // DO NOT count toward halt-boundary (a)).
        perModeAcceptanceGates[gateKey] = regimeExempt || fpr <= budget * 1.2;
      }
    }
  }
  return { perModeAcceptanceGates, regimeMismatchExemptions };
}

/** Build + write the Q66 item (h) single-summary JSON artifact. */
function emitSingleSummary(
  args: CliArgs,
  inputs: ResolvedSweepInputs,
  result: ShadowCompareReport,
): void {
  const declaredModes = args.modes !== undefined
    ? args.modes.split(',').map((m) => m.trim())
    : KNOWN_MODES.slice();
  const { perSubstratePerModeFpr, perSubstrateDetectorFpr } = aggregatePerModeFpr(
    inputs, args.outputDir,
  );
  const { perModeAcceptanceGates, regimeMismatchExemptions } = computePerModeAcceptanceGates(
    perSubstratePerModeFpr, inputs.substrates,
  );

  const summary = {
    generated_at: new Date().toISOString(),
    sweep_meta: {
      substrates: inputs.substrateNames,
      scenarios: inputs.scenarios,
      seeds: inputs.seeds,
      modes_declared: declaredModes,
      modes_note: 'Per-mode pool fields (iid_bootstrap_pool, parametric_gaussian_pool, parametric_ar1_pool) emitted per Q66 schema 2.3.0. Halt criterion (a) per Q66 spec § item (h) addendum: pool[mode].fpr ≤ α × 1.2 per non-exempt detector × substrate × mode. Q60 L3b parametric_ar1-sparse-substrate exemption preserved via detector_exemption_reason at orchestrator layer. Q66 .A.c.γ extension: detector × substrate × mode triples that fail isSweepModeCalibrationRegimeMatched (calibration-regime-vs-sweep-regime mismatch class) are also exempted; reasons emitted in regime_mismatch_exemptions field.',
      n_trials: inputs.substrates.length * inputs.scenarios.length * inputs.seeds.length,
      output_dir: args.outputDir,
      report_card_schema_version: '2.3.0',
    },
    per_substrate_detector_fpr_iid_bootstrap: perSubstrateDetectorFpr,
    per_substrate_detector_fpr_parametric_gaussian: Object.fromEntries(
      Object.entries(perSubstratePerModeFpr).map(([s, m]) => [s, m.parametric_gaussian]),
    ),
    per_substrate_detector_fpr_parametric_ar1: Object.fromEntries(
      Object.entries(perSubstratePerModeFpr).map(([s, m]) => [s, m.parametric_ar1]),
    ),
    acceptance_gates: { ...result.acceptance_gates, ...perModeAcceptanceGates },
    regime_mismatch_exemptions: regimeMismatchExemptions,
    cross_substrate_diff_path: result.cross_substrate_diff_path,
    pitch_summary_path: result.pitch_summary_path,
  };
  fs.mkdirSync(path.dirname(args.emit!), { recursive: true });
  fs.writeFileSync(args.emit!, JSON.stringify(summary, null, 2) + '\n');
  console.log(`[run-shadow-compare]   single-summary: ${args.emit}`);
}

export function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const inputs = resolveSweepInputs(args);
  const { substrateNames, substrates, scenarios, seeds } = inputs;

  console.log(`[run-shadow-compare] Q60 Slice 1 sweep:`);
  console.log(`[run-shadow-compare]   substrates: ${substrateNames.join(', ')}`);
  console.log(`[run-shadow-compare]   scenarios:  ${scenarios.length}`);
  console.log(`[run-shadow-compare]   seeds:      ${seeds.length}`);
  console.log(`[run-shadow-compare]   total trials: ${substrates.length * scenarios.length * seeds.length}`);
  console.log(`[run-shadow-compare]   dry-run: ${args.dryRun}`);

  const result = runShadowCompare({
    substrates,
    scenarios,
    seeds,
    outputDir: args.outputDir,
    dryRun: args.dryRun,
    healthyWindows: args.healthyWindows,
  });

  console.log(`[run-shadow-compare] emitted ${Object.keys(result.per_profile_report_cards).length} per-profile report cards`);
  console.log(`[run-shadow-compare]   cross-substrate diff: ${result.cross_substrate_diff_path}`);
  console.log(`[run-shadow-compare]   pitch summary: ${result.pitch_summary_path}`);
  console.log(`[run-shadow-compare] acceptance gates:`);
  for (const [gate, pass] of Object.entries(result.acceptance_gates)) {
    console.log(`[run-shadow-compare]   ${gate}: ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
  }

  if (args.emit) {
    emitSingleSummary(args, inputs, result);
  }
}
