// test/verdict.test.ts — W4 §4.1.b fusion layer coverage.
//
// Tests `fuseVerdict` across the three portfolio outcomes (rollback, extend,
// proceed), the multi-family first-fire ordering, and α_spent union-bound
// accounting. Adversarial parity vs cascade lives in family-a-parity /
// family-c-parity / scenarios-unique-ids; this suite isolates the fusion
// math on synthetic HealthResult inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuseVerdict } from '../dist/engine/verdict';
import type { HealthResult, DetectorVerdict } from '../dist/engine/types';

function emptyHealth(): HealthResult {
  return {
    rollback: [],
    extend: [],
    warmup: { active: false, grace: false, pct: 100, suppressedIds: [] },
    suppressed: [],
  };
}

function cleanA(signal: string): DetectorVerdict {
  return {
    verdict: 'clean', statistic: 0, threshold: 9.6,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'reset_to_zero', family: 'A', signal,
  };
}

function fireA(signal: string, alpha = 6.67e-5): DetectorVerdict {
  return {
    verdict: 'fire', statistic: 10, threshold: 9.6,
    alpha_consumed: alpha, alpha_spent: alpha,
    reason_code: 'cusum_exceeded_threshold', family: 'A', signal,
  };
}

function indeterminateA(signal: string): DetectorVerdict {
  return {
    verdict: 'indeterminate', statistic: 4, threshold: 9.6,
    alpha_consumed: 1e-5, alpha_spent: 0,
    reason_code: 'accumulating', family: 'A', signal,
  };
}

function fireC(alpha = 2e-4): DetectorVerdict {
  return {
    verdict: 'fire', statistic: 40, threshold: 35.88,
    alpha_consumed: alpha, alpha_spent: alpha,
    reason_code: 'hotelling_exceeded_threshold', family: 'C',
  };
}

function suppressedD(reasonCode: string): DetectorVerdict {
  return {
    verdict: 'suppressed', statistic: null, threshold: null,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: reasonCode, family: 'D',
  };
}

// ── Scale-honest progress fixtures (2026-07 Important-finding fix) ──
// Linear-ish (chi²/S_n-style, small threshold) vs wealth (Ville's-
// inequality M_t vs 1/α, large threshold) DetectorVerdicts across the
// families that co-ship both shapes. See engine/verdict.ts
// `progressScaleFor` for the full evaluator-by-evaluator mapping.

/** Family C legacy χ² Hotelling, indeterminate (50% of threshold). */
function indeterminateC(): DetectorVerdict {
  return {
    verdict: 'indeterminate', statistic: 17.94, threshold: 35.88,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'accumulating', family: 'C',
  };
}

/** Family C e-MMD/betting wealth process, indeterminate at 0.72× 1/α.
 *  `signal: 'sequential_mmd_e_process'` is the real detector_id
 *  evaluateEMmd emits (engine/detectors/sequential-mmd.ts) — a
 *  definitive wealth marker independent of `reason_code`. */
function indeterminateCMmd(): DetectorVerdict {
  return {
    verdict: 'indeterminate', statistic: 7200, threshold: 10000,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'accumulating', family: 'C', signal: 'sequential_mmd_e_process',
  };
}

/** Family D spectral e-detector wealth process, indeterminate at 0.35×
 *  1/α_D (threshold = 1/α_D per engine/detectors/spectral.ts:303 —
 *  large-magnitude threshold is the only available discriminator here
 *  since both the legacy bootstrap-null and e-detector paths can share
 *  `reason_code: 'accumulating'`/`'below_threshold'`; see
 *  `progressScaleFor`'s magnitude fallback). */
function indeterminateDWealth(): DetectorVerdict {
  return {
    verdict: 'indeterminate', statistic: 3500, threshold: 10000,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'accumulating', family: 'D', signal: 'kv_cache',
  };
}

/** Family E weighted-e-value wealth process, indeterminate at 0.80× 1/α.
 *  `signal: 'weighted_conformal_e_value'` is the real detector_id
 *  evaluateConformalWeightedEValue emits (engine/detectors/conformal.ts). */
function indeterminateEWealth(): DetectorVerdict {
  return {
    verdict: 'indeterminate', statistic: 8000, threshold: 10000,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'accumulating', family: 'E', signal: 'weighted_conformal_e_value',
  };
}

