// engine/recalibration/timeout.ts — Addition #15 baseline-maintenance
// lifecycle, Task 7. Pure timeout/calendar math backing the lazy
// timeout sweep + calendar safety net (plan §B D1/D2 design decisions).
//
// D6 (engine/tools split): pure, no fs, no I/O.
// tools/recalibrate/_recalibrate-sweep.ts (same task) is the impure
// layer — it reads/writes a RecalibrationStore and calls into these
// functions plus engine/recalibration/state-machine.ts's `transition`.
//
// D1 — Lazy timeout evaluation. There is no daemon watching
// timeout_at deadlines. Every tools/recalibrate.ts subcommand (Task 8)
// runs `sweepTimeouts` first, so a 'reviewable' candidate left untouched
// past its timeout_at is default-rejected at the FIRST CLI invocation
// that happens to run after expiry — not at the instant it expires.
// Documented consequence: enforcement latency = time-to-next-CLI-
// invocation. `recalibrate check` (Task 8) exists so an operator can
// wire external cron for tighter enforcement if a service needs it.

/** D1 default candidate review timeout, in days, from creation. Mirrors
 *  tools/recalibrate/_recalibrate-store.ts's DEFAULT_STORE_TIMEOUT_DAYS
 *  (Task 6, which lands first in commit order and can't import this
 *  not-yet-existing module) — both default to 14; store-meta's persisted
 *  `timeout_days` is the actual per-service override CLI code should
 *  read, this constant is `computeTimeoutAt`'s fallback when no
 *  override is threaded through. */
export const DEFAULT_TIMEOUT_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ISO-8601 UTC timestamp `timeoutDays` (default DEFAULT_TIMEOUT_DAYS)
 *  after `createdAtIso`. */
export function computeTimeoutAt(createdAtIso: string, timeoutDays: number = DEFAULT_TIMEOUT_DAYS): string {
  const createdMs = new Date(createdAtIso).getTime();
  return new Date(createdMs + timeoutDays * MS_PER_DAY).toISOString();
}

/** True when `nowIso` is at or past `timeoutAtIso`. Numeric epoch-ms
 *  comparison (not string comparison) so differing fractional-second
 *  precision between the two ISO inputs can't produce a wrong verdict. */
export function isTimedOut(timeoutAtIso: string, nowIso: string): boolean {
  return new Date(nowIso).getTime() >= new Date(timeoutAtIso).getTime();
}

/** D2 — lazy calendar safety net predicate: true when `nowIso`'s UTC
 *  (year, month) is STRICTLY later than `lastEventAtIso`'s. Same
 *  calendar month, no matter how many days apart, is NOT due — only a
 *  month-boundary crossing trips the safety net. A single
 *  (year * 12 + month) ordinal comparison handles year rollover (e.g.
 *  Dec 2026 -> Jan 2027) for free. */
export function calendarRefreshDue(lastEventAtIso: string, nowIso: string): boolean {
  const last = new Date(lastEventAtIso);
  const now = new Date(nowIso);
  const lastOrdinal = last.getUTCFullYear() * 12 + last.getUTCMonth();
  const nowOrdinal = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return nowOrdinal > lastOrdinal;
}
