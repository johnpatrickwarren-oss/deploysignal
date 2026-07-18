// service/gate-http/_gate-soak.ts — R5 live shadow soak, Task 2:
// SoakController. Service-side soak engine: shadow-evaluates a candidate
// CompiledConfig alongside every served tick and accumulates
// disagreement/coverage stats into a per-candidate durable sidecar.
//
// Per-file ownership doctrine (implementation plan §1 — binding):
//
//   File under runs/baseline-history/<service_id>/   Owner (sole writer)
//   -----------------------------------------------  --------------------
//   store-meta.json, candidates/*.json, active.json,  recalibrate CLI
//   exclusion-windows.json                            (unchanged; this
//                                                      module only reads
//                                                      candidates/*.json)
//   soak.json (manifest)                              recalibrate CLI —
//                                                      this module polls
//                                                      it read-only
//   soak/<candidate_id>.state.json (sidecar)           THIS MODULE
//   soak/<candidate_id>.ticks.jsonl (per-tick log)     THIS MODULE
//                                                      (append-only)
//   events.jsonl                                      BOTH — the sole
//                                                      multi-writer file.
//                                                      Every append here
//                                                      is one
//                                                      fs.appendFileSync
//                                                      ('a' flag ->
//                                                      O_APPEND) of a
//                                                      single compact
//                                                      line, atomic for
//                                                      local-filesystem
//                                                      writes well under
//                                                      the page/PIPE_BUF
//                                                      limit.
//
// This module never imports tools/recalibrate/* (layering: service/ ->
// engine/ only per D6) — it re-implements the tiny soak-manifest/sidecar
// file contract, exactly the precedent set by
// service/session/active-calibration.ts.
//
// Never-throws discipline: every public method is safe to call
// unconditionally from the served tick path. An absent recalibration
// directory / absent or stopped manifest / a completed sidecar / any
// read or parse error all resolve to "soak inactive" — inactive is
// always safe, and every existing test harness (empty baselineHistoryDir)
// exercises exactly this path, so soak is byte-identical-inert until a
// manifest is deliberately written by `recalibrate.ts soak start`.

import * as fs from 'fs';
import * as path from 'path';

import type {
  CompiledConfig, TrendBufferI, FailFastState, ReversibilityClassification,
} from '../../engine/types';
import type { LifecycleDeployState } from '../../engine/o0/lifecycle-events';
import type { VerdictGrouper as VerdictGrouperType } from '../../engine/verdict-groups';
import type {
  SoakManifest, SoakSidecar, SoakFamilyAttribution, CandidateRecord,
} from '../../engine/types/recalibration';

// Runtime VALUES from the built engine — same require()-the-build-
// artifact convention as _gate-session-runtime.ts (see that file's
// header for the rationale: service/ is compiled by tsconfig.test.json,
// which does not build engine/ itself).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharedEngine = require('../../shared');
const TrendBufferCtor: new (window?: number) => TrendBufferI = sharedEngine.TrendBuffer;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifecycleEventsRuntime = require('../../dist/engine/o0/lifecycle-events');
const freshLifecycleState: () => LifecycleDeployState = lifecycleEventsRuntime.freshLifecycleState;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const verdictGroupsRuntime = require('../../dist/engine/verdict-groups');
const VerdictGrouperCtor: new () => VerdictGrouperType = verdictGroupsRuntime.VerdictGrouper;

const TREND_WINDOW = 10; // matches the repo-wide `new TrendBuffer(10)` convention

type FamilyKey = 'A' | 'B' | 'C' | 'D' | 'E';
const FAMILY_IDS: FamilyKey[] = ['A', 'B', 'C', 'D', 'E'];

export interface SoakControllerConfig {
  recalServiceDir: string;   // path.join(cfg.baselineHistoryDir, cfg.serviceId)
}

export interface SoakShadowState {       // per enrolled session, in-memory only
  trendBuffer: TrendBufferI;
  lifecycleState: LifecycleDeployState;
  failFastState: FailFastState | undefined;
  verdictGrouper: VerdictGrouperType;
  reversibilityClassification: ReversibilityClassification | undefined;
}