// ────────────────────────────────────────────────────────────────────
// Outcome: proceed
test('fuseVerdict: proceed when all families clean (last tick, no extend)', () => {
  const h = emptyHealth();
  h.family_A_shadow = [cleanA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 31, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'proceed');
  assert.deepEqual(v.firing_families, []);
  assert.equal(v.total_alpha_spent, 0);
});

// ────────────────────────────────────────────────────────────────────
// Outcome: extend (Family A indeterminate, no fires)
test('fuseVerdict: extend when Family A indeterminate and no fires', () => {
  const h = emptyHealth();
  h.family_A_shadow = [indeterminateA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'extend');
  assert.deepEqual(v.firing_families, []);
});

// ────────────────────────────────────────────────────────────────────
// Outcome: extend (Family B extend signal present)
test('fuseVerdict: extend when Family B extend signal fires', () => {
  const h = emptyHealth();
  h.extend = [{ id: 'borderline', label: 'Borderline Latency' }];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'extend');
});

// ────────────────────────────────────────────────────────────────────
// Outcome: rollback (Family A only)
test('fuseVerdict: rollback on Family A fire alone', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'family_A_p99_latency', label: 'Family A p99_latency' }];
  h.family_A_shadow = [fireA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['A']);
  assert.ok(v.total_alpha_spent > 0);
  // Family A synthetic ID must not leak into the Family B partition.
  assert.equal(v.per_family_verdicts.B, null);
});

// ────────────────────────────────────────────────────────────────────
// Outcome: rollback (Family C only)
test('fuseVerdict: rollback on Family C fire alone', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'family_C', label: 'Family C (multivariate)' }];
  h.family_C_verdict = fireC();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['C']);
  assert.ok(v.total_alpha_spent > 0);
  assert.equal(v.per_family_verdicts.B, null);
});

// ────────────────────────────────────────────────────────────────────
// Outcome: rollback (Family B structural rule)
test('fuseVerdict: rollback on Family B structural rule', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'slowbleed', label: 'Slow Bleed (Multi-Metric Drift)' }];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['B']);
  // Family B doesn't spend Ville budget.
  assert.equal(v.total_alpha_spent, 0);
});

// ────────────────────────────────────────────────────────────────────
// First-fire attribution when multiple families fire simultaneously.
// Portfolio preserves family order A < B < C < D < E in `firing_families`.
test('fuseVerdict: multiple fires preserve A<B<C<D<E family order', () => {
  const h = emptyHealth();
  h.rollback = [
    { id: 'family_A_p99_latency', label: 'Family A p99_latency' },
    { id: 'slowbleed',            label: 'Slow Bleed' },
    { id: 'family_C',             label: 'Family C (multivariate)' },
  ];
  h.family_A_shadow = [fireA('p99_latency'), cleanA('ttft')];
  h.family_C_verdict = fireC();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['A', 'B', 'C']);
  // α sum should equal Family A's single-signal α + Family C's α (B is 0).
  const expected = 6.67e-5 + 2e-4;
  assert.ok(Math.abs(v.total_alpha_spent - expected) < 1e-12,
    `α_spent sum mismatch: got ${v.total_alpha_spent}, expected ${expected}`);
});

// ────────────────────────────────────────────────────────────────────
// α_spent is the union bound across families: sums Family A + C (not B).
test('fuseVerdict: α_spent union-bound accounting', () => {
  const h = emptyHealth();
  h.family_A_shadow = [fireA('p99_latency', 6.67e-5), fireA('ttft', 6.67e-5)];
  h.family_C_verdict = fireC(2e-4);
  h.rollback = [
    { id: 'family_A_p99_latency', label: 'Family A p99_latency' },
    { id: 'family_A_ttft',        label: 'Family A ttft' },
    { id: 'family_C',             label: 'Family C (multivariate)' },
  ];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  // Family A fires 2 signals × 6.67e-5 + Family C 2e-4.
  const expected = 2 * 6.67e-5 + 2e-4;
  assert.ok(Math.abs(v.total_alpha_spent - expected) < 1e-12);
});

// ────────────────────────────────────────────────────────────────────
// Cascade-topology output produces the same verdict shape.
test('fuseVerdict: cascade topology also aggregates, with fusion_topology=cascade', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'family_A_p99_latency', label: 'Family A p99_latency' }];
  h.family_A_shadow = [fireA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'cascade', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.equal(v.fusion_topology, 'cascade');
});

