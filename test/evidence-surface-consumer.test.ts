// test/evidence-surface-consumer.test.ts — consumer half of engine ADR
// 0027 (per-detector evidence surface).
//
// The engine adds an optional `evidence: EvidenceSurface` to its
// DetectorVerdict on the multiplicative wealth detectors. This repo
// reads it as optional at two sinks — `fuseVerdict`'s `evidence_outlook`
// (engine/verdict.ts) and the v2 audit trip (engine/_audit-families.ts
// `tripFromVerdict`, reached here through `buildFamilyVerdictsV2`) — and
// must be byte-for-byte unchanged when it is absent, which is every
// verdict on the currently pinned engine. Fixtures below are hand-built
// DetectorVerdicts; no detector is run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuseVerdict } from '../dist/engine/verdict';
import { buildFamilyVerdictsV2 } from '../dist/engine/_audit-families';
import type {
  HealthResult, DetectorVerdict, EvidenceSurface, EvidenceOutlookEntry,
  OrchestrateParams, VerdictResult, Scenario, DetectorTripV2,
} from '../dist/engine/types';

const EVIDENCE_KEYS = ['nats_to_threshold', 'growth_rate_hat', 'anytime_p', 'threshold_kind'] as const;

function emptyHealth(): HealthResult {
  return {
    rollback: [],
    extend: [],
    warmup: { active: false, grace: false, pct: 100, suppressedIds: [] },
    suppressed: [],
  };
}

/** A fully populated surface — no nulls — so the round-trip test can
 *  assert that any null it sees was introduced by this repo. */
function surface(logWealth: number, logThreshold: number, n: number): EvidenceSurface {
  return {
    log_wealth: logWealth,
    log_increment: 0.31,
    bet: 0.42,
    n,
    log_threshold: logThreshold,
    threshold_kind: 'bootstrap',
    nats_to_threshold: logThreshold - logWealth,
    growth_rate_hat: logWealth / n,
    log_peak_wealth: logWealth,
    anytime_p: Math.min(1, Math.exp(-logWealth)),
  };
}

/** Family A Page-CUSUM, indeterminate (linear scale, `-log(α)`-sized
 *  threshold). Never carries a surface — it is not a wealth process. */
function cusumA(signal: string): DetectorVerdict {
  return {
    verdict: 'indeterminate', statistic: 4, threshold: 9.6,
    alpha_consumed: 1e-5, alpha_spent: 0,
    reason_code: 'accumulating', family: 'A', signal,
  };
}

/** Family A betting e-process, indeterminate. `threshold: 10000` is a
 *  `1/α`-sized value, which `progressScaleFor`'s magnitude fallback
 *  classifies 'wealth' (the shared `'accumulating'` reason_code is the
 *  one case that fallback exists for — engine/verdict.ts header). */
function bettingA(signal: string, statistic: number, evidence?: EvidenceSurface): DetectorVerdict {
  return {
    verdict: 'indeterminate', statistic, threshold: 10000,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'accumulating', family: 'A', signal,
    ...(evidence ? { evidence } : {}),
  };
}

function fireA(signal: string, evidence?: EvidenceSurface): DetectorVerdict {
  return {
    verdict: 'fire', statistic: 12000, threshold: 10000,
    alpha_consumed: 1e-4, alpha_spent: 1e-4,
    reason_code: 'betting_wealth_exceeded_threshold', family: 'A', signal,
    ...(evidence ? { evidence } : {}),
  };
}

function entryFor(h: HealthResult, family: 'A' | 'C' | 'D' | 'E', tick = 3): EvidenceOutlookEntry {
  const fused = fuseVerdict(h, { topology: 'portfolio', tick, totalTicks: 32, deployRef: 'ev-test' });
  const e = fused.evidence_outlook.find((x) => x.family_id === family);
  assert.ok(e, `no evidence_outlook entry for family ${family}`);
  return e;
}

function auditParams(): OrchestrateParams {
  return {
    liveMetrics: {}, scenario: {} as Scenario, hoursElapsed: 0,
    tick: 0, totalTicks: 1,
  } as OrchestrateParams;
}

function familyATrip(v: DetectorVerdict): DetectorTripV2 {
  const hr: HealthResult = {
    ...emptyHealth(),
    rollback: [{ id: 'family_A_' + v.signal, label: 'Family A ' + v.signal }],
    family_A_shadow: [v],
  };
  const families = buildFamilyVerdictsV2(auditParams(), {} as VerdictResult, hr);
  assert.equal(families.A.detectors.length, 1);
  return families.A.detectors[0];
}

