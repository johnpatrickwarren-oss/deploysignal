// test/q62-huggingface-research-paper-ingestion.test.ts — Q62 Slice 2
// H1 (HF-only narrowing) mapper acceptance per ARCHITECT-REPLY-Q62-
// PHASE-1-2-LS-1-SCHEMA-DRIFT-DISPOSITION § Ask 1.
//
// Phase 2 mapper-level tests on inline sample fixtures matching the
// EMPIRICAL lmsys-arena-human-preference-55k schema (NOT architect-spec-
// as-drafted; see Q62 LS-1 schema-drift diagnostic for the original
// expected vs actual divergence). AlpaServe + DeepSpeed-FastGen tests
// DROPPED at H1 (mappers tagged Phase-3.d Slice 2.b future).
//
// Phase 3 substrate-level acceptance tests (per-profile TPR/FPR/TTD;
// cross-substrate diff at 5 substrates / 10 pairs) require sweep on
// Mac mini and are deferred to Phase 3 close-PR commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapHuggingFaceLMSYSArenaRows,
  type HuggingFaceLMSYSArenaRawRow,
  SUPPORTED_SOURCES,
} from '../tools/ingest-real-trace';

// ── Sample fixtures (empirical schema; matches lmsys-arena-human-preference-55k) ───

function huggingfaceFixture(): HuggingFaceLMSYSArenaRawRow[] {
  // 5 rows. Multi-turn JSON-array embedded in prompt + response_a + response_b.
  // winner_* trio: row 0 = A wins; row 1 = B wins; row 2 = tie; row 3 = A; row 4 = B.
  return [
    {
      id: '30192',
      model_a: 'gpt-4-1106-preview',
      model_b: 'claude-3-opus',
      prompt: '["Q1: foo?", "Q2: bar?"]',
      response_a: '["A1: long winning answer with content here", "A2: another long winning answer"]',
      response_b: '["B1: shorter loser", "B2: shorter loser too"]',
      winner_model_a: true,
      winner_model_b: false,
      winner_tie: false,
    },
    {
      id: '30193',
      model_a: 'gpt-3.5-turbo',
      model_b: 'gpt-4-0613',
      prompt: '["Q1: another"]',
      response_a: '["A1: short loser"]',
      response_b: '["B1: long winning answer with much more content text"]',
      winner_model_a: false,
      winner_model_b: true,
      winner_tie: false,
    },
    {
      id: '30194',
      model_a: 'claude-3-haiku',
      model_b: 'gpt-3.5-turbo',
      prompt: '["Q1: tie?"]',
      response_a: '["A1: ambiguous"]',
      response_b: '["B1: ambiguous"]',
      winner_model_a: false,
      winner_model_b: false,
      winner_tie: true,
    },
    {
      id: '30195',
      model_a: 'gpt-4-1106-preview',
      model_b: 'gpt-3.5-turbo',
      prompt: '["Q1: third"]',
      response_a: '["A1: winning answer"]',
      response_b: '["B1: loser"]',
      winner_model_a: true,
      winner_model_b: false,
      winner_tie: false,
    },
    {
      id: '30196',
      model_a: 'claude-3-opus',
      model_b: 'gpt-4-1106-preview',
      prompt: '["Q1: fourth"]',
      response_a: '["A1: short"]',
      response_b: '["B1: long winning content"]',
      winner_model_a: false,
      winner_model_b: true,
      winner_tie: false,
    },
  ];
}

// ── Tests ───────────────────────────────────────────────────────────

test('Q62 H1 #1: empty rows return empty signal_series with synthetic-timestamp + heuristic CAVEATs', () => {
  const result = mapHuggingFaceLMSYSArenaRows([], {});
  assert.deepEqual(result.run.signal_series, {});
  assert.ok(result.filters_applied.includes('synthetic_timestamp_derivation:row_index_x_tick_seconds'),
    `synthetic_timestamp CAVEAT should always stamp; got ${JSON.stringify(result.filters_applied)}`);
  assert.ok(result.filters_applied.includes('token_count_heuristic:chars_div_4_gpt_tokenizer_approximation'));
});

test('Q62 H1 #2: reject_judge_disagreement default true drops winner_tie rows', () => {
  const rows = huggingfaceFixture();
  const noTies = mapHuggingFaceLMSYSArenaRows(rows, {});  // default reject_judge_disagreement=true
  assert.ok(noTies.filters_applied.includes('reject_judge_disagreement:true'));
  // 5 rows; 1 tie; expect 4 surviving = eval_score length 4.
  assert.equal(noTies.run.signal_series.eval_score?.length, 4);
});

