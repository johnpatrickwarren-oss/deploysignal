// test/dormancy-forbid-import.test.ts — ARCHITECT-REPLY-53 R1 (D1b).
//
// Enforces the DORMANCY.md contract: if `Addition #27 — agent` is
// marked `status: dormant`, no `.ts` file under `engine/` may import
// from `advisory/agent/`. The agent module is post-decision advisory
// (relocated per R4 D4b) and must stay disconnected from the engine
// decision path until an operator + orchestrator explicitly activates
// it via the consolidated activation slice.
//
// CI fails when an `advisory/agent/` import appears in `engine/` AND
// DORMANCY.md still lists #27 as dormant. Flipping the DORMANCY.md
// entry to `active` (operator opt-in) is what un-gates the import —
// the test is the enforcement mechanism for the dormancy contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const DORMANCY_PATH = path.join(REPO_ROOT, 'DORMANCY.md');
const ENGINE_DIR    = path.join(REPO_ROOT, 'engine');

/** Parse DORMANCY.md entry status for `Addition #N`. Returns the
 *  raw status string (e.g., 'dormant', 'active'), or null if the
 *  entry is absent or malformed. */
function readDormancyStatus(addition: number): string | null {
  const md = fs.readFileSync(DORMANCY_PATH, 'utf8');
  // Match '## Addition #N …' up to the next '## ' (or EOF) and then
  // extract the first '- status: <value>' line in that section.
  const headerRe = new RegExp(`^##\\s+Addition\\s+#${addition}\\b`, 'm');
  const header = md.match(headerRe);
  if (!header) return null;
  const section = md.slice(header.index ?? 0);
  const nextHeader = section.slice(3).search(/^##\s+/m);
  const body = nextHeader >= 0 ? section.slice(0, nextHeader + 3) : section;
  const statusMatch = body.match(/^-\s*status:\s*([A-Za-z_-]+)/m);
  return statusMatch ? statusMatch[1] : null;
}

/** Recursively list `.ts` files under a directory. */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkTs(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('dormancy-forbid-import: DORMANCY.md has an Addition #27 entry with a parseable status', () => {
  const status = readDormancyStatus(27);
  assert.ok(status !== null, 'Addition #27 entry missing or malformed in DORMANCY.md');
  assert.ok(['dormant', 'active'].includes(status),
    `Addition #27 status must be 'dormant' or 'active'; got '${status}'`);
});

test('dormancy-forbid-import: engine/ has no advisory/agent/ imports while #27 is dormant', () => {
  const status = readDormancyStatus(27);
  if (status === 'active') {
    // Operator explicitly un-dormanted. Gate passes; advisor imports
    // from engine/ are now legitimate.
    return;
  }
  assert.equal(status, 'dormant',
    `expected 'dormant' or 'active' for Addition #27; got '${status}'`);

  const files = walkTs(ENGINE_DIR);
  const offenders: Array<{ file: string; line: number; text: string }> = [];
  const importRe = /\bfrom\s+['"][^'"]*advisory\/agent\/[^'"]*['"]/;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (!importRe.test(src)) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (importRe.test(lines[i])) {
        offenders.push({
          file: path.relative(REPO_ROOT, file),
          line: i + 1,
          text: lines[i].trim(),
        });
      }
    }
  }
  assert.equal(offenders.length, 0,
    `Found ${offenders.length} 'advisory/agent/' import(s) under engine/ while Addition #27 is dormant:\n`
    + offenders.map((o) => `  ${o.file}:${o.line}: ${o.text}`).join('\n')
    + `\n\nEither remove the imports, or flip Addition #27 to 'status: active' in DORMANCY.md (requires operator + orchestrator wire-in per activation_mechanism).`);
});
