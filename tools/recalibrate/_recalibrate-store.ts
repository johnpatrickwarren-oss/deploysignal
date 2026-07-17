// tools/recalibrate/_recalibrate-store.ts — Addition #15 baseline-
// maintenance lifecycle, Task 6. File-based candidate store + atomic
// active.json swap.
//
// D6 (engine/tools split, plan §B/§C): all fs I/O for the recalibration
// lifecycle lives here — engine/recalibration/* stays pure. Store layout
// (plan §B), one directory per service under a caller-supplied root
// (production root: `runs/baseline-history/<service_id>/`; tests use
// fs.mkdtempSync roots per the q60 test pattern):
//
//   store-meta.json          {schema_version, service_id, timeout_days,
//                             informational_direction_overrides,
//                             unchanged_epsilon_rel}
//   candidates/<id>.json     CandidateRecord (engine/types/recalibration.ts)
//   active.json              ActivePointer (below) — the only file
//                             `promote`/`rollbackTo` swap via write-temp +
//                             fs.renameSync (D3: atomic single-rename).
//   events.jsonl             one event-envelope per line — the store's
//                             authoritative decision log (plan §B).
//   exclusion-windows.json   {schema_version, windows: ExclusionWindow[]}
//                             — absent file reads as [] (no exclusions
//                             declared yet is the common case).
//
// Convergence note (plan §B): the WS4 branch ships its own generic
// JsonlLifecycleEventEmitter under service/session/ for the session
// lifecycle, on a different branch. This emitter is deliberately
// recalibrate-scoped — it only knows how to append to a
// RecalibrationStore's events.jsonl — and is NOT that shared module. If
// WS4 lands first, a follow-up can fold this into the generic emitter;
// until then the two stay independent to avoid a cross-branch merge
// dependency.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  CandidateRecord, RecalibrationOutcome,
} from '../../engine/types/recalibration';
import { transition } from '../../engine/recalibration/state-machine';
import { DEFAULT_UNCHANGED_EPSILON } from '../../engine/recalibration/classify';
import type {
  LifecycleEventEmitter, LifecycleEventType, LifecycleEventPayload,
} from '../../engine/o0/lifecycle-events';

/** Store-level default — DEFAULT candidate review timeout, in days,
 *  applied by `init` when the caller doesn't pass `timeoutDays`. Mirrors
 *  engine/recalibration/timeout.ts's DEFAULT_TIMEOUT_DAYS (plan §C
 *  Task 7) but is intentionally NOT imported from there: Task 6 lands
 *  before Task 7 in commit order, and store-meta's `timeout_days` is a
 *  persisted per-service override anyway (init-overridable, OQ-3's
 *  sibling knob) rather than a live reference to the engine constant.
 *  Both default to the same value (14); kept in sync by test coverage in
 *  both modules. */
const DEFAULT_STORE_TIMEOUT_DAYS = 14;

export interface StoreMeta {
  schema_version: '1';
  service_id: string;
  timeout_days: number;
  informational_direction_overrides: Record<string, 'higher' | 'lower'>;
  unchanged_epsilon_rel: number;
}

export interface PromotionEntry {
  version_id: string;
  candidate_id: string | null;
  compiled_config_path: string;
  baseline_ref: string;
  promoted_at: string;
  predecessor_version_id: string | null;
  outcome: RecalibrationOutcome | 'rollback';
  actor?: string;
  reason_code?: string;
}

/** The active-baseline pointer (plan §B `active.json`). `candidate_id`
 *  is additive vs. the plan's illustrative field list — needed so
 *  `promote` can find and supersede the previously-active candidate's
 *  own record; `null` only for a bootstrapped active with no candidate
 *  provenance (e.g. seeded directly from a `calibrate.ts` output rather
 *  than through the recalibration flow). */
export interface ActivePointer {
  schema_version: '1';
  version_id: string;
  candidate_id: string | null;
  compiled_config_path: string;
  baseline_ref: string;
  promoted_at: string;
  predecessor_version_id: string | null;
  promotion_history: PromotionEntry[];
}

export interface ExclusionWindow {
  start: string;
  end: string;
  reason?: string;
  declared_by?: string;
}

/** Generic append-only event envelope persisted to events.jsonl. Broader
 *  than `LifecycleEventType`/`LifecycleEventPayload` (whose `emit`
 *  JsonlLifecycleEventEmitter wraps) — `rollbackTo` also appends
 *  store-domain-only envelopes (e.g. 'recalibration.rolled_back') that
 *  aren't part of the engine's strict six-member recalibration.* union
 *  (Task 5 locked that set; a rollback isn't a candidate lifecycle
 *  transition, it's a store-level pointer operation). */
export interface StoredEvent {
  type: string;
  payload: unknown;
  at: string;
}

export interface InitOptions {
  timeoutDays?: number;
  unchangedEpsilonRel?: number;
  informationalDirectionOverrides?: Record<string, 'higher' | 'lower'>;
}

export interface PromoteOptions {
  actor?: string;
  reasonCode?: string;
}

/** Thrown when a store file's `schema_version` doesn't match the one
 *  version this store implementation understands ('1'). Distinguishes
 *  "file is from an incompatible future/foreign schema" from ordinary
 *  parse/not-found errors. */
