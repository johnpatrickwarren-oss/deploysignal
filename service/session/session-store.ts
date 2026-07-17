// service/session/session-store.ts — Task 3 (WS4 session-durability-argo
// plan): file-backed SessionStore.
//
// Layout (`<rootDir>/<service_id>/`, schema_version '1' in every file —
// mirrors Addition #15 §B conventions):
//   store-meta.json                {schema_version, service_id, created_at}
//   index.json                     {schema_version, by_deploy_ref}
//   sessions/<session_id>.json     SessionRecord (atomic tmp+renameSync)
//   sessions/<id>.verdicts.jsonl   one VerdictHistoryEntry per line (append-only)
//
// Idempotency (hasTick/getStoredTickResponse) is derived from the durable
// verdicts.jsonl rather than a separate idempotency file that could drift
// from the source of truth: a per-session Set<number> of emitted_at_ts is
// hydrated from disk on first access per SessionStore instance, so a
// freshly re-opened store (new process, or just `new SessionStore` over
// the same dir) reflects exactly what's durable — proven in
// test/session-store.test.ts by re-opening the store from disk.
//
// All record writes are atomic: write a `.tmp-*` sibling then
// fs.renameSync over the destination (Addition #15 D3 pattern).
// appendVerdict is fail-loud (throws) — unlike Task 1's best-effort audit
// writer, a lost verdict is a lost idempotency record, not best-effort
// telemetry.
//
// service/ depends on engine/, never the other way (mirrors advisory/'s
// doctrine, engine/types/orchestration.ts:186-188).
//
// SINGLE-WRITER ASSUMPTION (Tasks 3-5 review, folded into Task 6): index.json
// is read-modify-write (readIndex() then atomicWriteJson()) — safe only
// under a single writer per <rootDir>/<service_id> store root. Concurrent
// SessionStore instances (e.g. two GateSessionRuntime processes pointed at
// the same store dir) can race and drop an index update; this is a
// single-writer guard, not a distributed lock. Task 6's GateSessionRuntime
// enforces the single-writer invariant at the store-root level via a pid
// lockfile (`<storeDir>/.gate-runtime.lock`, acquired in the runtime's
// constructor, released on close()) — SessionStore itself performs no
// locking. Do not point two live GateSessionRuntime instances at the same
// storeDir; the lockfile makes that a loud startup error instead of a
// silent index race.

import * as fs from 'fs';
import * as path from 'path';

import type { DeploymentPhase, StateGateContext } from '../../engine/types/session';

import {
  SessionStoreSchemaError,
} from './types';
import type {
  BeginSessionInput,
  SessionDeployment,
  SessionIndex,
  SessionRecord,
  StoreMeta,
  VerdictHistoryEntry,
} from './types';

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Reads + parses a schema_version-tagged JSON file. Returns null when
 *  the file doesn't exist. Throws SessionStoreSchemaError on invalid
 *  JSON or an unexpected schema_version — every other read failure
 *  (permissions, etc.) propagates as-is (fail-loud, no swallowing). */
