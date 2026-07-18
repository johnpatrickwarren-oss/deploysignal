// tools/recalibrate/_recalibrate-exclusions.ts — R3 self-sourced
// exclusion-window inference (SUGGEST-ONLY per the approved disposition).
//
// Hard boundary (approved scope): every suggestion here is derived from
// DeploySignal's OWN durable records — the session store
// (service/session/session-store.ts's on-disk layout) and a
// RecalibrationStore's events.jsonl — never an external incident feed.
// This module never writes anything; it only reads the two source
// stores and derives SuggestedExclusion windows from them. The CLI
// dispatch file (_recalibrate-exclusions-cli.ts) owns every write
// (exclusion-suggestions.json, exclusion-windows.json, events.jsonl).
//
// Sources (mirrors the soak-module split — separate file, minimal
// shared-file touch):
//   1. Session store: sessions/<id>.json under
//      `<sessionsServiceDir>/sessions/` (service/session/types.ts's
//      SessionRecord shape).
//        - last_verdict.verdict === 'rollback' -> window
//          [begun_at, ended_at ?? last_tick_at ?? begun_at] PADDED by
//          padMinutes on each side. reason 'rollback_session'.
//          evidence = [session_id].
//        - void_reason set (non-null) -> window over the session's own
//          span, PADDED by padMinutes on each side (same as rollback —
//          the void's `ended_at` is a wall-clock stamp of when the
//          operator DECLARED the void, not necessarily when the
//          underlying anomaly ended; treating it as an exact boundary is
//          a false-precision claim, so it gets the same symmetric pad).
//          reason `voided_session:<void_reason>`. evidence = [session_id].
//   2. RecalibrationStore.readEvents(): StoredEvents of type
//      'recalibration.rolled_back' -> window
//      [event.at - padMinutes, event.at + padMinutes]. reason
//      'baseline_rollback'. evidence = [`recal-event:<event.at>`] (a
//      StoredEvent carries no id of its own; `at` is the only stable
//      identifier available).
//
// Suggestions already COVERED by a declared exclusion window (see
// `isCoveredByDeclared` below) are filtered out of every derivation —
// containment, not mere overlap: a wider incident an operator (or a
// prior `apply`) already declared should suppress a narrower suggestion
// that falls entirely inside it (that's the exact resurrection case —
// re-running `suggest` after the same suggestion was already applied
// must not put it back in the queue), but a suggestion that only
// partially overlaps a declared window still names real, not-yet-
// covered span and stays worth surfacing.
//
// Deterministic given inputs + nowIso: every SuggestedExclusion carries
// `suggested_at: nowIso` — no `new Date()` / wall-clock read anywhere in
// this module.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type { SessionRecord } from '../../service/session/types';
import type { RecalibrationStore, ExclusionWindow } from './_recalibrate-store';

export interface SuggestedExclusion {
  /** Stable hash of (start, end, reason) — used as the --ids handle by
   *  `exclusions apply`. Recomputed (not preserved) whenever a
   *  suggestion's window/reason changes shape (e.g. via merge). */
  id: string;
  start: string;
  end: string;
  reason: string;
  evidence: string[];
  suggested_at: string;
}

/** djb2-free stable id: sha256(start|end|reason), truncated to 12 hex
 *  chars — plenty of collision resistance for a small suggestion set,
 *  short enough to type on a CLI. */
function suggestionId(start: string, end: string, reason: string): string {
  const digest = createHash('sha256').update(`${start}|${end}|${reason}`).digest('hex');
  return `excl-${digest.slice(0, 12)}`;
}

