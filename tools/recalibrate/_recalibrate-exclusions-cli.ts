// tools/recalibrate/_recalibrate-exclusions-cli.ts — R3 self-sourced
// exclusion-window inference, `exclusions` subcommand family.
//
// Deliberately NOT folded into _recalibrate-cli.ts's KNOWN_FLAGS/
// dispatch()/USAGE_TEXT (soak precedent, R5's
// tools/recalibrate/_recalibrate-soak-cli.ts — that file is the
// highest-contention shared file against the parallel refresh-controller
// workstream). This file owns its own flag table, its own usage text,
// and its own argv parser; _recalibrate-cli.ts's `main()` only ever
// hands it `argv.slice(1)` once `argv[0] === 'exclusions'`.
//
// CLI:
//   node tools/recalibrate.ts exclusions suggest --service <id> \
//     [--sessions-root runs/sessions] [--pad-minutes 30] [--now <iso>] [--root <dir>]
//   node tools/recalibrate.ts exclusions apply --service <id> \
//     (--ids i1,i2 | --all) --declared-by <id> [--now <iso>] [--root <dir>]
//   node tools/recalibrate.ts exclusions list --service <id> [--root <dir>]
//
// File ownership (this module is the SOLE writer of both):
//   exclusion-suggestions.json   CLI-owned suggestion queue (schema_version
//                                '1'). `suggest` REPLACES it wholesale with
//                                a fresh derivation every run — it NEVER
//                                touches exclusion-windows.json.
//   exclusion-windows.json       the store's OWN declared-window file
//                                (_recalibrate-store.ts's readExclusionWindows/
//                                writeExclusionWindows) — only `apply`
//                                writes here, moving confirmed suggestions
//                                out of the suggestions queue and into this
//                                file via the store's writer.
//
// Hard boundary (approved disposition, binding): everything this CLI
// prints/writes is SUGGEST-ONLY, derived exclusively from DeploySignal's
// own durable records (_recalibrate-exclusions.ts's module header) —
// `apply` requires an explicit operator (`--declared-by`) to promote a
// suggestion into a real exclusion window; nothing here is ever applied
// automatically.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { HandlerResult } from './_recalibrate-cli';
import { RecalibrationStore, type ExclusionWindow } from './_recalibrate-store';
import { deriveSuggestedExclusions, type SuggestedExclusion } from './_recalibrate-exclusions';

export const EXCLUSIONS_USAGE_TEXT = 'usage: recalibrate exclusions <suggest|apply|list> [flags]\n'
  + '  exclusions suggest --service <id> [--sessions-root runs/sessions] '
  + '[--pad-minutes 30] [--now <iso>] [--root <dir>]\n'
  + '  exclusions apply   --service <id> (--ids i1,i2 | --all) --declared-by <id> '
  + '[--now <iso>] [--root <dir>]\n'
  + '  exclusions list    --service <id> [--root <dir>]';

const DEFAULT_PAD_MINUTES = 30;
const DEFAULT_SESSIONS_ROOT = 'runs/sessions';

const ok = (lines: string[]): HandlerResult => ({ exitCode: 0, lines });

function nowOrDefault(nowIso?: string): string {
  return nowIso ?? new Date().toISOString();
}

// ── exclusion-suggestions.json I/O (CLI-owned; see module header) ─────

function suggestionsFilePath(storeDir: string): string {
  return path.join(storeDir, 'exclusion-suggestions.json');
}

function writeAtomic(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, contents);
  fs.renameSync(tmpPath, filePath);
}

/** Absent file reads as `[]` — no suggestions run yet / all applied,
 *  mirrors every other store-adjacent reader's absent-file convention. */
export function readSuggestionsFile(storeDir: string): SuggestedExclusion[] {
  const filePath = suggestionsFilePath(storeDir);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { schema_version: string; suggestions: SuggestedExclusion[] };
  return parsed.suggestions;
}

export function writeSuggestionsFile(storeDir: string, suggestions: SuggestedExclusion[]): void {
  const payload = { schema_version: '1' as const, suggestions };
  writeAtomic(suggestionsFilePath(storeDir), JSON.stringify(payload, null, 2) + '\n');
}