// ────────────────────────────────────────────────────────────────────
// Injected Family D/E are aggregated correctly when present.
test('fuseVerdict: injected Family D fire drives rollback and alpha accounting', () => {
  const h = emptyHealth();
  const familyD: DetectorVerdict = {
    verdict: 'fire', statistic: 0.9, threshold: 0.5,
    alpha_consumed: 1e-4, alpha_spent: 1e-4,
    reason_code: 'spectral_peak', family: 'D',
  };
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test', familyD });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['D']);
  assert.equal(v.total_alpha_spent, 1e-4);
});

test('fuseVerdict: injected Family E indeterminate drives extend', () => {
  const h = emptyHealth();
  const familyE: DetectorVerdict = {
    verdict: 'indeterminate', statistic: 1.5, threshold: 2.0,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'conformal_marginal', family: 'E',
  };
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test', familyE });
  assert.equal(v.verdict, 'extend');
});

// ────────────────────────────────────────────────────────────────────
// WS5 verdict explainability: verdict_rationale + evidence_outlook.
// Every FusedVerdict carries a fixed A<B<C<D<E evidence_outlook array
// and a mechanically-generated rationale string, derived only from data
// already flowing into fuseVerdict (no new statistics, no FM calls).

test('evidence_outlook: always emits exactly 5 entries in A<B<C<D<E order', () => {
  const h = emptyHealth();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 0, totalTicks: 32, deployRef: 'test' });
  assert.deepEqual(v.evidence_outlook.map((e) => e.family_id), ['A', 'B', 'C', 'D', 'E']);
});

test('verdict_rationale: rollback names the firing family and signal', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'family_A_p99_latency', label: 'Family A p99_latency' }];
  h.family_A_shadow = [fireA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.match(v.verdict_rationale, /^Rollback triggered:/);
  assert.ok(v.verdict_rationale.includes('Family A fired on p99_latency'),
    `expected fired-signal clause; got: ${v.verdict_rationale}`);
  const famA = v.evidence_outlook.find((e) => e.family_id === 'A')!;
  assert.equal(famA.state, 'fired');
  assert.equal(famA.note, 'Family A fired on p99_latency');
});

test('verdict_rationale: rollback with two firing families names both', () => {
  const h = emptyHealth();
  h.rollback = [
    { id: 'family_A_p99_latency', label: 'Family A p99_latency' },
    { id: 'family_C', label: 'Family C (multivariate)' },
  ];
  h.family_A_shadow = [fireA('p99_latency'), cleanA('ttft')];
  h.family_C_verdict = fireC();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.ok(v.verdict_rationale.includes('Family A fired on p99_latency'));
  assert.ok(v.verdict_rationale.includes('Family C fired on Hotelling T²'),
    `expected Family C fire clause; got: ${v.verdict_rationale}`);
  const famC = v.evidence_outlook.find((e) => e.family_id === 'C')!;
  assert.equal(famC.state, 'fired');
});

test('verdict_rationale + evidence_outlook: extend reports accumulating progress from statistic/threshold', () => {
  const h = emptyHealth();
  // statistic 4 / threshold 9.6 => 41.66...% => rounds to 42%.
  h.family_A_shadow = [indeterminateA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'extend');
  const famA = v.evidence_outlook.find((e) => e.family_id === 'A')!;
  assert.equal(famA.state, 'accumulating');
  assert.ok(famA.progress !== null);
  assert.ok(Math.abs((famA.progress as number) - 4 / 9.6) < 1e-9);
  // Page-CUSUM's S_n/-log(α) is linear-ish closeness — % phrasing is honest here.
  assert.equal(famA.progress_scale, 'linear');
  assert.equal(famA.note, 'Family A accumulating evidence at 42% of fire threshold');
  assert.ok(v.verdict_rationale.includes('Family A accumulating evidence at 42% of fire threshold'),
    `expected accumulating clause; got: ${v.verdict_rationale}`);
});

