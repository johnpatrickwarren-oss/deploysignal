// engine/gates/_health-structural.ts — dispatch of the rule tables (ROLLBACK_DEFS / EXTEND_DEFS):
// the policy gates and the Family B heuristics (FAMILY_B_AUTHORITY, engine/guarantees.ts).
//
// Two kinds of rule share the tables:
//   POLICY GATES — deploy-time facts on `flags` (security finding, artifact content, provenance,
//                  contract tests, toolchain SCA). Not detectors: no metric, no baseline. They run
//                  whatever the Family B mode and keep their rollback / extend effect. (The twin
//                  path runs no rule table at all — engine/gates/health.ts.)
//   FAMILY B     — hand-tuned ratio and multi-metric heuristics (alphaPolicy none). Mode:
//     'rollback' — no compiled config, or a compiled config with `family_B` and no statistical
//                  family (A, C or D): unchanged, since nothing else on the path detects.
//     'hold'     — `family_B` beside a compiled statistical family: a rollback-rule fire goes to
//                  extend[] and `family_B_holds`, never rollback[].
//     'off'      — compiled config without `family_B` (profile `structural_detectors.enabled:
//                  false`, or the CLI dropped B): no Family B rule runs.

import type {
  Metrics, Baseline, Flags, PolicyContext, FiredSignal, HealthResult, TrendBufferI, CompiledConfig,
  RollbackDef,
} from '../types';
import { ROLLBACK_DEFS, EXTEND_DEFS } from './_health-defs';
import { FAMILY_A_RETIRED_RATIO_IDS } from './_health-types';
import { POLICY_GATE_IDS } from '../guarantees';

export type StructuralMode = 'rollback' | 'hold' | 'off';

/** A HealthResult carrying the Family B holds (an extension field, like `twin_arm`). */
export type StructuralHealth = HealthResult & { family_B_holds?: FiredSignal[] };

export interface RuleFires {
  rollback: FiredSignal[];
  extend: FiredSignal[];
  legacyShadow: FiredSignal[];
  holds: FiredSignal[];
}

export interface RuleInputs {
  live: Metrics;
  baseline: Baseline;
  flags: Flags;
  pol: PolicyContext;
  tb: TrendBufferI | null;
  sup: string[];
  bypass: { [id: string]: boolean };
}

/** Does the config compile a statistical family (A, C or D) beside Family B? E is advisory
 *  (FAMILY_E_ADVISORY) and does not count. Since C87 (TEMPORAL_PATH_AUTHORITY) A, C and D are
 *  advisory as well: they detect and report and do not roll back. The hold-only rule is unchanged
 *  by that, so on such a config Family B holds and nothing statistical rolls back. */
function statisticalFamilyCompiled(cfg: CompiledConfig): boolean {
  const bc = cfg.baseline_cells;
  if (!bc) return false;
  return bc.cells.some((c) => c.family_A || c.family_C) || !!bc.aggregate_fallback.family_D;
}

export function structuralMode(cfg: CompiledConfig | null | undefined): StructuralMode {
  if (!cfg) return 'rollback';
  if (!cfg.family_B) return 'off';
  return statisticalFamilyCompiled(cfg) ? 'hold' : 'rollback';
}

/** The Family B holds a health result carries; empty when none. */
export function familyBHolds(h: HealthResult): FiredSignal[] {
  return (h as StructuralHealth).family_B_holds ?? [];
}

function routeRollbackFire(out: RuleFires, d: RollbackDef, mode: StructuralMode, familyAPromoted: boolean): void {
  const s: FiredSignal = { id: d.id, label: d.label };
  if (familyAPromoted && FAMILY_A_RETIRED_RATIO_IDS.has(d.id)) out.legacyShadow.push(s);
  else if (mode === 'hold' && !POLICY_GATE_IDS.has(d.id)) { out.extend.push(s); out.holds.push(s); }
  else out.rollback.push(s);
}

/** Evaluate the rule tables in table order. `mode: 'off'` runs the policy gates only. */
export function evaluateRules(inp: RuleInputs, mode: StructuralMode, familyAPromoted: boolean): RuleFires {
  const out: RuleFires = { rollback: [], extend: [], legacyShadow: [], holds: [] };
  const skip = (id: string): boolean => mode === 'off' && !POLICY_GATE_IDS.has(id);
  ROLLBACK_DEFS.forEach(function (d) {
    if (skip(d.id)) return;
    if (inp.sup.indexOf(d.id) >= 0 && !inp.bypass[d.id]) return;  // suppressed during warmup
    if (d.check(inp.live, inp.baseline, inp.flags, inp.pol, inp.tb)) routeRollbackFire(out, d, mode, familyAPromoted);
  });
  EXTEND_DEFS.forEach(function (d) {
    if (skip(d.id)) return;
    if (inp.sup.indexOf(d.id) >= 0) return;
    if (d.check(inp.live, inp.baseline, inp.flags, inp.pol, inp.tb)) out.extend.push({ id: d.id, label: d.label });
  });
  return out;
}