function makeSuggestion(start: string, end: string, reason: string, evidence: string[], nowIso: string): SuggestedExclusion {
  return {
    id: suggestionId(start, end, reason), start, end, reason, evidence, suggested_at: nowIso,
  };
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/** Reads every `sessions/<id>.json` record under `sessionsServiceDir`
 *  (the per-SERVICE directory — i.e. `<sessions-root>/<service_id>`,
 *  matching service/session/session-store.ts's own `serviceDir` layout)
 *  and derives suggestions for rollback + voided sessions. Absent
 *  directory (service never ran a session) reads as `[]`, not an error —
 *  mirrors every other store reader in this codebase's absent-file
 *  convention. */
export function scanSessionStore(sessionsServiceDir: string, padMinutes: number, nowIso: string): SuggestedExclusion[] {
  const sessionsDir = path.join(sessionsServiceDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const out: SuggestedExclusion[] = [];
  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8')) as SessionRecord;
    const spanEnd = rec.ended_at ?? rec.last_tick_at ?? rec.begun_at;

    if (rec.last_verdict?.verdict === 'rollback') {
      const start = addMinutes(rec.begun_at, -padMinutes);
      const end = addMinutes(spanEnd, padMinutes);
      out.push(makeSuggestion(start, end, 'rollback_session', [rec.session_id], nowIso));
    }

    if (rec.void_reason) {
      const start = addMinutes(rec.begun_at, -padMinutes);
      const end = addMinutes(spanEnd, padMinutes);
      out.push(makeSuggestion(start, end, `voided_session:${rec.void_reason}`, [rec.session_id], nowIso));
    }
  }
  return out;
}

/** Reads a RecalibrationStore's events.jsonl (via `readEvents`, no fs
 *  access of its own) and derives one padded window per
 *  'recalibration.rolled_back' StoredEvent (appended by
 *  RecalibrationStore.rollbackTo — _recalibrate-store.ts). */
export function scanRecalEvents(store: RecalibrationStore, padMinutes: number, nowIso: string): SuggestedExclusion[] {
  const out: SuggestedExclusion[] = [];
  for (const event of store.readEvents()) {
    if (event.type !== 'recalibration.rolled_back') continue;
    const start = addMinutes(event.at, -padMinutes);
    const end = addMinutes(event.at, padMinutes);
    out.push(makeSuggestion(start, end, 'baseline_rollback', [`recal-event:${event.at}`], nowIso));
  }
  return out;
}

/** Merges overlapping or adjacent-within-`padMinutes` windows (classic
 *  sorted-interval-merge; a negative gap i.e. an actual overlap always
 *  merges regardless of padMinutes' value). Merged reason is the
 *  deduplicated, order-preserving union of the constituent reasons
 *  (joined with ', '); evidence refs are concatenated (duplicates kept —
 *  each ref names a distinct source record); `suggested_at` is the
 *  latest of the constituents' (all equal in the single-call-site case,
 *  since every constituent shares the same `nowIso`, but this stays
 *  correct if callers ever merge suggestions produced at different
 *  times). Output sorted by start. */
export function mergeSuggestions(suggestions: SuggestedExclusion[], padMinutes: number): SuggestedExclusion[] {
  if (suggestions.length === 0) return [];
  const toleranceMs = padMinutes * 60_000;
  const sorted = [...suggestions].sort((a, b) => a.start.localeCompare(b.start));

  const merged: SuggestedExclusion[] = [];
  let current = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const gapMs = new Date(next.start).getTime() - new Date(current.end).getTime();
    if (gapMs <= toleranceMs) {
      current = combine(current, next);
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

function combine(a: SuggestedExclusion, b: SuggestedExclusion): SuggestedExclusion {
  const start = a.start < b.start ? a.start : b.start;
  const end = a.end > b.end ? a.end : b.end;
  const reasons = [...a.reason.split(', '), ...b.reason.split(', ')];
  const reason = [...new Set(reasons)].join(', ');
  const evidence = [...a.evidence, ...b.evidence];
  const suggested_at = a.suggested_at > b.suggested_at ? a.suggested_at : b.suggested_at;
  return makeSuggestion(start, end, reason, evidence, suggested_at);
}

/** True when `s`'s window is fully CONTAINED in some declared window —
 *  `declared.start <= s.start && s.end <= declared.end` — not merely
 *  overlapping. Containment (rather than overlap) is the deliberate
 *  choice: a declared window that only partially overlaps `s` leaves
 *  part of `s`'s span un-declared, so `s` is still worth surfacing as a
 *  suggestion for that uncovered remainder; only a declared window that
 *  already spans the ENTIRE suggestion — including the exact-match case
 *  produced when a previously-applied suggestion is re-derived verbatim
 *  (the resurrection bug this guards against) — makes `s` redundant.
 *  ISO-8601 UTC ('Z'-suffixed, fixed-width) timestamps compare correctly
 *  as plain strings, so no Date parsing is needed here. */
function isCoveredByDeclared(s: SuggestedExclusion, declared: ExclusionWindow[]): boolean {
  return declared.some((d) => d.start <= s.start && s.end <= d.end);
}

export interface DeriveExclusionsInput {
  sessionsServiceDir: string;
  store: RecalibrationStore;
  padMinutes: number;
  nowIso: string;
}

/** Convenience orchestrator the CLI calls: scan both sources, merge,
 *  sort by start, then drop anything already fully covered by a
 *  DECLARED exclusion window (`store.readExclusionWindows()` —
 *  `isCoveredByDeclared` above) so re-running `suggest` after an
 *  `apply` never resurrects an already-declared window. Deterministic
 *  given inputs + nowIso (the declared-windows file is read as of the
 *  call, same as every other store read here). */
export function deriveSuggestedExclusions(input: DeriveExclusionsInput): SuggestedExclusion[] {
  const fromSessions = scanSessionStore(input.sessionsServiceDir, input.padMinutes, input.nowIso);
  const fromEvents = scanRecalEvents(input.store, input.padMinutes, input.nowIso);
  const merged = mergeSuggestions([...fromSessions, ...fromEvents], input.padMinutes)
    .sort((a, b) => a.start.localeCompare(b.start));
  const declared = input.store.readExclusionWindows();
  return merged.filter((s) => !isCoveredByDeclared(s, declared));
}