export interface SoakServedOutcome {
  verdict: string; fires: string[]; firingFamilies: string[];
  alphaConsumed: number; errored: boolean;
}
export interface SoakCandidateOutcome {  // built by the runtime from the shadow evaluate()
  verdict: string; fires: string[]; firingFamilies: string[];
  alphaConsumed: number; errored: boolean;
}

interface ActiveSoak {
  manifest: SoakManifest;
  config: CompiledConfig;
  candidateId: string;
  sidecar: SoakSidecar;
}

function freshPerFamily(): Record<FamilyKey, SoakFamilyAttribution> {
  const out = {} as Record<FamilyKey, SoakFamilyAttribution>;
  for (const f of FAMILY_IDS) out[f] = { active_fires: 0, candidate_fires: 0 };
  return out;
}

function bumpFamilies(
  target: Record<FamilyKey, SoakFamilyAttribution>,
  families: string[],
  field: 'active_fires' | 'candidate_fires',
): void {
  for (const fam of families) {
    if (fam in target) target[fam as FamilyKey][field] += 1;
  }
}

/** Write-temp + fs.renameSync — same-directory rename is atomic on POSIX
 *  filesystems, same convention as _recalibrate-store.ts's writeAtomic /
 *  _gate-session-runtime.ts's lock-file writer. */
function writeAtomic(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, contents);
  fs.renameSync(tmpPath, filePath);
}

export class SoakController {
  private active: ActiveSoak | null = null;
  private readonly shadowStates = new Map<string, SoakShadowState>();
  private readonly skippedSessionIds = new Set<string>();
  private lastActiveCandidateId: string | null = null;
  private manifestCheckedOnce = false;
  private lastManifestMtimeMs: number | null = null;
  private lastManifestSize: number | null = null;
  // Review fix 1 (Tasks 1-3 review) — mtime-cache robustness: a pure
  // mtimeMs equality check is defeated by a same-instant rewrite (many
  // filesystems have coarse mtime resolution, and even sub-ms-resolution
  // filesystems can produce two writes landing in the same tick). Track
  // the last-seen manifest's own identity fields so a content-level
  // change is detected even when (mtimeMs, size) both happen to match.
  private lastManifestIdentity: { candidateId: string; status: string; requestedAt: string } | null = null;
  private currentTickNowTs = 0;

  constructor(private readonly cfg: SoakControllerConfig) {
    this.markRestartIfAccumulating();
  }

  /** Restart honesty (plan §2): if a sidecar exists mid-accumulation at
   *  construction time, a process boundary just interrupted it — append
   *  a durable admission. Never throws: an absent/corrupt manifest or
   *  sidecar at construction time is not fatal; refresh() re-derives
   *  inactive state safely on the first tick regardless. */
  private markRestartIfAccumulating(): void {
    try {
      const manifest = this.readManifestSync();
      if (!manifest) return;
      const sidecar = this.readSidecarSync(manifest.candidate_id);
      if (!sidecar || sidecar.status !== 'accumulating') return;
      sidecar.voids.push({ at: new Date().toISOString(), reason: 'service_restart' });
      sidecar.last_updated_at = new Date().toISOString();
      this.writeSidecarSync(manifest.candidate_id, sidecar);
    } catch {
      // never throws
    }
  }

  /** Lazy discovery (plan §2 D1): statSync soak.json, mtime-cached
   *  reload. Absent/stopped manifest, complete sidecar, or any load
   *  error => soak inactive (inactive is always safe). Never throws. */
  refresh(nowTs: number): void {
    this.currentTickNowTs = nowTs;
    try {
      this.reconcileManifest(nowTs);
    } catch {
      this.active = null;
    }
  }

