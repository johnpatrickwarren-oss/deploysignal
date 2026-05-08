// tools/q60-evaluate-acceptance.ts — Q60 Slice 1 Phase 3 acceptance
// gate evaluation per Q60 spec § Acceptance criteria 9 + 12 (FPR-based,
// non-stubbed). Criteria 8 / 10 / 11 / 13 (TPR + TTD) await Phase 3.3+
// TPR-sweep wiring; this evaluator surfaces per-(substrate × detector
// × scenario) FPR diagnostics + acceptance pass/fail.
//
// Usage:
//   node tools/q60-evaluate-acceptance.ts \
//     --sweep-dir runs/validation-reports/q60-sweep/ \
//     --out runs/validation-reports/q60-sweep/acceptance-report.json

import * as fs from 'node:fs';
import * as path from 'node:path';

const Q60_DETECTOR_FAMILIES = [
  'family_A_betting', 'family_A_page_cusum',
  'family_C_safe_test', 'family_C_chi_square',
  'family_D_spectral', 'family_D_kv_cache',
  'family_E_conformal',
  'mmd_betting', 'mmd_bootstrap_null',
  'family_B_pattern_match',
] as const;
type DetectorFamily = typeof Q60_DETECTOR_FAMILIES[number];

const Q60_ALPHA_BUDGETS: Record<DetectorFamily, number> = {
  family_A_betting: 2e-4,
  family_A_page_cusum: 1e-4,
  family_C_safe_test: 2e-4,
  family_C_chi_square: 2e-4,
  family_D_spectral: 1e-4,
  family_D_kv_cache: 1e-4,
  family_E_conformal: 1e-4,
  mmd_betting: 1e-4,
  mmd_bootstrap_null: 1e-4,
  family_B_pattern_match: 0,
};

const ACCEPTANCE_MARGIN = 1.2;

interface ReportCard {
  profile: { dataset: string; scenario: string; baseline_provenance: string; compiled_config_version: string };
  per_detector_firing_counts_mean: Record<string, number>;
  per_detector_fpr_mean: Record<string, number>;
}

interface CrossSubstrateDiff {
  reference_substrate: string;
  per_profile_diffs: Record<string, {
    reference_substrate: string;
    delta_FPR_per_detector: Record<string, number>;
    acceptance_gates_passed: Record<string, boolean>;
  }>;
}

interface SweepCheckpoint {
  substrate: string;
  scenario: string;
  seed: number;
  status: string;
  detector_exemptions?: Record<string, string>;
  per_detector_firing_counts?: Record<string, number>;
}

interface CriterionEval {
  detector: DetectorFamily;
  substrate: string;
  scenario: string;
  alpha_budget: number;
  threshold: number;
  observed: number;
  passed: boolean;
  exempted: boolean;
  exemption_reason?: string;
}

interface AcceptanceReport {
  generated_at: string;
  sweep_dir: string;
  reference_substrate: string;
  criterion_9_per_profile_fpr: {
    description: string;
    threshold_formula: string;
    n_triples_evaluated: number;
    n_triples_exempted: number;
    n_triples_passed: number;
    n_triples_failed: number;
    fail_examples: CriterionEval[];
  };
  criterion_12_cross_substrate_delta_fpr: {
    description: string;
    threshold_formula: string;
    n_triples_evaluated: number;
    n_triples_exempted: number;
    n_triples_passed: number;
    n_triples_failed: number;
    fail_examples: CriterionEval[];
  };
  pitch_claim_table: Record<string, {
    substrate: string;
    detectors_exercised: string[];
    detectors_exempted: string[];
    n_per_profile_pairs: number;
  }>;
  summary: { criterion_9_overall_pass: boolean; criterion_12_overall_pass: boolean; phase_3_acceptance_overall: boolean };
}

function parseArgs(argv: string[]): { sweepDir: string; out: string } {
  const out: { sweepDir?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--sweep-dir') { out.sweepDir = v; i++; }
    else if (k === '--out') { out.out = v; i++; }
  }
  if (!out.sweepDir || !out.out) {
    throw new Error('Required: --sweep-dir <dir> --out <file>');
  }
  return out as { sweepDir: string; out: string };
}