test('verdict_rationale + evidence_outlook: extend reports a suppressed family with suppression_reason alongside accumulating evidence', () => {
  const h = emptyHealth();
  h.family_A_shadow = [indeterminateA('p99_latency')];
  const familyD = suppressedD('ignore_threshold');
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test', familyD });
  assert.equal(v.verdict, 'extend');
  const famD = v.evidence_outlook.find((e) => e.family_id === 'D')!;
  assert.equal(famD.state, 'suppressed');
  assert.equal(famD.progress, null);
  assert.equal(famD.note, 'Family D suppressed (ignore_threshold)');
  assert.ok(v.verdict_rationale.includes('Family D suppressed (ignore_threshold)'),
    `expected suppressed clause; got: ${v.verdict_rationale}`);
  assert.ok(v.verdict_rationale.includes('Family A accumulating evidence'));
});

test('evidence_outlook: progress is null when statistic/threshold are unavailable, even mid-accumulation', () => {
  const h = emptyHealth();
  const familyE: DetectorVerdict = {
    verdict: 'indeterminate', statistic: 1.5, threshold: null,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'conformal_marginal', family: 'E',
  };
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test', familyE });
  const famE = v.evidence_outlook.find((e) => e.family_id === 'E')!;
  assert.equal(famE.state, 'accumulating');
  assert.equal(famE.progress, null);
  assert.equal(famE.note, 'Family E accumulating evidence');
});

test('evidence_outlook: Family B progress is always null (FiredSignal carries no statistic/threshold)', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'slowbleed', label: 'Slow Bleed (Multi-Metric Drift)' }];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  const famB = v.evidence_outlook.find((e) => e.family_id === 'B')!;
  assert.equal(famB.state, 'fired');
  assert.equal(famB.progress, null);
});

test('verdict_rationale: proceed reports all-clean at final tick', () => {
  const h = emptyHealth();
  h.family_A_shadow = [cleanA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 31, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'proceed');
  assert.equal(v.verdict_rationale,
    'Proceed: observation window closed with no rollback signals across all families.');
  assert.ok(v.evidence_outlook.every((e) => e.state !== 'fired' && e.state !== 'suppressed'));
});

test('verdict_rationale: baking reports all-clean mid-window', () => {
  const h = emptyHealth();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 5, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'baking');
  assert.equal(v.verdict_rationale,
    'Baking: all families clean so far; continuing observation within the window.');
  assert.ok(v.evidence_outlook.every((e) => e.state === 'clean'));
});

test('verdict_rationale: is deterministic across repeated calls on identical input', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'family_A_p99_latency', label: 'Family A p99_latency' }];
  h.family_A_shadow = [fireA('p99_latency'), cleanA('ttft')];
  const opts = { topology: 'portfolio' as const, tick: 15, totalTicks: 32, deployRef: 'test' };
  const v1 = fuseVerdict(h, opts);
  const v2 = fuseVerdict(h, opts);
  assert.equal(v1.verdict_rationale, v2.verdict_rationale);
  assert.deepEqual(v1.evidence_outlook, v2.evidence_outlook);
});

// ────────────────────────────────────────────────────────────────────
// Scale-honest progress (2026-07 Important-finding fix): a "% of fire
// threshold" reading is honest for linear-ish detectors (Page-CUSUM,
// legacy χ² Hotelling) but misleading for wealth (Ville's-inequality
// e-process) detectors, whose statistic compounds multiplicatively and
// can jump from near-zero to firing within a couple of ticks. These
// tests cover `progress_scale` and the corresponding note phrasing for
// every wealth family, plus the Family C never-mix-scales invariant.

test('evidence_outlook: Family C e-MMD/betting (wealth process) uses multiplicative phrasing, not "% of fire threshold"', () => {
  const h = emptyHealth();
  h.family_C_mmd_verdict = indeterminateCMmd();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test' });
  const emmd = v.evidence_outlook.find((e) => e.family_id === 'C' && e.detector_kind === 'e_mmd_betting')!;
  assert.equal(emmd.state, 'accumulating');
  assert.equal(emmd.progress_scale, 'wealth');
  assert.ok(Math.abs((emmd.progress as number) - 0.72) < 1e-9);
  assert.equal(emmd.note,
    'Family C (e-MMD/betting) accumulating evidence, wealth at 0.72× fire threshold '
    + '(multiplicative — evidence can compound quickly under sustained drift)');
  assert.ok(!emmd.note.includes('% of fire threshold'));
});