  /** Review fix 1 (Tasks 1-3 review) — (mtimeMs, size) is the fast
   *  pre-filter, but the sole correctness gate is the manifest's own
   *  identity fields (candidate_id, status, requested_at): the manifest
   *  file is tiny, so reading+parsing it every refresh() is cheap, and
   *  doing so unconditionally is what lets a same-instant rewrite (same
   *  mtimeMs AND size — e.g. a `soak stop` immediately followed by a
   *  `soak start` for a same-length candidate id, landing in the same
   *  filesystem mtime tick) still be detected. What the cache actually
   *  guards is the EXPENSIVE step (`activateCandidate`'s candidate-record
   *  + compiled-config load) — that only runs when identity truly
   *  changed. */
  private reconcileManifest(nowTs: number): void {
    let stat: fs.Stats | null;
    try {
      stat = fs.statSync(this.manifestPath());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      stat = null;
    }

    if (!stat) {
      this.manifestCheckedOnce = true;
      this.lastManifestMtimeMs = null;
      this.lastManifestSize = null;
      this.lastManifestIdentity = null;
      this.active = null;
      return;
    }

    const manifest = this.readManifestSync();
    if (!manifest) {
      this.manifestCheckedOnce = true;
      this.lastManifestMtimeMs = stat.mtimeMs;
      this.lastManifestSize = stat.size;
      this.lastManifestIdentity = null;
      this.active = null;
      return;
    }

    const identity = {
      candidateId: manifest.candidate_id, status: manifest.status, requestedAt: manifest.requested_at,
    };
    const unchanged = this.manifestUnchanged(stat, identity);

    this.manifestCheckedOnce = true;
    this.lastManifestMtimeMs = stat.mtimeMs;
    this.lastManifestSize = stat.size;
    this.lastManifestIdentity = identity;

    if (unchanged) return;

    if (manifest.status !== 'requested') { this.active = null; return; }
    this.activateCandidate(manifest, nowTs);
  }

  /** Review fix 1 helper — isolates the multi-field comparison so
   *  `reconcileManifest` itself stays well within the complexity ratchet. */
  private manifestUnchanged(
    stat: fs.Stats,
    identity: { candidateId: string; status: string; requestedAt: string },
  ): boolean {
    if (!this.manifestCheckedOnce || this.lastManifestIdentity === null) return false;
    if (stat.mtimeMs !== this.lastManifestMtimeMs || stat.size !== this.lastManifestSize) return false;
    const prior = this.lastManifestIdentity;
    return identity.candidateId === prior.candidateId
      && identity.status === prior.status
      && identity.requestedAt === prior.requestedAt;
  }

  private activateCandidate(manifest: SoakManifest, nowTs: number): void {
    let config: CompiledConfig;
    try {
      const rec = this.readCandidateRecordSync(manifest.candidate_id);
      config = this.loadConfigSync(rec.compiled_config_path);
    } catch {
      this.active = null;
      return;
    }

    if (manifest.candidate_id !== this.lastActiveCandidateId) {
      // A different candidate than the one we were last actively
      // tracking: enrollment fairness bookkeeping is per-soak, reset it.
      this.shadowStates.clear();
      this.skippedSessionIds.clear();
      this.lastActiveCandidateId = manifest.candidate_id;
    }

    let sidecar = this.readSidecarSync(manifest.candidate_id);
    // RESUME vs RESTART semantics (documented, deliberate): archive-and-
    // restart triggers only on a COMPLETE sidecar. A soak stopped early
    // (sidecar left 'accumulating') that is re-started for the same
    // candidate RESUMES accumulation into the existing sidecar under the
    // ORIGINAL window (a new --target-ticks on the re-start manifest is
    // ignored until the current window completes). The durable fold from
    // the earlier `soak stop` preserved a clean snapshot, so no evidence
    // is lost either way. To force a fresh window instead, complete or
    // archive the sidecar first (start a different candidate, or let the
    // current window run out).
    if (sidecar && sidecar.status === 'complete') {
      if (Date.parse(manifest.requested_at) <= Date.parse(sidecar.started_at)) {
        // Not a re-soak request (this manifest predates or matches the
        // completed sidecar's own start) — stay inactive, same as before
        // review fix 2.
        this.active = null;
        return;
      }
      // Review fix 2 (Tasks 1-3 review) — plan §4 Q4 intent: a manifest
      // requesting a NEWER soak (requested_at strictly after the
      // completed sidecar's started_at) for the SAME candidate id must
      // not be a dead end. Archive the completed sidecar + its
      // ticks.jsonl under a started_at-suffixed filename and start
      // fresh accumulation.
      this.archiveCompletedSidecar(manifest.candidate_id, sidecar);
      sidecar = null;
    }

    const resolvedSidecar = sidecar ?? this.freshSidecar(manifest, nowTs);
    this.active = {
      manifest, config, candidateId: manifest.candidate_id, sidecar: resolvedSidecar,
    };
  }

