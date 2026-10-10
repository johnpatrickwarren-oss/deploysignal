// test/twin-dormancy.test.ts — Plan B Task 7: DORMANCY.md carries the randomized twin's entry, and
// while that entry says `dormant` the twin's authority stays 'advisory' (the #27 pattern in
// test/dormancy-forbid-import.test.ts: the file's status and the code cannot drift apart).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TWIN_ARM_AUTHORITY } from '../dist/engine/guarantees';

function twinSection(): string {
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'DORMANCY.md'), 'utf8');
  const start = md.search(/^##\s+Plan B — randomized twin/m);
  assert.ok(start >= 0, 'DORMANCY.md has a "## Plan B — randomized twin" entry');
  const rest = md.slice(start + 3);
  const end = rest.search(/^##\s+/m);
  return end < 0 ? rest : rest.slice(0, end);
}

test('Plan B dormancy: the twin entry has status, activation mechanism, review date and disposition', () => {
  const body = twinSection();
  const status = body.match(/^-\s*status:\s*([A-Za-z_-]+)/m)?.[1];
  assert.equal(status, 'dormant');
  const mech = body.match(/^-\s*activation_mechanism:\s*(.+)$/m)?.[1] ?? '';
  assert.match(mech, /ADR/);
  assert.match(mech, /A\/A/);
  assert.match(body, /^-\s*last_reviewed_ts:\s*2026-10-09/m);
  assert.match(body, /^-\s*activation_disposition:\s*conditional/m);
});

test('Plan B dormancy: while the entry is dormant, TWIN_ARM_AUTHORITY is advisory', () => {
  const status = twinSection().match(/^-\s*status:\s*([A-Za-z_-]+)/m)?.[1];
  if (status === 'dormant') assert.equal(TWIN_ARM_AUTHORITY, 'advisory');
});
