// advisory/agent/playbook.ts — Addition #27 playbook loading + rail-e filter.
//
// `loadPlaybook(dir)` — reads every `*.yaml` from `dir`, validates
// against `schema/playbook.schema.json`, returns the parsed list.
// Rejects the full set on any entry-level validation failure
// (fail-fast on misconfigured deploys).
//
// `filterPlaybookByReversibility(list, rev_tag)` — rail (e) HARD
// invariant per REPLY-49 D6. Returns the subset whose
// `reversibility_required` is compatible with `rev_tag`. The FM
// only ever sees the filtered list; it cannot propose filtered-out
// entries.
//
// `'conditional'` is treated conservatively as `'forward_only'` per
// REPLY-49 P4 semantic comparability table — prevents "the deploy
// might be reversible or not" uncertainty from allowing rollback
// proposals.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import { validateAgainstSchema } from './schema-validator';
import type { SchemaNode } from './schema-validator';
import type { Playbook } from './types';

/** Load, validate, and return every playbook under `dir/*.yaml`.
 *  Schema loaded from `dir/schema/playbook.schema.json`. Any single
 *  invalid entry aborts the load with a descriptive error — agent
 *  runtime refuses to start on a malformed playbook library. */
export function loadPlaybook(dir: string): Playbook[] {
  const schemaPath = path.join(dir, 'schema', 'playbook.schema.json');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`playbook schema not found at ${schemaPath}`);
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as SchemaNode;

  const entries: Playbook[] = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  for (const file of files) {
    const full = path.join(dir, file);
    const raw = yaml.load(fs.readFileSync(full, 'utf8')) as unknown;
    const result = validateAgainstSchema(raw, schema);
    if (!result.valid) {
      throw new Error(
        `playbook "${file}" failed schema validation:\n  ${result.errors.join('\n  ')}`,
      );
    }
    const entry = raw as Playbook;
    const expectedId = file.replace(/\.yaml$/, '');
    if (entry.id !== expectedId) {
      throw new Error(
        `playbook file ${file} has id="${entry.id}"; expected "${expectedId}"`,
      );
    }
    entries.push(entry);
  }
  // Reject duplicate ids (shouldn't happen since filename == id, but
  // guard so a future content-vs-filename drift fails fast).
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) throw new Error(`duplicate playbook id "${e.id}"`);
    seen.add(e.id);
  }
  return entries;
}

/** Standalone validator export for tests that want to exercise the
 *  schema path without writing files. */
export function validatePlaybookSchema(entry: unknown, schema: SchemaNode) {
  return validateAgainstSchema(entry, schema);
}

/** Rail (e) HARD invariant per REPLY-49 D6. Filters the playbook list
 *  to entries whose `reversibility_required` is compatible with the
 *  deploy's reversibility tag.
 *
 *    reversibility_tag = 'reversible'   → {reversible, any}
 *    reversibility_tag = 'forward_only' → {forward_only, any}
 *    reversibility_tag = 'conditional'  → {forward_only, any} (P4 conservative)
 *
 *  This function runs at AgentInputContext construction time — the FM
 *  never sees inapplicable entries; it cannot propose them. Not a
 *  confidence-gated check; NOT a post-hoc validation. */
export function filterPlaybookByReversibility(
  playbooks: Playbook[],
  reversibility_tag: 'reversible' | 'forward_only' | 'conditional',
): Playbook[] {
  // Conservative mapping: 'conditional' collapses to 'forward_only'
  // for filter purposes. Prevents the FM from proposing rollback-class
  // actions on a deploy that might not be reversible in practice.
  const effectiveTag = reversibility_tag === 'conditional' ? 'forward_only' : reversibility_tag;
  return playbooks.filter((p) => {
    if (p.reversibility_required === 'any') return true;
    return p.reversibility_required === effectiveTag;
  });
}