  /** Review fix 2 helper — renames (never overwrites) the completed
   *  sidecar/ticks-log for `candidateId` to a `<started_at>`-suffixed
   *  path so the fresh re-soak's sidecar can be created at the normal
   *  path without losing the prior soak's evidence. Best-effort: an
   *  archive failure must not block the fresh soak from starting (the
   *  prior sidecar's data already lives in the folded
   *  CandidateRecord.soak snapshot from the CLI's `soak stop`, if that
   *  ran — this is belt-and-suspenders retention on the service side). */
  private archiveCompletedSidecar(candidateId: string, sidecar: SoakSidecar): void {
    const suffix = sidecar.started_at.replace(/[:.]/g, '-');
    const renames: Array<[string, string]> = [
      [this.sidecarPath(candidateId), path.join(this.soakDir(), `${candidateId}.state.${suffix}.json`)],
      [this.ticksPath(candidateId), path.join(this.soakDir(), `${candidateId}.ticks.${suffix}.jsonl`)],
    ];
    for (const [from, to] of renames) {
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        // best-effort archive only
      }
    }
  }

  /** Active-soak check + enrollment. Entry-snapshot tick must be 0 to
   *  enroll; otherwise records the session as skipped (once) and returns
   *  null. Returns the session's shadow state + candidate config when
   *  this tick should be shadow-evaluated. Never throws. */
  shadowStateFor(sessionId: string, entryTick: number): { state: SoakShadowState; config: CompiledConfig } | null {
    try {
      if (!this.active || this.active.sidecar.status === 'complete') return null;
      const existing = this.shadowStates.get(sessionId);
      if (existing) return { state: existing, config: this.active.config };
      if (this.skippedSessionIds.has(sessionId)) return null;
      if (entryTick !== 0) {
        this.recordSkip(sessionId);
        return null;
      }
      return this.enroll(sessionId);
    } catch {
      return null;
    }
  }

  private recordSkip(sessionId: string): void {
    if (!this.active) return;
    this.skippedSessionIds.add(sessionId);
    this.active.sidecar.stats.coverage.sessions_skipped_midstream += 1;
    this.flushSidecar(this.currentTickNowTs);
  }

  private enroll(sessionId: string): { state: SoakShadowState; config: CompiledConfig } | null {
    if (!this.active) return null;
    const state: SoakShadowState = {
      trendBuffer: new TrendBufferCtor(TREND_WINDOW),
      lifecycleState: freshLifecycleState(),
      failFastState: undefined,
      verdictGrouper: new VerdictGrouperCtor(),
      reversibilityClassification: undefined,
    };
    this.shadowStates.set(sessionId, state);
    this.active.sidecar.stats.coverage.sessions_enrolled += 1;
    this.flushSidecar(this.currentTickNowTs);
    return { state, config: this.active.config };
  }

  /** Accumulate one tick pair, append one line to
   *  soak/<id>.ticks.jsonl, flush the sidecar atomically; on reaching
   *  target_ticks: mark complete + append the events.jsonl completion
   *  StoredEvent (single O_APPEND line). Never throws (internal
   *  try/catch; failures counted via the served/candidate errored
   *  flags already threaded in). */
  recordTick(sessionId: string, emittedAtTs: number, served: SoakServedOutcome, candidate: SoakCandidateOutcome): void {
    try {
      if (!this.active || this.active.sidecar.status === 'complete') return;
      if (!this.shadowStates.has(sessionId)) return;

      this.accumulate(served, candidate, emittedAtTs);
      this.appendTickLine(sessionId, emittedAtTs, served, candidate);

      const stats = this.active.sidecar.stats;
      const completedNow = stats.ticks_observed >= this.active.sidecar.window.target_ticks;
      if (completedNow) {
        this.active.sidecar.status = 'complete';
        this.active.sidecar.completed_at = new Date(emittedAtTs * 1000).toISOString();
      }
      this.flushSidecar(emittedAtTs);
      if (completedNow) this.appendCompletionEvent(emittedAtTs);
    } catch {
      // never throws
    }
  }

  private accumulate(served: SoakServedOutcome, candidate: SoakCandidateOutcome, emittedAtTs: number): void {
    if (!this.active) return;
    const stats = this.active.sidecar.stats;
    stats.ticks_observed += 1;
    stats.coverage.first_tick_ts = stats.coverage.first_tick_ts ?? emittedAtTs;
    stats.coverage.last_tick_ts = emittedAtTs;
    if (served.errored) stats.coverage.active_errored_ticks += 1;
    if (candidate.errored) stats.coverage.candidate_errored_ticks += 1;
    if (served.errored || candidate.errored) return;

    const d = stats.disagreement;
    d.total_compared += 1;
    if (served.verdict !== candidate.verdict) {
      d.verdict_disagreements += 1;
      const pairKey = `${served.verdict}->${candidate.verdict}`;
      d.by_pair[pairKey] = (d.by_pair[pairKey] ?? 0) + 1;
    }
    const activeRollback = served.verdict === 'rollback';
    const candidateRollback = candidate.verdict === 'rollback';
    if (activeRollback && candidateRollback) d.would_be_rollback.both += 1;
    else if (activeRollback) d.would_be_rollback.active_only += 1;
    else if (candidateRollback) d.would_be_rollback.candidate_only += 1;

    bumpFamilies(stats.per_family, served.firingFamilies, 'active_fires');
    bumpFamilies(stats.per_family, candidate.firingFamilies, 'candidate_fires');
    stats.alpha_spent.active_total += served.alphaConsumed;
    stats.alpha_spent.candidate_total += candidate.alphaConsumed;
  }

  private appendTickLine(sessionId: string, emittedAtTs: number, served: SoakServedOutcome, candidate: SoakCandidateOutcome): void {
    if (!this.active) return;
    const line = {
      session_id: sessionId,
      emitted_at_ts: emittedAtTs,
      active: {
        verdict: served.verdict, fires: served.fires, firing_families: served.firingFamilies, alpha: served.alphaConsumed,
      },
      candidate: {
        verdict: candidate.verdict, fires: candidate.fires, firing_families: candidate.firingFamilies, alpha: candidate.alphaConsumed,
      },
      at: new Date(emittedAtTs * 1000).toISOString(),
    };
    fs.mkdirSync(this.soakDir(), { recursive: true });
    fs.appendFileSync(this.ticksPath(this.active.candidateId), `${JSON.stringify(line)}\n`);
  }

  private flushSidecar(nowTs: number): void {
    if (!this.active) return;
    this.active.sidecar.last_updated_at = new Date(nowTs * 1000).toISOString();
    this.writeSidecarSync(this.active.candidateId, this.active.sidecar);
  }

  /** Completion event payload (compact, < 1 KB) — the calendar_due /
   *  rolled_back pattern (untyped StoredEvent; the six-member typed
   *  recalibration.* union stays closed per plan §2 "Completion"). */
  private appendCompletionEvent(emittedAtTs: number): void {
    if (!this.active) return;
    const stats = this.active.sidecar.stats;
    const payload = {
      service_id: path.basename(this.cfg.recalServiceDir),
      candidate_id: this.active.candidateId,
      window: this.active.manifest.window,
      ticks_observed: stats.ticks_observed,
      verdict_disagreements: stats.disagreement.verdict_disagreements,
      would_be_rollback: stats.disagreement.would_be_rollback,
      sessions_enrolled: stats.coverage.sessions_enrolled,
      voids: this.active.sidecar.voids,
      sidecar_path: this.sidecarPath(this.active.candidateId),
    };
    const event = {
      type: 'recalibration.soak_completed', payload, at: new Date(emittedAtTs * 1000).toISOString(),
    };
    // Sole multi-writer file (plan §1) — one O_APPEND line, atomic for
    // local-filesystem writes well under the page/PIPE_BUF limit.
    fs.appendFileSync(this.eventsPath(), `${JSON.stringify(event)}\n`);
  }

  /** Session finished/voided/TTL-expired: drop its in-memory shadow
   *  state. Memory hygiene only; correctness doesn't depend on it. */
  dropSession(sessionId: string): void {
    this.shadowStates.delete(sessionId);
    this.skippedSessionIds.delete(sessionId);
  }

  // ── file paths ────────────────────────────────────────────────────

  private manifestPath(): string { return path.join(this.cfg.recalServiceDir, 'soak.json'); }

  private soakDir(): string { return path.join(this.cfg.recalServiceDir, 'soak'); }

  private sidecarPath(candidateId: string): string { return path.join(this.soakDir(), `${candidateId}.state.json`); }

  private ticksPath(candidateId: string): string { return path.join(this.soakDir(), `${candidateId}.ticks.jsonl`); }

  private candidatePath(candidateId: string): string {
    return path.join(this.cfg.recalServiceDir, 'candidates', `${candidateId}.json`);
  }

  private eventsPath(): string { return path.join(this.cfg.recalServiceDir, 'events.jsonl'); }

  // ── file I/O (read-only side of the shared soak-manifest/sidecar
  // contract; CLI-side read/write lives in
  // tools/recalibrate/_recalibrate-soak.ts, precedent:
  // service/session/active-calibration.ts) ────────────────────────────

  private readManifestSync(): SoakManifest | null {
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath(), 'utf8')) as SoakManifest;
    } catch {
      return null;
    }
  }

  private readSidecarSync(candidateId: string): SoakSidecar | null {
    try {
      return JSON.parse(fs.readFileSync(this.sidecarPath(candidateId), 'utf8')) as SoakSidecar;
    } catch {
      return null;
    }
  }

  private writeSidecarSync(candidateId: string, sidecar: SoakSidecar): void {
    fs.mkdirSync(this.soakDir(), { recursive: true });
    writeAtomic(this.sidecarPath(candidateId), `${JSON.stringify(sidecar, null, 2)}\n`);
  }

  private readCandidateRecordSync(candidateId: string): CandidateRecord {
    const raw = fs.readFileSync(this.candidatePath(candidateId), 'utf8');
    return JSON.parse(raw) as CandidateRecord;
  }

  private loadConfigSync(configPath: string): CompiledConfig {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as CompiledConfig;
  }

  private freshSidecar(manifest: SoakManifest, nowTs: number): SoakSidecar {
    const nowIso = new Date(nowTs * 1000).toISOString();
    return {
      schema_version: '1',
      candidate_id: manifest.candidate_id,
      window: manifest.window,
      started_at: nowIso,
      last_updated_at: nowIso,
      status: 'accumulating',
      completed_at: null,
      stats: {
        ticks_observed: 0,
        disagreement: {
          total_compared: 0,
          verdict_disagreements: 0,
          by_pair: {},
          would_be_rollback: { active_only: 0, candidate_only: 0, both: 0 },
        },
        per_family: freshPerFamily(),
        alpha_spent: { active_total: 0, candidate_total: 0 },
        coverage: {
          sessions_enrolled: 0,
          sessions_skipped_midstream: 0,
          first_tick_ts: null,
          last_tick_ts: null,
          active_errored_ticks: 0,
          candidate_errored_ticks: 0,
        },
      },
      voids: [],
    };
  }
}