function readJsonOrNull<T extends { schema_version: string }>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch (e) {
    throw new SessionStoreSchemaError(filePath, `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed.schema_version !== '1') {
    throw new SessionStoreSchemaError(filePath, parsed.schema_version);
  }
  return parsed;
}

export class SessionStore {
  private readonly serviceDir: string;
  private readonly sessionsDir: string;
  // Per-instance hydration cache: Set<emitted_at_ts> per session_id.
  // Deliberately instance-scoped (not module/global) so a fresh
  // SessionStore over the same rootDir proves durability rather than
  // reading a stale in-memory shortcut.
  private readonly tickCache = new Map<string, Set<number>>();

  private constructor(rootDir: string, private readonly serviceId: string) {
    this.serviceDir = path.join(rootDir, serviceId);
    this.sessionsDir = path.join(this.serviceDir, 'sessions');
  }

  static init(rootDir: string, serviceId: string): SessionStore {
    const store = new SessionStore(rootDir, serviceId);
    fs.mkdirSync(store.sessionsDir, { recursive: true });

    const meta = readJsonOrNull<StoreMeta>(store.metaPath());
    if (!meta) {
      const fresh: StoreMeta = { schema_version: '1', service_id: serviceId, created_at: new Date().toISOString() };
      atomicWriteJson(store.metaPath(), fresh);
    }

    const index = readJsonOrNull<SessionIndex>(store.indexPath());
    if (!index) {
      const fresh: SessionIndex = { schema_version: '1', by_deploy_ref: {} };
      atomicWriteJson(store.indexPath(), fresh);
    }

    return store;
  }

  private metaPath(): string {
    return path.join(this.serviceDir, 'store-meta.json');
  }

  private indexPath(): string {
    return path.join(this.serviceDir, 'index.json');
  }

  private sessionPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`);
  }

  private verdictsPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.verdicts.jsonl`);
  }

  private readIndex(): SessionIndex {
    return readJsonOrNull<SessionIndex>(this.indexPath()) ?? { schema_version: '1', by_deploy_ref: {} };
  }

  private writeIndex(mutate: (idx: SessionIndex) => void): void {
    const idx = this.readIndex();
    mutate(idx);
    atomicWriteJson(this.indexPath(), idx);
  }

  private writeSessionRecord(rec: SessionRecord): void {
    atomicWriteJson(this.sessionPath(rec.session_id), rec);
  }

  private requireSession(sessionId: string): SessionRecord {
    const rec = this.getSession(sessionId);
    if (!rec) throw new Error(`session-store: unknown session_id: ${sessionId}`);
    return rec;
  }

  beginSession(rec: BeginSessionInput): SessionRecord {
    const full: SessionRecord = {
      ...rec,
      schema_version: '1',
      status: 'active',
      tick: 0,
      ended_at: null,
      void_reason: null,
      last_tick_at: null,
      last_verdict: null,
    };
    this.writeSessionRecord(full);
    this.writeIndex((idx) => {
      idx.by_deploy_ref[full.deploy_ref] = full.session_id;
    });
    return full;
  }

  getSession(sessionId: string): SessionRecord | null {
    return readJsonOrNull<SessionRecord>(this.sessionPath(sessionId));
  }

  getSessionByDeployRef(deployRef: string): SessionRecord | null {
    const id = this.readIndex().by_deploy_ref[deployRef];
    if (!id) return null;
    return this.getSession(id);
  }

  updateSession(sessionId: string, patch: Partial<SessionRecord>): SessionRecord {
    const current = this.requireSession(sessionId);
    const next: SessionRecord = {
      ...current,
      ...patch,
      schema_version: '1',
      session_id: current.session_id,
    };
    this.writeSessionRecord(next);
    return next;
  }

  appendVerdict(entry: VerdictHistoryEntry): void {
    // Fail-loud: unlike Task 1's best-effort audit writer, a lost
    // verdict record is a lost idempotency proof — the caller must see
    // the throw rather than silently proceeding as if the tick were
    // durable.
    fs.appendFileSync(this.verdictsPath(entry.session_id), `${JSON.stringify(entry)}\n`, 'utf8');
    const cached = this.tickCache.get(entry.session_id);
    if (cached) cached.add(entry.emitted_at_ts);
  }

  readVerdictHistory(sessionId: string): VerdictHistoryEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.verdictsPath(sessionId), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as VerdictHistoryEntry);
  }

  private hydrateTickSet(sessionId: string): Set<number> {
    let set = this.tickCache.get(sessionId);
    if (!set) {
      set = new Set(this.readVerdictHistory(sessionId).map((e) => e.emitted_at_ts));
      this.tickCache.set(sessionId, set);
    }
    return set;
  }

  hasTick(sessionId: string, emittedAtTs: number): boolean {
    return this.hydrateTickSet(sessionId).has(emittedAtTs);
  }

  getStoredTickResponse(sessionId: string, emittedAtTs: number): VerdictHistoryEntry | null {
    const entries = this.readVerdictHistory(sessionId);
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].emitted_at_ts === emittedAtTs) return entries[i];
    }
    return null;
  }

  /** Durable counterpart to engine/gates/state.ts's in-memory
   *  recordDeployment — merges into the session's `deployment` block. */
  recordDeployment(sessionId: string, rec: Partial<SessionDeployment>): void {
    const current = this.requireSession(sessionId);
    this.updateSession(sessionId, { deployment: { ...current.deployment, ...rec } });
  }

  updatePhase(sessionId: string, phase: DeploymentPhase): void {
    this.recordDeployment(sessionId, { phase });
  }

  finishSession(sessionId: string, _reason?: string): SessionRecord {
    const current = this.requireSession(sessionId);
    if (current.status === 'finished') return current;
    return this.updateSession(sessionId, { status: 'finished', ended_at: new Date().toISOString() });
  }

  voidSession(sessionId: string, reason: string): SessionRecord {
    return this.updateSession(sessionId, {
      status: 'void', void_reason: reason, ended_at: new Date().toISOString(),
    });
  }

  /** Restart sweep (OQ-1 declare-void-and-restart): voids every
   *  currently-active session, leaving finished/already-void sessions
   *  untouched. */
  voidAllActive(reason: string): SessionRecord[] {
    return this.listActive().map((rec) => this.voidSession(rec.session_id, reason));
  }

  /** Task 6 — every session currently `status: 'active'`. Used by
   *  GateSessionRuntime.sweepExpired() to find TTL-expiring sessions
   *  without a second index file to keep in sync. */
  listActive(): SessionRecord[] {
    const out: SessionRecord[] = [];
    for (const id of this.listSessionIds()) {
      const rec = this.getSession(id);
      if (rec && rec.status === 'active') out.push(rec);
    }
    return out;
  }

  private listSessionIds(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.sessionsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length));
  }

  /** Builds the pure StateGateContext (engine/types/session.ts) the G3
   *  gate consumes — feeds evaluateState() per tick (Task 2). */
  stateGateContext(sessionId: string): StateGateContext {
    const rec = this.requireSession(sessionId);
    return {
      session_status: rec.status,
      void_reason: rec.void_reason,
      deployment_phase: rec.deployment.phase,
    };
  }
}