function loadReportCards(sweepDir: string): Map<string, ReportCard> {
  const cards = new Map<string, ReportCard>();
  for (const f of fs.readdirSync(sweepDir)) {
    if (!f.endsWith('.json')) continue;
    if (f === 'shadow-compare-cross-substrate.json' || f === 'pitch-summary.json' || f === 'acceptance-report.json') continue;
    const full = path.join(sweepDir, f);
    if (!fs.statSync(full).isFile()) continue;
    try {
      const card = JSON.parse(fs.readFileSync(full, 'utf8')) as ReportCard;
      if (!card.profile?.scenario) continue;
      const key = f.replace(/\.json$/, '');
      cards.set(key, card);
    } catch { /* skip malformed */ }
  }
  return cards;
}

function loadCheckpoints(sweepDir: string): Map<string, SweepCheckpoint> {
  const cps = new Map<string, SweepCheckpoint>();
  const cpDir = path.join(sweepDir, 'checkpoints');
  if (!fs.existsSync(cpDir)) return cps;
  for (const f of fs.readdirSync(cpDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const cp = JSON.parse(fs.readFileSync(path.join(cpDir, f), 'utf8')) as SweepCheckpoint;
      cps.set(`${cp.substrate}--${cp.scenario}--${cp.seed}`, cp);
    } catch { /* skip */ }
  }
  return cps;
}