// ── (a) outlook carries the surface of the max-progress detector ──

test('ADR 0027 outlook: Family A entry carries the four evidence fields '
  + 'from the max-progress same-scale detector, not a lower sibling', () => {
  const chosen = surface(7.2, 10.1, 24);     // 0.72× on the linear ratio below
  const other = surface(2.0, 10.1, 24);      // 0.35×, must NOT be picked
  const h: HealthResult = {
    ...emptyHealth(),
    family_A_shadow: [
      cusumA('p99_latency'),                       // linear, ignored once a wealth reading exists
      bettingA('p99_latency', 7200, chosen),
      bettingA('ttft', 3500, other),
    ],
  };
  const entry = entryFor(h, 'A');
  assert.equal(entry.state, 'accumulating');
  assert.equal(entry.progress_scale, 'wealth');
  assert.equal(entry.progress, 0.72);
  assert.equal(entry.nats_to_threshold, chosen.nats_to_threshold);
  assert.equal(entry.growth_rate_hat, chosen.growth_rate_hat);
  assert.equal(entry.anytime_p, chosen.anytime_p);
  assert.equal(entry.threshold_kind, 'bootstrap');
  assert.notEqual(entry.nats_to_threshold, other.nats_to_threshold);
  // Trivial renderNote extension: the wealth note names the nats distance.
  assert.match(entry.note, /wealth at 0\.72× fire threshold, 2\.9 nats to threshold/);
});

test('ADR 0027 outlook: a lower-progress sibling\'s surface is never '
  + 'substituted when the max-progress detector carries none', () => {
  const h: HealthResult = {
    ...emptyHealth(),
    family_A_shadow: [
      bettingA('p99_latency', 7200),                       // max progress, no surface
      bettingA('ttft', 3500, surface(2.0, 10.1, 24)),      // has a surface, loses on progress
    ],
  };
  const entry = entryFor(h, 'A');
  assert.equal(entry.progress, 0.72);
  for (const k of EVIDENCE_KEYS) assert.ok(!(k in entry), `unexpected key ${k}`);
});

test('ADR 0027 outlook: a Family C entry carries its own detector\'s surface', () => {
  const s = surface(5.5, 9.2, 40);
  // Built as a local-typed value first: `HealthResult` is typed with the
  // engine package's DetectorVerdict, which predates `evidence`, and a
  // fresh literal there would trip the excess-property check.
  const mmd: DetectorVerdict = {
    verdict: 'indeterminate', statistic: 7200, threshold: 10000,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'accumulating', family: 'C', signal: 'sequential_mmd_betting_e_process',
    evidence: s,
  };
  const h: HealthResult = { ...emptyHealth(), family_C_mmd_verdict: mmd };
  const entry = entryFor(h, 'C');
  assert.equal(entry.detector_kind, 'e_mmd_betting');
  assert.equal(entry.nats_to_threshold, s.nats_to_threshold);
  assert.equal(entry.threshold_kind, 'bootstrap');
});

// ── (b) no surface → no keys, and fused output is unchanged ──

test('ADR 0027 outlook: fixtures without `evidence` produce entries with '
  + 'none of the four keys present, on every family', () => {
  const h: HealthResult = {
    ...emptyHealth(),
    family_A_shadow: [cusumA('p99_latency'), bettingA('p99_latency', 7200)],
    family_C_verdict: {
      verdict: 'indeterminate', statistic: 17.94, threshold: 35.88,
      alpha_consumed: 0, alpha_spent: 0, reason_code: 'accumulating', family: 'C',
    },
    family_D_shadow: [{
      verdict: 'indeterminate', statistic: 3500, threshold: 10000,
      alpha_consumed: 0, alpha_spent: 0, reason_code: 'accumulating', family: 'D', signal: 'kv_cache',
    }],
    family_E_verdict: {
      verdict: 'indeterminate', statistic: 8000, threshold: 10000,
      alpha_consumed: 0, alpha_spent: 0, reason_code: 'accumulating', family: 'E',
      signal: 'weighted_conformal_e_value',
    },
  };
  const fused = fuseVerdict(h, { topology: 'portfolio', tick: 3, totalTicks: 32, deployRef: 'ev-test' });
  assert.equal(fused.evidence_outlook.length, 5);
  for (const entry of fused.evidence_outlook) {
    for (const k of EVIDENCE_KEYS) assert.ok(!(k in entry), `${entry.family_id}: unexpected key ${k}`);
    assert.ok(!('nats_to_threshold' in entry));
  }
  // Wealth note text is untouched when no surface is present.
  const a = fused.evidence_outlook.find((x) => x.family_id === 'A')!;
  assert.equal(
    a.note,
    'Family A accumulating evidence, wealth at 0.72× fire threshold '
      + '(multiplicative — evidence can compound quickly under sustained drift)',
  );
});