function formatSuggestion(s: SuggestedExclusion): string {
  return `${s.id}\t${s.start}\t${s.end}\treason=${s.reason}\tevidence=${s.evidence.join(',')}`;
}

// ── suggest ──────────────────────────────────────────────────────────

export interface ExclusionsSuggestArgs {
  serviceId: string;
  sessionsRoot?: string;
  padMinutes?: number;
  now?: string;
}

/** Recomputes the FULL suggestion set fresh from the two source stores
 *  every run and REPLACES exclusion-suggestions.json wholesale (not an
 *  incremental append) — deterministic given the source records +
 *  padMinutes + nowIso, and simplest to reason about / test (re-running
 *  `suggest` after a source record changes always reflects the current
 *  state of the durable records, never accumulates stale entries).
 *  NEVER touches exclusion-windows.json — see module header. */
export function runExclusionsSuggest(store: RecalibrationStore, args: ExclusionsSuggestArgs): HandlerResult {
  const nowIso = nowOrDefault(args.now);
  const sessionsRoot = args.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
  const padMinutes = args.padMinutes ?? DEFAULT_PAD_MINUTES;
  const sessionsServiceDir = path.join(sessionsRoot, args.serviceId);

  const suggestions = deriveSuggestedExclusions({
    sessionsServiceDir, store, padMinutes, nowIso,
  });
  writeSuggestionsFile(store.dir, suggestions);

  store.appendEvent({
    type: 'recalibration.exclusions_suggested',
    payload: { service_id: args.serviceId, count: suggestions.length },
    at: nowIso,
  });

  if (suggestions.length === 0) {
    return ok(['no exclusion windows suggested (no rollback/voided sessions or baseline rollbacks found)']);
  }
  return ok([`${suggestions.length} exclusion window(s) suggested:`, ...suggestions.map(formatSuggestion)]);
}

// ── apply ────────────────────────────────────────────────────────────

export interface ExclusionsApplyArgs {
  ids?: string[];
  all?: boolean;
  declaredBy: string;
  now?: string;
}

/** Moves confirmed suggestions (`--ids i1,i2` or `--all`) from the
 *  suggestions queue into exclusion-windows.json via the store's owned
 *  writer, stamping `declared_by` + `reason`; removes the applied
 *  entries from the suggestions file. Fails loud (no partial apply) when
 *  any requested id isn't present in the current suggestions file —
 *  clear error, no mutation — which also makes a repeated `apply` for an
 *  already-applied id idempotent-safe: it errors instead of silently
 *  re-applying or crashing. */
export function runExclusionsApply(store: RecalibrationStore, args: ExclusionsApplyArgs): HandlerResult {
  if (!args.all && (!args.ids || args.ids.length === 0)) {
    return { exitCode: 1, lines: ['exclusions apply: one of --ids or --all is required'] };
  }

  const nowIso = nowOrDefault(args.now);
  const pending = readSuggestionsFile(store.dir);

  let selected: SuggestedExclusion[];
  if (args.all) {
    selected = pending;
  } else {
    const wanted = new Set(args.ids);
    selected = pending.filter((s) => wanted.has(s.id));
    const foundIds = new Set(selected.map((s) => s.id));
    const missing = [...wanted].filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return {
        exitCode: 1,
        lines: [`exclusions apply: no such suggestion id(s): ${missing.join(', ')} (nothing applied)`],
      };
    }
  }

  if (selected.length === 0) {
    return ok(['no pending suggestions to apply']);
  }

  const selectedIds = new Set(selected.map((s) => s.id));
  const newWindows: ExclusionWindow[] = selected.map((s) => ({
    start: s.start, end: s.end, reason: s.reason, declared_by: args.declaredBy,
  }));
  store.writeExclusionWindows([...store.readExclusionWindows(), ...newWindows]);
  writeSuggestionsFile(store.dir, pending.filter((s) => !selectedIds.has(s.id)));

  store.appendEvent({
    type: 'recalibration.exclusions_applied',
    payload: { service_id: store.readMeta().service_id, count: selected.length, ids: [...selectedIds] },
    at: nowIso,
  });

  return ok([`${selected.length} exclusion window(s) applied by '${args.declaredBy}':`, ...selected.map(formatSuggestion)]);
}

