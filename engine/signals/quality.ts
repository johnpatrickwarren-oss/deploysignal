// engine/signals/quality.ts — AI output quality gate service
// Signals in this module require quality metrics in the scenario baseline:
//   eval_score (0–1), refusal_rate (0–1), output_len_p50 (tokens), tool_success_rate (0–1)
// Scenarios without these metrics return false (no-op) — backward compatible.
// These signals are STABLE — not rewritten by the self-improving loop.

import { trendStrength } from '@johnpatrickwarren-oss/deploysignal-engine/core';
import type { RollbackDef, ExtendDef } from '../types';

export const QUALITY_ROLLBACK_DEFS: RollbackDef[] = [
  // Eval score drop: sustained quality/factual regression proxy.
  // A stable declining trend triggers at 6% drop; volatile at 8%.
  {
    id: 'eval_quality_drop',
    label: 'Eval Quality Drop',
    check: function (m, b, _f, _ctx, tb) {
      if (!b.eval_score || !m.eval_score) return false;
      const t = tb ? tb.get('eval_score') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const drop = (b.eval_score - m.eval_score) / b.eval_score;
      const str = trendStrength(t, 'fall');
      const thr = 0.08 - 0.02 * str; // 6% stable, 8% volatile
      return drop >= thr;
    },
  },

  // Refusal spike: model has become unexpectedly restrictive.
  // 3× baseline rate, or absolute 6% floor if baseline is near zero.
  {
    id: 'refusal_spike',
    label: 'Refusal Rate Spike',
    check: function (m, b, _f, _ctx, tb) {
      if (b.refusal_rate === undefined || m.refusal_rate === undefined) return false;
      const t = tb ? tb.get('refusal_rate') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      if (b.refusal_rate > 0.001) return m.refusal_rate >= b.refusal_rate * 3.0;
      return m.refusal_rate >= 0.06;
    },
  },

  // Output length drift: truncation (ratio < 0.80) or verbosity creep (ratio > 1.20).
  // Sustained drift triggers tighter; volatile gives more headroom.
  {
    id: 'output_len_drift',
    label: 'Output Length Drift',
    check: function (m, b, _f, _ctx, tb) {
      if (!b.output_len_p50 || !m.output_len_p50) return false;
      const t = tb ? tb.get('output_len_p50') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const ratio = m.output_len_p50 / b.output_len_p50;
      const dir: 'rise' | 'fall' = ratio > 1 ? 'rise' : 'fall';
      const str = trendStrength(t, dir);
      const thr = 0.20 - 0.05 * str; // 15% sustained, 20% volatile
      return Math.abs(ratio - 1) >= thr;
    },
  },

  // Tool call degradation: agentic workflow success rate drops.
  // Only fires when scenario includes tool_success_rate in baseline.
  {
    id: 'tool_call_degradation',
    label: 'Tool Call Success Drop',
    check: function (m, b, _f, _ctx, tb) {
      if (b.tool_success_rate === undefined || m.tool_success_rate === undefined) return false;
      const t = tb ? tb.get('tool_success_rate') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const drop = (b.tool_success_rate - m.tool_success_rate) / b.tool_success_rate;
      const str = trendStrength(t, 'fall');
      const thr = 0.15 - 0.04 * str; // 11% sustained, 15% volatile
      return drop >= thr;
    },
  },
];

// EXTEND_DEFS: quality warning — eval score dropped but not yet at rollback threshold
export const QUALITY_EXTEND_DEFS: ExtendDef[] = [
  {
    id: 'quality_warning',
    label: 'Quality Warning',
    check: function (m, b, _f, _ctx, tb) {
      if (!b.eval_score || !m.eval_score) return false;
      const t = tb ? tb.get('eval_score') : null;
      if (!t || t.n < 4 || t.insufficient) return false;
      const drop = (b.eval_score - m.eval_score) / b.eval_score;
      return drop >= 0.04 && drop < 0.08; // warning band: 4–8% drop
    },
  },
];