function evaluate(sweepDir: string, outPath: string): void {
  const cards = loadReportCards(sweepDir);
  const checkpoints = loadCheckpoints(sweepDir);
  const diffPath = path.join(sweepDir, 'shadow-compare-cross-substrate.json');
  const diff: CrossSubstrateDiff = fs.existsSync(diffPath)
    ? JSON.parse(fs.readFileSync(diffPath, 'utf8'))
    : { reference_substrate: 'synthetic_v1', per_profile_diffs: {} };

  // Build per-(substrate × scenario) exemption map from any one of the
  // 8 seed checkpoints (exemptions are uniform across seeds for a given
  // substrate per L2 (D) Step 0 design).
  const exemptionsByProfile = new Map<string, Record<string, string>>();
  for (const cp of checkpoints.values()) {
    if (cp.status !== 'completed') continue;
    const key = `${cp.substrate}--${cp.scenario}`;
    if (!exemptionsByProfile.has(key)) {
      exemptionsByProfile.set(key, cp.detector_exemptions ?? {});
    }
  }

  // Criterion 9 — per-profile FPR ≤ α × 1.2 (per-detector × per-profile).
  const c9Evals: CriterionEval[] = [];
  for (const [key, card] of cards.entries()) {
    const [substrate, scenario] = key.split('--');
    const exemptions = exemptionsByProfile.get(key) ?? {};
    for (const detector of Q60_DETECTOR_FAMILIES) {
      const alpha = Q60_ALPHA_BUDGETS[detector];
      if (alpha === 0) continue;  // family_B non-α-consuming; skip
      const exempted = !!exemptions[detector];
      const observed = card.per_detector_fpr_mean[detector] ?? 0;
      const threshold = alpha * ACCEPTANCE_MARGIN;
      const passed = exempted || observed <= threshold;
      c9Evals.push({
        detector, substrate, scenario,
        alpha_budget: alpha, threshold, observed, passed, exempted,
        exemption_reason: exempted ? exemptions[detector] : undefined,
      });
    }
  }

  // Criterion 12 — cross-substrate ΔFPR ≤ 0.5 × α × 1.2.
  const c12Evals: CriterionEval[] = [];
  for (const [key, block] of Object.entries(diff.per_profile_diffs)) {
    const [substrate, scenario] = key.split('--');
    const exemptions = exemptionsByProfile.get(key) ?? {};
    for (const detector of Q60_DETECTOR_FAMILIES) {
      const alpha = Q60_ALPHA_BUDGETS[detector];
      if (alpha === 0) continue;
      const exempted = !!exemptions[detector];
      const delta = Math.abs(block.delta_FPR_per_detector?.[detector] ?? 0);
      const threshold = 0.5 * alpha * ACCEPTANCE_MARGIN;
      const passed = exempted || delta <= threshold;
      c12Evals.push({
        detector, substrate, scenario,
        alpha_budget: alpha, threshold, observed: delta, passed, exempted,
        exemption_reason: exempted ? exemptions[detector] : undefined,
      });
    }
  }

  // Build pitch claim table per substrate.
  const substrateNames = new Set<string>();
  for (const key of cards.keys()) substrateNames.add(key.split('--')[0]);
  const pitchTable: AcceptanceReport['pitch_claim_table'] = {};
  for (const sub of substrateNames) {
    // Use any one scenario's exemption map; uniform per substrate per (D) design.
    const exKey = Array.from(exemptionsByProfile.keys()).find((k) => k.startsWith(sub + '--'));
    const exemptions = exKey ? exemptionsByProfile.get(exKey) ?? {} : {};
    const exempted = Object.keys(exemptions);
    const exercised = Q60_DETECTOR_FAMILIES.filter((d) => !exemptions[d]);
    const nPairs = Array.from(cards.keys()).filter((k) => k.startsWith(sub + '--')).length;
    pitchTable[sub] = {
      substrate: sub,
      detectors_exercised: exercised,
      detectors_exempted: exempted,
      n_per_profile_pairs: nPairs,
    };
  }

  const c9Failed = c9Evals.filter((e) => !e.passed);
  const c12Failed = c12Evals.filter((e) => !e.passed);
  const c9ExemptedCount = c9Evals.filter((e) => e.exempted).length;
  const c12ExemptedCount = c12Evals.filter((e) => e.exempted).length;

  const report: AcceptanceReport = {
    generated_at: new Date().toISOString(),
    sweep_dir: sweepDir,
    reference_substrate: diff.reference_substrate,
    criterion_9_per_profile_fpr: {
      description: 'Per-profile FPR ≤ α-budget × 1.2 on every (substrate × detector × scenario) non-exempted triple.',
      threshold_formula: 'α-budget × 1.2 (margin per Q60.7 spec)',
      n_triples_evaluated: c9Evals.length,
      n_triples_exempted: c9ExemptedCount,
      n_triples_passed: c9Evals.filter((e) => e.passed && !e.exempted).length,
      n_triples_failed: c9Failed.length,
      fail_examples: c9Failed.slice(0, 10),
    },
    criterion_12_cross_substrate_delta_fpr: {
      description: 'Cross-substrate ΔFPR ≤ 0.5 × α-budget × 1.2 on every cross-substrate (substrate × detector × scenario) non-exempted triple.',
      threshold_formula: '0.5 × α-budget × 1.2',
      n_triples_evaluated: c12Evals.length,
      n_triples_exempted: c12ExemptedCount,
      n_triples_passed: c12Evals.filter((e) => e.passed && !e.exempted).length,
      n_triples_failed: c12Failed.length,
      fail_examples: c12Failed.slice(0, 10),
    },
    pitch_claim_table: pitchTable,
    summary: {
      criterion_9_overall_pass: c9Failed.length === 0,
      criterion_12_overall_pass: c12Failed.length === 0,
      phase_3_acceptance_overall: c9Failed.length === 0 && c12Failed.length === 0,
    },
  };

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`[q60-evaluate-acceptance] wrote ${outPath}`);
  console.log(`  criterion 9 (per-profile FPR): ${report.criterion_9_per_profile_fpr.n_triples_passed}/${report.criterion_9_per_profile_fpr.n_triples_evaluated - report.criterion_9_per_profile_fpr.n_triples_exempted} non-exempted triples PASS (${report.criterion_9_per_profile_fpr.n_triples_failed} fail; ${report.criterion_9_per_profile_fpr.n_triples_exempted} exempted)`);
  console.log(`  criterion 12 (cross-substrate ΔFPR): ${report.criterion_12_cross_substrate_delta_fpr.n_triples_passed}/${report.criterion_12_cross_substrate_delta_fpr.n_triples_evaluated - report.criterion_12_cross_substrate_delta_fpr.n_triples_exempted} non-exempted triples PASS (${report.criterion_12_cross_substrate_delta_fpr.n_triples_failed} fail; ${report.criterion_12_cross_substrate_delta_fpr.n_triples_exempted} exempted)`);
  console.log(`  Phase 3 acceptance overall: ${report.summary.phase_3_acceptance_overall ? 'PASS' : 'FAIL'}`);
}

if (process.argv.some((a) => a === '--sweep-dir')) {
  const args = parseArgs(process.argv.slice(2));
  evaluate(args.sweepDir, args.out);
}

export { evaluate };