// ── list ─────────────────────────────────────────────────────────────

export function runExclusionsList(store: RecalibrationStore): HandlerResult {
  const declared = store.readExclusionWindows();
  const pending = readSuggestionsFile(store.dir);

  const lines: string[] = [];
  lines.push(`declared exclusion windows (${declared.length}):`);
  lines.push(...declared.map((w) => `  ${w.start}\t${w.end}\treason=${w.reason ?? ''}\tdeclared_by=${w.declared_by ?? ''}`));
  lines.push(`pending suggestions (${pending.length}):`);
  lines.push(...pending.map((s) => `  ${formatSuggestion(s)}`));
  return ok(lines);
}

// ── argv parsing + dispatch (own flag table — see module header) ──────

const EXCLUSIONS_KNOWN_FLAGS = new Set([
  '--service', '--root', '--sessions-root', '--pad-minutes', '--now', '--ids', '--all', '--declared-by',
]);
const EXCLUSIONS_BOOLEAN_FLAGS = new Set(['--all']);

interface ParsedExclusionsArgv { action: string; flags: Record<string, string>; }

function parseExclusionsArgv(argv: string[]): ParsedExclusionsArgv {
  if (argv.length === 0) throw new Error(EXCLUSIONS_USAGE_TEXT);
  const [action, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith('--')) throw new Error(`unexpected positional argument: '${k}'. ${EXCLUSIONS_USAGE_TEXT}`);
    if (!EXCLUSIONS_KNOWN_FLAGS.has(k)) throw new Error(`Unknown flag: ${k}. ${EXCLUSIONS_USAGE_TEXT}`);
    if (EXCLUSIONS_BOOLEAN_FLAGS.has(k)) {
      flags[k.slice(2)] = 'true';
      continue;
    }
    flags[k.slice(2)] = rest[i + 1];
    i += 1;
  }
  return { action, flags };
}

function requireExclusionsFlag(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

function openExclusionsStore(flags: Record<string, string>): RecalibrationStore {
  const root = flags.root ?? 'runs/baseline-history';
  return new RecalibrationStore(path.join(root, requireExclusionsFlag(flags, 'service')));
}

function dispatchExclusions(action: string, flags: Record<string, string>): HandlerResult {
  const store = openExclusionsStore(flags);
  switch (action) {
    case 'suggest':
      return runExclusionsSuggest(store, {
        serviceId: requireExclusionsFlag(flags, 'service'),
        sessionsRoot: flags['sessions-root'],
        padMinutes: flags['pad-minutes'] !== undefined ? parseInt(flags['pad-minutes'], 10) : undefined,
        now: flags.now,
      });
    case 'apply':
      return runExclusionsApply(store, {
        ids: flags.ids !== undefined ? flags.ids.split(',').map((s) => s.trim()) : undefined,
        all: flags.all === 'true',
        declaredBy: requireExclusionsFlag(flags, 'declared-by'),
        now: flags.now,
      });
    case 'list':
      return runExclusionsList(store);
    default:
      throw new Error(`Unknown exclusions action: '${action}'. ${EXCLUSIONS_USAGE_TEXT}`);
  }
}

/** Parse + dispatch for the 'exclusions' subcommand family. Called from
 *  _recalibrate-cli.ts's `main()` with `argv.slice(1)` (i.e. `argv[0]`
 *  here is 'suggest'/'apply'/'list', not 'exclusions' — the outer
 *  `main()` already consumed that token). `async` to match `main()`'s
 *  own `await` call site (soak precedent); none of the three handlers
 *  above actually need to await anything. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function exclusionsMain(argv: string[]): Promise<HandlerResult> {
  const { action, flags } = parseExclusionsArgv(argv);
  return dispatchExclusions(action, flags);
}