test('Q62 H1 #3: reject_judge_disagreement=false retains winner_tie rows', () => {
  const rows = huggingfaceFixture();
  const allRows = mapHuggingFaceLMSYSArenaRows(rows, { reject_judge_disagreement: false });
  // tie row's winner_model_a/b both false → eval_score = 0.0 (B counts as "not A").
  assert.equal(allRows.run.signal_series.eval_score?.length, 5);
});

test('Q62 H1 #4: eval_score binary mapping (1.0 for winner_model_a; 0.0 for winner_model_b)', () => {
  const rows = huggingfaceFixture();
  const result = mapHuggingFaceLMSYSArenaRows(rows, {});
  // Surviving rows after tie-drop: A wins, B wins, A wins, B wins → [1, 0, 1, 0]
  assert.deepEqual(result.run.signal_series.eval_score, [1, 0, 1, 0]);
});

test('Q62 H1 #5: model_segment filter (gpt-4 retains rows with gpt-4 model_a or model_b)', () => {
  const rows = huggingfaceFixture();
  const result = mapHuggingFaceLMSYSArenaRows(rows, { model_segment: 'gpt-4' });
  assert.ok(result.filters_applied.includes('model_segment:gpt-4'));
  // gpt-4 rows after tie-drop: row 0 (A wins; gpt-4-1106-preview vs claude); row 1 (B wins; gpt-4-0613 as B);
  //   row 3 (A wins; gpt-4 vs gpt-3.5); row 4 (B wins; gpt-4 as B). All 4 retained.
  assert.equal(result.run.signal_series.eval_score?.length, 4);
});

test('Q62 H1 #6: tokens_turn derived from multi-turn JSON-array text length sum', () => {
  const rows = huggingfaceFixture();
  const result = mapHuggingFaceLMSYSArenaRows(rows, {});
  const tokensTurn = result.run.signal_series.tokens_turn;
  assert.ok(Array.isArray(tokensTurn) && tokensTurn.length === 4);
  // Each tokens_turn value must be a positive integer (sum of approx token counts).
  for (const t of tokensTurn) {
    assert.ok(t > 0, `tokens_turn entry should be positive; got ${t}`);
  }
});

test('Q62 H1 #7: cost_req emitted when pricing function provided', () => {
  const rows = huggingfaceFixture();
  const result = mapHuggingFaceLMSYSArenaRows(rows, {
    tokens_to_cost_per_request: (_model, prompt, response) => prompt * 1e-6 + response * 3e-6,
  });
  assert.ok(Array.isArray(result.run.signal_series.cost_req));
  assert.equal(result.run.signal_series.cost_req!.length, 4);
});

test('Q62 H1 #8: no cost_req without pricing function (and CAVEAT stamped)', () => {
  const rows = huggingfaceFixture();
  const result = mapHuggingFaceLMSYSArenaRows(rows, {});
  assert.equal(result.run.signal_series.cost_req, undefined);
  assert.ok(result.filters_applied.includes('huggingface_no_pricing_multiplier:cost_req_undefined'));
});

test('Q62 H1 #9: numeric (CSV-parsed 0/1) winner values coerce correctly', () => {
  // Simulate CSV-parsed numeric winners (parseInt result before mapper coercion).
  const rows: HuggingFaceLMSYSArenaRawRow[] = [
    { id: '1', model_a: 'gpt-4', model_b: 'claude-3', prompt: '["q"]',
      response_a: '["winning answer text"]', response_b: '["loser"]',
      winner_model_a: 1, winner_model_b: 0, winner_tie: 0 },
    { id: '2', model_a: 'gpt-4', model_b: 'claude-3', prompt: '["q"]',
      response_a: '["a"]', response_b: '["winning long"]',
      winner_model_a: 0, winner_model_b: 1, winner_tie: 0 },
  ];
  const result = mapHuggingFaceLMSYSArenaRows(rows, {});
  assert.deepEqual(result.run.signal_series.eval_score, [1, 0]);
});

test('Q62 H1 #10: SUPPORTED_SOURCES contains real_huggingface_lmsys_arena (Slice 2 H1) without alpaserve/deepspeed_fastgen', () => {
  assert.ok(SUPPORTED_SOURCES.includes('real_huggingface_lmsys_arena'));
  assert.ok(!SUPPORTED_SOURCES.includes('real_alpaserve' as never),
    `real_alpaserve should be DROPPED at H1; SUPPORTED_SOURCES=${JSON.stringify(SUPPORTED_SOURCES)}`);
  assert.ok(!SUPPORTED_SOURCES.includes('real_deepspeed_fastgen' as never),
    `real_deepspeed_fastgen should be DROPPED at H1`);
});