test('ADR 0027 outlook: fuseVerdict is deterministic and deepEqual across '
  + 'two evaluations of the same surface-free input', () => {
  const build = (): HealthResult => ({
    ...emptyHealth(),
    family_A_shadow: [cusumA('p99_latency'), bettingA('p99_latency', 7200), fireA('ttft')],
    rollback: [{ id: 'family_A_betting_ttft', label: 'Family A ttft' }],
  });
  const opts = { topology: 'portfolio' as const, tick: 3, totalTicks: 32, deployRef: 'ev-test' };
  const first = fuseVerdict(build(), opts);
  const second = fuseVerdict(build(), opts);
  assert.deepEqual(first, second);
  assert.equal(first.verdict, 'rollback');
  for (const entry of first.evidence_outlook) {
    for (const k of EVIDENCE_KEYS) assert.ok(!(k in entry));
  }
});

test('ADR 0027 outlook: adding a surface changes only the four keys and '
  + 'the note on the entry it belongs to', () => {
  const s = surface(7.2, 10.1, 24);
  const without = entryFor({ ...emptyHealth(), family_A_shadow: [bettingA('p99_latency', 7200)] }, 'A');
  const withS = entryFor({ ...emptyHealth(), family_A_shadow: [bettingA('p99_latency', 7200, s)] }, 'A');
  const strip = (e: EvidenceOutlookEntry): Omit<EvidenceOutlookEntry, typeof EVIDENCE_KEYS[number] | 'note'> => {
    const { nats_to_threshold, growth_rate_hat, anytime_p, threshold_kind, note, ...rest } = e;
    return rest;
  };
  assert.deepEqual(strip(withS), strip(without));
});

// ── (c) audit trip passes `evidence` through, and only when present ──

test('ADR 0027 audit: tripFromVerdict (via buildFamilyVerdictsV2) carries '
  + '`evidence` through as an equal copy when the verdict has it', () => {
  const s = surface(9.6, 9.21, 31);
  const trip = familyATrip(fireA('p99_latency', s));
  assert.equal(trip.detector_id, 'mSPRT_p99_latency');
  assert.ok('evidence' in trip);
  assert.deepEqual(trip.evidence, s);
  assert.notEqual(trip.evidence, s, 'trip must hold a copy, not the verdict\'s object');
});

test('ADR 0027 audit: a verdict without `evidence` yields a trip with no '
  + '`evidence` key at all (JSONL byte-identical to pre-ADR-0027)', () => {
  const trip = familyATrip(fireA('p99_latency'));
  assert.ok(!('evidence' in trip));
  assert.deepEqual(Object.keys(trip).sort(), [
    'alpha_spent', 'cusum_progress', 'detector_id', 'family_id', 'gate', 'label',
    'provenance', 'reason_code', 'statistic', 'threshold',
  ]);
  assert.ok(!JSON.stringify(trip).includes('evidence'));
});

// ── (d) JSON round-trip introduces no nulls ──

test('ADR 0027 audit: JSON round-trip of a trip with a fully populated '
  + 'surface has no nulls inside `evidence`, and none appear without it', () => {
  const s = surface(9.6, 9.21, 31);
  const withS = JSON.parse(JSON.stringify(familyATrip(fireA('p99_latency', s)))) as DetectorTripV2;
  assert.deepEqual(withS.evidence, s);
  for (const [k, v] of Object.entries(withS.evidence!)) {
    assert.notEqual(v, null, `evidence.${k} is null after round-trip`);
    assert.notEqual(v, undefined, `evidence.${k} dropped by round-trip`);
  }
  const without = JSON.parse(JSON.stringify(familyATrip(fireA('p99_latency')))) as Record<string, unknown>;
  assert.ok(!('evidence' in without));
  // The engine's own nullable fields survive as nulls, not as drops.
  const nullable: EvidenceSurface = { ...s, log_increment: null, bet: null, growth_rate_hat: null };
  const rt = JSON.parse(JSON.stringify(familyATrip(fireA('ttft', nullable)))) as DetectorTripV2;
  assert.deepEqual(rt.evidence, nullable);
  assert.equal(rt.evidence!.bet, null);
});
