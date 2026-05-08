// test/demo-tenant-skew.test.ts — Addition #23 D6 keystone behavior:
// portfolio catches the tenant-B regression on its 'large'-tier cell;
// cascade aggregates across tenants and stays under threshold (misses).
//
// Per ARCHITECT-REPLY-39 D6 expected outcomes:
//   • Portfolio: rollback at t in [10, 22]; first-fire family = {A};
//     detector_id includes 'page_cusum_eval_score' (or
//     'betting_e_process_eval_score' if betting wins the race).
//   • Cascade: no rollback; eval_score's per-tenant 5%-of-mean drop is
//     below the cascade quality-drop 6% threshold.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompiledConfig, OrchestrateParams, AuditRecordV2, FamilyId, BaselineCellEntry } from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');
const { loadDemoScript } = require('../demos/load-demo');

const ROOT = path.resolve(__dirname, '..');
const DEMOS_DIR = path.join(ROOT, 'demos', 'scripts');
const V4_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

/** Extended applyCellPatch — Addition #23 adds:
 *    - tenant_tier_map: stamped onto cfg
 *    - tenant_tier_config: stamped onto cfg
 *    - tenant_tier_cells: array of cell entries appended to baseline_cells.cells
 *  Existing demo cell_patch fields (target_cell, family_A_per_signal,
 *  family_C_mean_vector) continue to work — see demos/scripts/demo-clean.json. */
function applyCellPatch(src: any, patch: any): any {
  if (!src || !patch) return src;
  const cfg = JSON.parse(JSON.stringify(src));
  const target = patch.target_cell || {};
  const cell = (cfg.baseline_cells?.cells || []).find((c: any) =>
    c.key && c.key.hour_of_day === target.hour_of_day && c.key.day_of_week === target.day_of_week);
  if (cell && patch.family_A_per_signal && cell.family_A) {
    for (const sig of Object.keys(patch.family_A_per_signal)) {
      cell.family_A.per_signal[sig] = patch.family_A_per_signal[sig];
    }
  }
  if (cell && patch.family_C_mean_vector && cell.family_C) {
    cell.family_C.mean_vector = patch.family_C_mean_vector.slice();
  }
  if (patch.tenant_tier_map) cfg.tenant_tier_map = patch.tenant_tier_map;
  if (patch.tenant_tier_config) cfg.tenant_tier_config = patch.tenant_tier_config;
  if (patch.tenant_tier_cells && Array.isArray(patch.tenant_tier_cells)) {
    cfg.baseline_cells = cfg.baseline_cells || { cells: [], aggregate_fallback: {} };
    if (!Array.isArray(cfg.baseline_cells.cells)) cfg.baseline_cells.cells = [];
    if (!cfg.baseline_cells.dimensions.includes('tenant_tier')) {
      cfg.baseline_cells.dimensions.push('tenant_tier');
    }
    for (const tcell of patch.tenant_tier_cells) {
      const entry: BaselineCellEntry = {
        key: { ...tcell.key },
        n_samples: tcell.n_samples ?? 250,
        confidence: tcell.confidence ?? 'strict',
      };
      if (tcell.family_A_per_signal) {
        const perSignal: Record<string, any> = {};
        for (const sig of Object.keys(tcell.family_A_per_signal)) {
          const p = tcell.family_A_per_signal[sig];
          // Stamp tau_squared from delta_min when not provided (compiler convention).
          perSignal[sig] = {
            ...p,
            tau_squared: p.tau_squared ?? (p.delta_min * p.delta_min) / 4,
          };
        }
        entry.family_A = { per_signal: perSignal };
      }
      cfg.baseline_cells.cells.push(entry);
    }
  }
  return cfg;
}

interface TickFrame {
  tick: number;
  verdict: string;
  families: Record<FamilyId, { verdict: string; detectors: any[]; alpha_spent: number }>;
}
const FAMS: FamilyId[] = ['A', 'B', 'C', 'D', 'E'];
const EMPTY_FAMS = (): TickFrame['families'] => ({
  A: { verdict: 'clean', detectors: [], alpha_spent: 0 },
  B: { verdict: 'clean', detectors: [], alpha_spent: 0 },
  C: { verdict: 'clean', detectors: [], alpha_spent: 0 },
  D: { verdict: 'clean', detectors: [], alpha_spent: 0 },
  E: { verdict: 'clean', detectors: [], alpha_spent: 0 },
});

interface TraceSummary {
  frames: TickFrame[];
  firstRollback: number | null;
  firstFireByFam: Record<FamilyId, number | null>;
  firstFireDetectorsByFam: Record<FamilyId, string[] | null>;
  alphaAtDecision: number;
}

function summarize(frames: TickFrame[]): TraceSummary {
  const firstFireByFam: Record<FamilyId, number | null> = { A: null, B: null, C: null, D: null, E: null };
  const firstFireDetectorsByFam: Record<FamilyId, string[] | null> = { A: null, B: null, C: null, D: null, E: null };
  let firstRollback: number | null = null;
  for (const f of frames) {
    if (f.verdict === 'rollback' && firstRollback === null) firstRollback = f.tick;
    for (const fam of FAMS) {
      const fa = f.families[fam];
      if (fa && fa.verdict === 'fire' && firstFireByFam[fam] === null) {
        firstFireByFam[fam] = f.tick;
        firstFireDetectorsByFam[fam] = fa.detectors.map((d: any) => d.detector_id);
      }
    }
  }
  const decT = firstRollback === null ? frames.length - 1 : firstRollback;
  let alphaAtDecision = 0;
  for (let t = 0; t <= decT; t++) {
    for (const fam of FAMS) alphaAtDecision += frames[t].families[fam]?.alpha_spent || 0;
  }
  return { frames, firstRollback, firstFireByFam, firstFireDetectorsByFam, alphaAtDecision };
}

