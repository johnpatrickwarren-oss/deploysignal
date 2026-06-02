// engine/_orchestrator-config.ts — compiled-config overlay helper.
// Extracted verbatim from engine/orchestrator.ts (god-file split). The
// facade re-exports nothing from here; this is orchestrator-internal.

import type { PolicyContext, CompiledConfig } from './types';

// Week-1 NS keystone adapter. Overlays Family B cutoffs from a CompiledConfig
// onto the resolved PolicyContext after policy resolution. Intentionally does
// NOT touch engine/gates/** — the handoff freezes detector logic this week.
// Only threshold values change; detector behavior is otherwise identical.
export function applyCompiledConfig(pol: PolicyContext, cfg: CompiledConfig): void {
  const co = cfg.family_B && cfg.family_B.cutoffs;
  if (!co) return;
  const th = pol.thresholds;
  if (co.p99        !== undefined && th.p99)        th.p99        = { ...th.p99,        base: co.p99 };
  if (co.ttft       !== undefined && th.ttft)       th.ttft       = { ...th.ttft,       base: co.ttft };
  if (co.compound   !== undefined && th.compound)   th.compound   = { ...th.compound,   base: co.compound };
  if (co.behavioral !== undefined && th.behavioral) th.behavioral = { ...th.behavioral, base: co.behavioral };
  if (co.cost       !== undefined && th.cost)       th.cost       = { ...th.cost,       base: co.cost };
  if (co.tokens     !== undefined && th.tokens)     th.tokens     = { ...th.tokens,     base: co.tokens };
  if ((co.tok_econ_tok !== undefined || co.tok_econ_cost !== undefined) && th.tok_econ) {
    th.tok_econ = {
      ...th.tok_econ,
      baseTok:  co.tok_econ_tok  !== undefined ? co.tok_econ_tok  : th.tok_econ.baseTok,
      baseCost: co.tok_econ_cost !== undefined ? co.tok_econ_cost : th.tok_econ.baseCost,
    };
  }
  if (co.downstream !== undefined && pol.downstreamRule) {
    pol.downstreamRule = { ...pol.downstreamRule, base: co.downstream };
  }
}