test('evidence_outlook: Family D spectral e-detector (wealth process) uses multiplicative phrasing', () => {
  const h = emptyHealth();
  const familyD = indeterminateDWealth();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test', familyD });
  const famD = v.evidence_outlook.find((e) => e.family_id === 'D')!;
  assert.equal(famD.state, 'accumulating');
  assert.equal(famD.progress_scale, 'wealth');
  assert.ok(Math.abs((famD.progress as number) - 0.35) < 1e-9);
  assert.equal(famD.note,
    'Family D accumulating evidence, wealth at 0.35× fire threshold '
    + '(multiplicative — evidence can compound quickly under sustained drift)');
  assert.ok(!famD.note.includes('% of fire threshold'));
});

test('evidence_outlook: Family E weighted e-value (wealth process) uses multiplicative phrasing', () => {
  const h = emptyHealth();
  const familyE = indeterminateEWealth();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test', familyE });
  const famE = v.evidence_outlook.find((e) => e.family_id === 'E')!;
  assert.equal(famE.state, 'accumulating');
  assert.equal(famE.progress_scale, 'wealth');
  assert.ok(Math.abs((famE.progress as number) - 0.8) < 1e-9);
  assert.equal(famE.note,
    'Family E accumulating evidence, wealth at 0.80× fire threshold '
    + '(multiplicative — evidence can compound quickly under sustained drift)');
  assert.ok(!famE.note.includes('% of fire threshold'));
});

test('evidence_outlook: Family C never mixes scales — Hotelling (linear) and e-MMD (wealth) emit separate entries', () => {
  const h = emptyHealth();
  h.family_C_verdict = indeterminateC();
  h.family_C_mmd_verdict = indeterminateCMmd();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test' });
  const cEntries = v.evidence_outlook.filter((e) => e.family_id === 'C');
  assert.equal(cEntries.length, 2);
  // A<B<C<C<D<E — the two C entries stay contiguous at C's position.
  assert.deepEqual(v.evidence_outlook.map((e) => e.family_id), ['A', 'B', 'C', 'C', 'D', 'E']);

  const hotelling = cEntries.find((e) => e.detector_kind === 'hotelling')!;
  const emmd = cEntries.find((e) => e.detector_kind === 'e_mmd_betting')!;
  assert.equal(hotelling.progress_scale, 'linear');
  assert.equal(emmd.progress_scale, 'wealth');
  // Each entry's progress is its OWN detector's ratio — never averaged/
  // maxed together into one numerically-incomparable number.
  assert.ok(Math.abs((hotelling.progress as number) - 0.5) < 1e-9);
  assert.ok(Math.abs((emmd.progress as number) - 0.72) < 1e-9);
  assert.notEqual(hotelling.progress, emmd.progress);
  assert.equal(hotelling.note, 'Family C (Hotelling T²) accumulating evidence at 50% of fire threshold');
  assert.ok(!hotelling.note.includes('×'));
  assert.ok(emmd.note.includes('×'));

  assert.ok(v.verdict_rationale.includes('Family C (Hotelling T²) accumulating evidence at 50% of fire threshold'));
  assert.ok(v.verdict_rationale.includes('wealth at 0.72× fire threshold'));
});

test('evidence_outlook: Family C emits a single clean entry (no detector_kind) when neither detector reports', () => {
  const h = emptyHealth();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 5, totalTicks: 32, deployRef: 'test' });
  const cEntries = v.evidence_outlook.filter((e) => e.family_id === 'C');
  assert.equal(cEntries.length, 1);
  assert.equal(cEntries[0].state, 'clean');
  assert.equal(cEntries[0].progress, null);
  assert.equal(cEntries[0].progress_scale, null);
  assert.equal(cEntries[0].detector_kind, undefined);
});

test('evidence_outlook: Family C dual-detector output is deterministic across repeated calls', () => {
  const h = emptyHealth();
  h.family_C_verdict = indeterminateC();
  h.family_C_mmd_verdict = indeterminateCMmd();
  const opts = { topology: 'portfolio' as const, tick: 10, totalTicks: 32, deployRef: 'test' };
  const v1 = fuseVerdict(h, opts);
  const v2 = fuseVerdict(h, opts);
  assert.deepEqual(v1.evidence_outlook, v2.evidence_outlook);
  assert.equal(v1.verdict_rationale, v2.verdict_rationale);
});