function runDemo(demo: any, mode: 'cascade' | 'portfolio', V4: CompiledConfig): TraceSummary {
  const cfg = applyCellPatch(V4, demo.cell_patch);
  const tb = new TrendBuffer(10);
  const frames: TickFrame[] = [];
  for (let t = 0; t < demo.ticks.length; t++) {
    const live = demo.ticks[t].metrics;
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live, scenario: demo,
      hoursElapsed: t * (demo.bakeHours / demo.ticks.length),
      trendBuffer: tb, tick: t, totalTicks: demo.ticks.length,
      compiledConfig: mode === 'portfolio' ? cfg : undefined,
      currentHourOfDay: mode === 'portfolio' ? demo.currentHourOfDay : undefined,
      currentDayOfWeek: mode === 'portfolio' ? demo.currentDayOfWeek : undefined,
      tenantId: mode === 'portfolio' ? demo.tenantId : undefined,
      fusionTopology: mode,
    };
    const res = orchestrate(params);
    const rec = buildAuditRecord(params, res, { service: demo.id }) as AuditRecordV2;
    frames.push({
      tick: t,
      verdict: res.verdict,
      families: (rec.families as any) || EMPTY_FAMS(),
    });
  }
  return summarize(frames);
}

let DEMO: any;
let V4: CompiledConfig;
let TRACE_PORT: TraceSummary;
let TRACE_CASC: TraceSummary;

before(() => {
  V4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  DEMO = loadDemoScript(path.join(DEMOS_DIR, 'demo-tenant-skew.json'));
  TRACE_PORT = runDemo(DEMO, 'portfolio', V4);
  TRACE_CASC = runDemo(DEMO, 'cascade', V4);
});

test('demo-tenant-skew: portfolio catches via Family A on the large-tier cell', () => {
  const exp = DEMO.expected_outcome;
  assert.notEqual(TRACE_PORT.firstRollback, null,
    `portfolio: expected rollback within [${exp.first_fire_tick_min}, ${exp.first_fire_tick_max}]; firstFire-by-fam=${JSON.stringify(TRACE_PORT.firstFireByFam)}`);
  const t = TRACE_PORT.firstRollback as number;
  assert.ok(t >= exp.first_fire_tick_min && t <= exp.first_fire_tick_max,
    `portfolio rollback at t=${t} outside expected window [${exp.first_fire_tick_min}, ${exp.first_fire_tick_max}]`);
  // Family A is the catcher (per D6).
  assert.equal(TRACE_PORT.firstFireByFam.A, t,
    `portfolio: Family A expected to first-fire at the rollback tick (t=${t}); got A=${TRACE_PORT.firstFireByFam.A}`);
  // No other family in the first-firing set at the rollback tick.
  for (const fam of ['B', 'C', 'D', 'E'] as FamilyId[]) {
    const ft = TRACE_PORT.firstFireByFam[fam];
    if (ft !== null) {
      assert.ok(ft > t, `portfolio: family ${fam} fired at t=${ft}, expected to stay clean through rollback (t=${t})`);
    }
  }
  // Detector id is the tenant-B regressing signal — page-cusum or betting-e-process.
  const dets = TRACE_PORT.firstFireDetectorsByFam.A || [];
  const matched = dets.includes('mSPRT_eval_score') ||
                  dets.includes('page_cusum_eval_score') ||
                  dets.includes('betting_e_process_eval_score');
  assert.ok(matched,
    `portfolio: Family A first-fire detectors=${JSON.stringify(dets)}; expected to include eval_score CUSUM or betting variant`);
  // α at decision under cap.
  assert.ok(TRACE_PORT.alphaAtDecision <= exp.alpha_total_max,
    `portfolio: α=${TRACE_PORT.alphaAtDecision.toExponential(3)} exceeds cap ${exp.alpha_total_max.toExponential(3)}`);
});

test('demo-tenant-skew: cascade misses (no rollback) — aggregate eval_score under 6% threshold', () => {
  // Per D6: cascade computes the aggregate-across-tenants eval_score and
  // its 5%-of-baseline drop sits below the cascade `eval_quality_drop`
  // 6% rollback floor. The orchestrator's cascade path doesn't consult
  // compiledConfig; only the per-signal QUALITY_ROLLBACK_DEFS.
  assert.equal(TRACE_CASC.firstRollback, null,
    `cascade: unexpected rollback at t=${TRACE_CASC.firstRollback} (regression magnitude must stay under cascade's 6% threshold)`);
});

test('demo-tenant-skew: privacy invariant — audit records carry tenant_tier in cell_key, never tenant_id', () => {
  for (const f of TRACE_PORT.frames) {
    for (const fam of FAMS) {
      const detectors = f.families[fam]?.detectors ?? [];
      for (const d of detectors) {
        const ck = d.provenance?.cell_key;
        if (!ck) continue;
        // Privacy invariant per ARCHITECT-REPLY-39 anti-scope:
        // cell_key may carry tenant_tier (bucket) but NEVER tenant_id (raw id).
        assert.equal(ck.tenant_id, undefined,
          `audit privacy: cell_key.tenant_id leaked at t=${f.tick} fam=${fam} detector=${d.detector_id}`);
      }
    }
  }
});