export class RecalibrationStoreSchemaError extends Error {
  readonly filePath: string;
  readonly foundVersion: unknown;

  constructor(filePath: string, foundVersion: unknown) {
    super(`unsupported schema_version '${String(foundVersion)}' in ${filePath} (expected '1')`);
    this.name = 'RecalibrationStoreSchemaError';
    this.filePath = filePath;
    this.foundVersion = foundVersion;
  }
}

function assertSchemaV1(filePath: string, value: { schema_version?: unknown }): void {
  if (value.schema_version !== '1') {
    throw new RecalibrationStoreSchemaError(filePath, value.schema_version);
  }
}

/** Write-temp + fs.renameSync — same-directory rename is atomic on
 *  POSIX filesystems (D3: atomic single-rename swap). */
function writeAtomic(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, contents);
  fs.renameSync(tmpPath, filePath);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

/** File-based candidate store for one service's baseline-maintenance
 *  lifecycle (plan §B store layout). Pure I/O layer — no classification/
 *  gate/state-machine math lives here; this module calls into
 *  engine/recalibration/state-machine.ts's `transition` only for the
 *  narrow "mark the prior active candidate superseded" step inside
 *  `promote`. */
export class RecalibrationStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Create a fresh store under `root/<serviceId>/` — store-meta.json +
   *  an empty candidates/ dir. Does not create active.json (a fresh
   *  service has no active baseline pointer yet; `readActive` returns
   *  `null` until the first `promote`) nor exclusion-windows.json
   *  (absent reads as `[]`). */
  static init(root: string, serviceId: string, opts: InitOptions = {}): RecalibrationStore {
    const dir = path.join(root, serviceId);
    fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true });
    const meta: StoreMeta = {
      schema_version: '1',
      service_id: serviceId,
      timeout_days: opts.timeoutDays ?? DEFAULT_STORE_TIMEOUT_DAYS,
      unchanged_epsilon_rel: opts.unchangedEpsilonRel ?? DEFAULT_UNCHANGED_EPSILON,
      informational_direction_overrides: opts.informationalDirectionOverrides ?? {},
    };
    writeAtomic(path.join(dir, 'store-meta.json'), JSON.stringify(meta, null, 2) + '\n');
    return new RecalibrationStore(dir);
  }

  private metaPath(): string { return path.join(this.dir, 'store-meta.json'); }

  private activePath(): string { return path.join(this.dir, 'active.json'); }

  private eventsPath(): string { return path.join(this.dir, 'events.jsonl'); }

  private exclusionsPath(): string { return path.join(this.dir, 'exclusion-windows.json'); }

  private candidatePath(candidateId: string): string {
    return path.join(this.dir, 'candidates', `${candidateId}.json`);
  }

  readMeta(): StoreMeta {
    const filePath = this.metaPath();
    const meta = readJson<StoreMeta>(filePath);
    assertSchemaV1(filePath, meta);
    return meta;
  }

  readActive(): ActivePointer | null {
    const filePath = this.activePath();
    if (!fs.existsSync(filePath)) return null;
    const active = readJson<ActivePointer>(filePath);
    assertSchemaV1(filePath, active);
    return active;
  }

  listCandidates(): CandidateRecord[] {
    const candidatesDir = path.join(this.dir, 'candidates');
    if (!fs.existsSync(candidatesDir)) return [];
    return fs.readdirSync(candidatesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .map((id) => this.readCandidate(id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  readCandidate(candidateId: string): CandidateRecord {
    const filePath = this.candidatePath(candidateId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`RecalibrationStore: no such candidate '${candidateId}' (${filePath})`);
    }
    const rec = readJson<CandidateRecord>(filePath);
    assertSchemaV1(filePath, rec);
    return rec;
  }

  writeCandidate(rec: CandidateRecord): void {
    writeAtomic(this.candidatePath(rec.candidate_id), JSON.stringify(rec, null, 2) + '\n');
  }

  /** Atomically swap active.json to point at `candidateId`'s proposed
   *  baseline, and mark the previously-active candidate (if any)
   *  'superseded'. Assumes `candidateId`'s own record has already been
   *  transitioned to status 'active' and written (Task 8's approve/
   *  auto_promote CLI handlers call `transition` + `writeCandidate`
   *  before calling `promote`) — this method's job is purely the
   *  pointer swap + supersession side effect, not the candidate's own
   *  terminal-state transition. */
  promote(candidateId: string, outcome: RecalibrationOutcome, now: string, opts: PromoteOptions = {}): ActivePointer {
    const candidate = this.readCandidate(candidateId);
    const priorActive = this.readActive();

    if (priorActive && priorActive.candidate_id) {
      let priorCandidate: CandidateRecord | null = null;
      try {
        priorCandidate = this.readCandidate(priorActive.candidate_id);
      } catch (_err) {
        priorCandidate = null; // bootstrapped pointer with no candidate file — nothing to supersede
      }
      if (priorCandidate && priorCandidate.status === 'active') {
        const superseded = transition(priorCandidate, {
          kind: 'superseded_by', at: now, actor: 'system', superseded_by_candidate_id: candidateId,
        });
        this.writeCandidate(superseded);
      }
    }

    const entry: PromotionEntry = {
      version_id: candidate.proposed_baseline_version,
      candidate_id: candidateId,
      compiled_config_path: candidate.compiled_config_path,
      baseline_ref: candidate.proposed_baseline_version,
      promoted_at: now,
      predecessor_version_id: priorActive?.version_id ?? null,
      outcome,
      actor: opts.actor,
      reason_code: opts.reasonCode,
    };

    const newActive: ActivePointer = {
      schema_version: '1',
      version_id: candidate.proposed_baseline_version,
      candidate_id: candidateId,
      compiled_config_path: candidate.compiled_config_path,
      baseline_ref: candidate.proposed_baseline_version,
      promoted_at: now,
      predecessor_version_id: priorActive?.version_id ?? null,
      promotion_history: [...(priorActive?.promotion_history ?? []), entry],
    };

    writeAtomic(this.activePath(), JSON.stringify(newActive, null, 2) + '\n');
    return newActive;
  }

  /** Restore a previously-active version as the active pointer.
   *  `versionId` must appear in the current active pointer's
   *  `promotion_history` (i.e. it was active at some earlier point) —
   *  the historical entry supplies the compiled-config path to restore.
   *  Does NOT attempt to un-supersede the corresponding candidate record
   *  (the state machine defines no legal transition out of
   *  'superseded' — out of scope, plan §C Task 6); rollback is purely an
   *  active.json pointer operation, append-only in `promotion_history`,
   *  plus a 'recalibration.rolled_back' store event. */
  rollbackTo(versionId: string, actor: string, reasonCode: string, now: string): ActivePointer {
    const active = this.readActive();
    if (!active) {
      throw new Error('RecalibrationStore.rollbackTo: no active pointer to roll back from');
    }
    const target = active.promotion_history.find((e) => e.version_id === versionId);
    if (!target) {
      throw new Error(
        `RecalibrationStore.rollbackTo: version '${versionId}' not found in promotion_history`,
      );
    }

    const entry: PromotionEntry = {
      version_id: target.version_id,
      candidate_id: target.candidate_id,
      compiled_config_path: target.compiled_config_path,
      baseline_ref: target.baseline_ref,
      promoted_at: now,
      predecessor_version_id: active.version_id,
      outcome: 'rollback',
      actor,
      reason_code: reasonCode,
    };

    const newActive: ActivePointer = {
      schema_version: '1',
      version_id: target.version_id,
      candidate_id: target.candidate_id,
      compiled_config_path: target.compiled_config_path,
      baseline_ref: target.baseline_ref,
      promoted_at: now,
      predecessor_version_id: active.version_id,
      promotion_history: [...active.promotion_history, entry],
    };

    writeAtomic(this.activePath(), JSON.stringify(newActive, null, 2) + '\n');
    this.appendEvent({
      type: 'recalibration.rolled_back',
      payload: {
        service_id: this.readMeta().service_id,
        rolled_back_to: versionId,
        rolled_back_from: active.version_id,
        actor,
        reason_code: reasonCode,
      },
      at: now,
    });
    return newActive;
  }

  readExclusionWindows(): ExclusionWindow[] {
    const filePath = this.exclusionsPath();
    if (!fs.existsSync(filePath)) return [];
    const parsed = readJson<{ schema_version: string; windows: ExclusionWindow[] }>(filePath);
    assertSchemaV1(filePath, parsed);
    return parsed.windows;
  }

  appendEvent(event: StoredEvent): void {
    fs.appendFileSync(this.eventsPath(), JSON.stringify(event) + '\n');
  }

  readEvents(): StoredEvent[] {
    const filePath = this.eventsPath();
    if (!fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, 'utf8');
    return text.split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as StoredEvent);
  }
}

/** Recalibrate-scoped LifecycleEventEmitter that persists every emitted
 *  event to a RecalibrationStore's events.jsonl (the store's
 *  authoritative decision log, plan §B). See this module's header for
 *  the WS4 convergence note — this is deliberately NOT the generic
 *  session-lifecycle emitter WS4 ships on a different branch. */
export class JsonlLifecycleEventEmitter implements LifecycleEventEmitter {
  constructor(private readonly store: RecalibrationStore) {}

  /** Fix 3 (Tasks 6-8 review) — the envelope's `at` must align with the
   *  payload's own `at` (every LifecycleEventPayload variant carries
   *  one, itself threaded from the caller's deterministic `nowIso` —
   *  see e.g. _recalibrate-cli.ts's `nowOrDefault`), not a fresh
   *  `new Date()` wall-clock read at emit time. Falls back to wall
   *  clock only when the payload has no usable `at` (defensive; every
   *  current payload variant requires one). */
  async emit(event_type: LifecycleEventType, payload: LifecycleEventPayload): Promise<void> {
    const payloadAt = (payload as { at?: unknown }).at;
    this.store.appendEvent({
      type: event_type,
      payload,
      at: typeof payloadAt === 'string' ? payloadAt : new Date().toISOString(),
    });
  }
}
