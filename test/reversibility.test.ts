// test/reversibility.test.ts — Addition #5 unit tests.
//
// Classifier + translator + three reversibility-source implementations
// in isolation. End-to-end orchestrator tests live in
// test/reversibility-integration.test.ts (per brief's flat-layout
// convention).
//
// Brief: coordination/ARCHITECT-REPLY-32.md. Architect-set defaults
// exercised here:
//   - Default-fallback = 'forward_only' (conservative; missing
//     annotations must NOT auto-rollback).
//   - Classification is deploy-level (same values every tick).
//   - L3 still emits `rollback` regardless of reversibility; the
//     translator decides the concrete orchestrator action.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NoReversibilitySource, InlineReversibilitySource, ScenarioReversibilitySource,
} from '../dist/engine/o0/reversibility-source';
import {
  classifyReversibility, DEFAULT_FALLBACK_REVERSIBILITY,
} from '../dist/engine/g0/reversibility-classifier';
import { translateVerdict } from '../dist/engine/o0/reversibility-translator';
import type { Reversibility } from '../dist/engine/o0/reversibility-source';

// ────────────────────────────────────────────────────────────────────
// Source implementations.
// ────────────────────────────────────────────────────────────────────

test('unit 1: NoReversibilitySource returns null for every deploy_id', () => {
  const source = new NoReversibilitySource();
  assert.equal(source.getReversibility('any'), null);
  assert.equal(source.getReversibility('other'), null);
  assert.equal(source.getReversibility(''), null);
});

test('unit 2: InlineReversibilitySource pins a value across deploy_ids', () => {
  const reversible = new InlineReversibilitySource('reversible');
  assert.equal(reversible.getReversibility('d1'), 'reversible');
  assert.equal(reversible.getReversibility('d2'), 'reversible');
  const fwdOnly = new InlineReversibilitySource('forward_only');
  assert.equal(fwdOnly.getReversibility('d1'), 'forward_only');
  const nullSrc = new InlineReversibilitySource(null);
  assert.equal(nullSrc.getReversibility('d1'), null);
});

test('unit 3: ScenarioReversibilitySource reads from Record; missing deploys → null', () => {
  const source = new ScenarioReversibilitySource({
    'svc-a': 'reversible',
    'svc-b': 'forward_only',
    'svc-c': 'conditional',
  });
  assert.equal(source.getReversibility('svc-a'), 'reversible');
  assert.equal(source.getReversibility('svc-b'), 'forward_only');
  assert.equal(source.getReversibility('svc-c'), 'conditional');
  assert.equal(source.getReversibility('svc-missing'), null);
});

// ────────────────────────────────────────────────────────────────────
// Classifier — platform annotation + default fallback.
// ────────────────────────────────────────────────────────────────────

test('unit 4: classifier with platform annotation returns platform_annotation source', () => {
  for (const v of ['reversible', 'forward_only', 'conditional'] as Reversibility[]) {
    const c = classifyReversibility('d', new InlineReversibilitySource(v));
    assert.equal(c.reversibility, v, `annotation ${v} preserved`);
    assert.equal(c.reversibility_source, 'platform_annotation');
  }
});

test('unit 5: classifier with null annotation → default_fallback = forward_only', () => {
  const c = classifyReversibility('d', new NoReversibilitySource());
  assert.equal(c.reversibility, 'forward_only', 'conservative default per architect');
  assert.equal(c.reversibility_source, 'default_fallback');
  // Constant export matches the architect-set rule.
  assert.equal(DEFAULT_FALLBACK_REVERSIBILITY, 'forward_only');
});

test('unit 6: classifier runs deterministically against the same source', () => {
  const source = new ScenarioReversibilitySource({ 'd1': 'conditional' });
  const a = classifyReversibility('d1', source);
  const b = classifyReversibility('d1', source);
  assert.deepEqual(a, b);
});

// ────────────────────────────────────────────────────────────────────
// Translator — verdict × reversibility → action.
// ────────────────────────────────────────────────────────────────────

test('unit 7: translator rollback × reversibility produces the three action classes', () => {
  // rollback × reversible → rollback
  const aRb = translateVerdict('rollback', 'reversible');
  assert.deepEqual(aRb, { action: 'rollback' });

  // rollback × forward_only → pause_and_alarm
  const aFo = translateVerdict('rollback', 'forward_only', 'p99 regressed');
  assert.equal(aFo.action, 'pause_and_alarm');
  assert.ok('reason' in aFo);
  assert.match((aFo as { reason: string }).reason, /forward_only/);
  assert.match((aFo as { reason: string }).reason, /p99 regressed/);

  // rollback × conditional → human_confirmation_required
  const aCo = translateVerdict('rollback', 'conditional');
  assert.equal(aCo.action, 'human_confirmation_required');
});

test('unit 8: translator passes non-rollback verdicts through unchanged', () => {
  // Non-rollback verdicts ignore the reversibility argument. Test each of
  // the engine's three live verdicts against each reversibility value.
  const verdicts = ['proceed', 'extend', 'baking'] as const;
  const reversibilities: Reversibility[] = ['reversible', 'forward_only', 'conditional'];
  for (const v of verdicts) {
    for (const r of reversibilities) {
      const a = translateVerdict(v, r);
      assert.equal(a.action, v, `verdict ${v} × reversibility ${r} must pass through as ${v}`);
    }
  }
});
