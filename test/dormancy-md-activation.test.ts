// test/dormancy-md-activation.test.ts —
// Consolidated activation slice: DORMANCY.md reflects the activated
// state of #25/#26/#27. Schema follows ARCHITECT-REPLY-53 R1 D1a.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DORMANCY = fs.readFileSync(
  path.resolve(__dirname, '..', 'DORMANCY.md'), 'utf8',
);

function extractEntry(addition: string): string {
  const marker = new RegExp(`## ${addition.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*\\n`);
  const start = DORMANCY.search(marker);
  if (start === -1) throw new Error(`DORMANCY.md: section "${addition}" not found`);
  const after = DORMANCY.slice(start);
  const endMatch = after.slice(1).search(/\n## /);
  return endMatch === -1 ? after : after.slice(0, endMatch + 1);
}

function assertActive(addition: string): void {
  const entry = extractEntry(addition);
  // R1+R5 schema per ARCHITECT-REPLY-53 §R1 D1a uses plain `- field:`
  // syntax (no bolding). Accept optional `**` wrappers so either style
  // passes; the invariant is field presence + status value.
  assert.match(entry, /(?:\*\*)?status(?:\*\*)?:\s*active/,
    `${addition}: status must be "active" (got entry: ${entry.slice(0, 200)}...)`);
  assert.match(entry, /(?:\*\*)?activation_mechanism(?:\*\*)?:/,
    `${addition}: activation_mechanism field required`);
  assert.match(entry, /(?:\*\*)?last_reviewed_ts(?:\*\*)?:/,
    `${addition}: last_reviewed_ts field required`);
}

test('dormancy: file exists at repo root', () => {
  assert.ok(DORMANCY.length > 0, 'DORMANCY.md must be non-empty');
  assert.match(DORMANCY, /^# DORMANCY\.md/m, 'must start with the v1 header');
});

test('dormancy: #25 VerdictGrouper marked active', () => {
  assertActive('Addition #25');
});

test('dormancy: #26 TopologyEnricher marked active', () => {
  assertActive('Addition #26');
});

test('dormancy: #27 AgentProposer marked active', () => {
  assertActive('Addition #27');
});

test('dormancy: schema per ARCHITECT-REPLY-53 R1 D1a — all required fields present per entry', () => {
  // Each `## Addition #N` block must have status/activation_mechanism/
  // last_reviewed_ts/activation_disposition.
  const matches = DORMANCY.match(/^## Addition #\d+/gm) ?? [];
  assert.ok(matches.length >= 3, `expected ≥3 Addition entries; got ${matches.length}`);
  for (const header of matches) {
    const adNum = header.replace('## ', '');
    const entry = extractEntry(adNum);
    assert.match(entry, /(?:\*\*)?status(?:\*\*)?:/, `${adNum}: status field missing`);
    assert.match(entry, /(?:\*\*)?activation_mechanism(?:\*\*)?:/, `${adNum}: activation_mechanism missing`);
    assert.match(entry, /(?:\*\*)?last_reviewed_ts(?:\*\*)?:/, `${adNum}: last_reviewed_ts missing`);
    assert.match(entry, /(?:\*\*)?activation_disposition(?:\*\*)?:/, `${adNum}: activation_disposition missing`);
  }
});
