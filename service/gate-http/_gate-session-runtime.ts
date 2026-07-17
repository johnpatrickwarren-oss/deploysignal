// service/gate-http/_gate-session-runtime.ts — Task 6 (WS4
// session-durability-argo plan): GateSessionRuntime. Pure orchestration
// over Tasks 2-5 (SessionStore, JsonlLifecycleEventEmitter,
// resolveActiveCalibration, G3 StateGateContext wiring) — no http here
// (Task 7 owns the HTTP surface, `service/gate-http/server.ts` +
// handlers).
//
// Per-session accumulator state (TrendBuffer, lifecycleState,
// failFastState, VerdictGrouper, reversibilityClassification, the pinned
// CompiledConfig) lives in an in-memory Map keyed by session_id — this is
// exactly the caller-threaded e-process/supermartingale state the plan's
// investigation finding #4 documents (cusum/betting/MMD/etc. wealth maps
// mutated in place per tick; each observation must be bet on exactly
// once). That map dies with the process. OQ-1's shipped default is
// declare-void-and-restart, NOT snapshot-resume: `sweepOnBoot()` voids
// every session this store still has marked `active` (durable in the
// SessionRecord itself, `void_reason: 'service_restart'`), and G3
// (`engine/gates/state.ts` via `SessionStore.stateGateContext`) denies any
// further tick for a voided session — the tick idempotency keys + durable
// per-tick verdict history built in Task 3 are the prerequisite for a
// FUTURE snapshot-resume; this task does not build resume itself
// (plan OQ-1, verbatim).
//
// Single-writer store-root lockfile (Tasks 3-5 review "Important
// finding", folded into this task): SessionStore's index.json is
// read-modify-write, safe only under one writer. This constructor
// acquires `<storeDir>/.gate-runtime.lock` (pid written; a live holder
// pid throws GateRuntimeLockError, a dead holder pid is reclaimed via
// `process.kill(pid, 0)` liveness probing) and `close()` releases it.
// This is a single-process guard, not a distributed lock — see
// service/session/session-store.ts's header for the store-side half of
// this doctrine.

import * as fs from 'fs';
import * as path from 'path';

import type {
  OrchestrateParams, VerdictResult, Metrics, Flags,
  RiskLevel, Author, ChangeType, TimeWindow, CompiledConfig,
  TrendBufferI, FailFastState, ReversibilityClassification, AuditWriter,
} from '../../engine/types';
import type { LifecycleEventEmitter, LifecycleDeployState } from '../../engine/o0/lifecycle-events';
import type { VerdictGrouper as VerdictGrouperType } from '../../engine/verdict-groups';

import { SessionStore } from '../session/session-store';
import type { SessionRecord, VerdictHistoryEntry, BeginSessionInput } from '../session/types';
import type { SessionStatus, DeploymentPhase } from '../session/types';
import { resolveActiveCalibration } from '../session/active-calibration';
import type { ActiveCalibration } from '../session/active-calibration';

// Runtime VALUES from the built engine. `service/` is compiled by
// tsconfig.test.json (rootDir "."), which does not build `engine/`
// itself (engine has its own tsconfig.json -> dist/engine) — production
// code here follows the same require()-the-build-artifact convention
// already established by tools/*.ts (e.g. tools/benchmark-tick-latency.ts
// `require('../shared')`) and every test/*.test.ts file that needs real
// engine values rather than just types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharedEngine = require('../../shared');
const orchestrate: (params: OrchestrateParams) => VerdictResult = sharedEngine.orchestrate;
const TrendBufferCtor: new (window?: number) => TrendBufferI = sharedEngine.TrendBuffer;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifecycleEventsRuntime = require('../../dist/engine/o0/lifecycle-events');
const freshLifecycleState: () => LifecycleDeployState = lifecycleEventsRuntime.freshLifecycleState;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const verdictGroupsRuntime = require('../../dist/engine/verdict-groups');
const VerdictGrouperCtor: new () => VerdictGrouperType = verdictGroupsRuntime.VerdictGrouper;

const TREND_WINDOW = 10; // matches the repo-wide `new TrendBuffer(10)` convention (test/*, tools/*)

/** OQ-3: G3 deny verdict stays 'extend' — no engine short-circuit
 *  semantics change. Anything outside {proceed, rollback, extend} (there
 *  is no such engine verdict today, but this is the conservative
 *  fallback the plan calls for) maps to -1 (Inconclusive), never to a
 *  permissive 0. */
export const VERDICT_CODE: Record<string, number> = { proceed: 0, rollback: 1, extend: -1 };
function codeFor(verdict: string): number {
  return Object.prototype.hasOwnProperty.call(VERDICT_CODE, verdict) ? VERDICT_CODE[verdict] : -1;
}

export class GateSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`gate-session-runtime: unknown session_id: ${sessionId}`);
    this.name = 'GateSessionNotFoundError';
  }
}

export class GateRuntimeLockError extends Error {
  constructor(lockPath: string, holderPid: number) {
    super(`gate-session-runtime: store dir already locked by live pid ${holderPid} (${lockPath})`);
    this.name = 'GateRuntimeLockError';
  }
}

export interface GateRuntimeConfig {
  storeDir: string;
  baselineHistoryDir: string;
  serviceId: string;
  mode: 'enforce' | 'shadow';
  failPolicy: 'fail_open' | 'fail_closed';
  totalTicksDefault: number;
  sessionTtlSeconds: number;
  /** DS_GATE_COMPILED_CONFIG escape hatch — bypasses active.json
   *  resolution entirely when set. */
  compiledConfigOverride?: string;
}

export interface BeginSessionRequest {
  deploy_ref: string;
  deploy_id?: string;
  service_id?: string;
  total_ticks?: number;
  mode?: 'enforce' | 'shadow';
  requested_at_ts: number;
  scenario: {
    baseline: Record<string, number>;
    risk_level?: string;
    change_type?: string;
    author?: string;
    time_window?: string;
    flags?: Record<string, boolean>;
  };
}

export interface BeginSessionResult {
  record: SessionRecord;
  created: boolean;
  config_source: 'lifecycle_store' | 'override' | 'legacy';
  degraded?: boolean;
}

export interface TickRequest {
  emitted_at_ts: number;
  metrics: Record<string, number>;
  hour_of_day?: number;
  day_of_week?: number;
}

export interface TickResult {
  tick: number;
  verdict: string;
  verdict_code: number;
  alpha_consumed: number;
  fires: string[];
  replayed: boolean;
  shadow: boolean;
  shortCircuit: string | null;
  degraded?: boolean;
  error?: string;
  session_status: SessionStatus;
}

export interface VerdictResponse {
  verdict_code: number;
  verdict: string;
  tick: number;
  total_ticks: number;
  config_version: string;
  alpha_consumed: number;
  fires: string[];
  shadow_verdict_code?: number;
  degraded?: boolean;
  error?: string;
}

interface SessionRuntimeState {
  trendBuffer: TrendBufferI;
  lifecycleState: LifecycleDeployState;
  failFastState: FailFastState | undefined;
  verdictGrouper: VerdictGrouperType;
  reversibilityClassification: ReversibilityClassification | undefined;
  compiledConfig: CompiledConfig | null;
}

type EvaluateFn = (params: OrchestrateParams) => VerdictResult;

const LOCK_FILENAME = '.gate-runtime.lock';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: process exists but we lack permission to signal it -> alive.
    // Anything else (ESRCH, etc.): no such process -> dead.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireStoreLock(storeDir: string): string {
  fs.mkdirSync(storeDir, { recursive: true });
  const lockPath = path.join(storeDir, LOCK_FILENAME);

  let existingPid: number | null = null;
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: number };
    existingPid = typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') existingPid = null; // corrupted lock -> treat as reclaimable
  }

  if (existingPid !== null && isPidAlive(existingPid)) {
    throw new GateRuntimeLockError(lockPath, existingPid);
  }

  // Absent, or held by a dead pid: reclaim/create (atomic tmp+rename,
  // same convention as SessionStore's atomicWriteJson).
  const tmp = `${lockPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
  fs.renameSync(tmp, lockPath);
  return lockPath;
}

function releaseStoreLock(lockPath: string): void {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: number };
    if (parsed.pid === process.pid) fs.unlinkSync(lockPath);
    // A lock file now owned by a different pid (a later reclaim raced
    // past us) is not ours to delete — leave it alone.
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

function loadCompiledConfigFile(configPath: string): CompiledConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw) as CompiledConfig;
}

export class GateSessionRuntime {
  private readonly runtimeState = new Map<string, SessionRuntimeState>();
  private readonly lockPath: string;
  private closed = false;
  private evaluateFn: EvaluateFn = orchestrate;

  constructor(
    private readonly cfg: GateRuntimeConfig,
    private readonly store: SessionStore,
    private readonly emitter: LifecycleEventEmitter,
    private readonly auditWriter: AuditWriter,
  ) {
    this.lockPath = acquireStoreLock(cfg.storeDir);
  }

  /** Test-only seam: injects a stand-in for the real engine `evaluate()`
   *  call so fail_open/fail_closed behavior can be exercised
   *  deterministically without depending on a specific detector's
   *  internal throw conditions. Never called by production code paths
   *  (Task 7's server.ts always uses the real engine). */
  setEvaluateFnForTest(fn: EvaluateFn): void {
    this.evaluateFn = fn;
  }

  /** Test-only seam (m2, final-review): a structurally-comparable,
   *  JSON-serializable deep snapshot of a session's in-memory
   *  accumulator state (the per-session Map entry described in this
   *  file's header) — including VerdictGrouper's private `Map` fields,
   *  which `JSON.stringify` alone would flatten to `{}`. Lets a test
   *  assert detector/trendBuffer state is byte-identical before and
   *  after a replayed tick (a replay must not touch any accumulator).
   *  Never called by production code paths. Returns null when the
   *  session has no in-memory state yet (never ticked). */
  getRuntimeStateSnapshotForTest(sessionId: string): unknown {
    const state = this.runtimeState.get(sessionId);
    if (!state) return null;
    const grouper = state.verdictGrouper as unknown as {
      openByDeploy: Map<string, unknown>;
      recentlyClosed: Map<string, unknown>;
    };
    return {
      trendBuffer: JSON.parse(JSON.stringify(state.trendBuffer)),
      lifecycleState: JSON.parse(JSON.stringify(state.lifecycleState)),
      failFastState: JSON.parse(JSON.stringify(state.failFastState ?? null)),
      reversibilityClassification: JSON.parse(JSON.stringify(state.reversibilityClassification ?? null)),
      verdictGrouper: {
        openByDeploy: Array.from(grouper.openByDeploy.entries()),
        recentlyClosed: Array.from(grouper.recentlyClosed.entries()),
      },
    };
  }

  /** Releases the store-root lock. Idempotent-safe to call once at
   *  process shutdown; a second call is a no-op (releaseStoreLock treats
   *  an already-removed lockfile as ENOENT-fine). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    releaseStoreLock(this.lockPath);
  }

  /** OQ-1 declare-void-and-restart: the in-memory accumulator map is
   *  already empty on a fresh process (nothing to clear) — this voids
   *  every session the durable store still has marked `active` from a
   *  prior process's lifetime. Call once at service startup, before
   *  serving traffic. */
  sweepOnBoot(): SessionRecord[] {
    return this.store.voidAllActive('service_restart');
  }

  /** Lazy TTL sweep — Addition #15 D1 pattern: no background timer, run
   *  on every request. Voids any `active` session idle (no tick, and no
   *  begin) for longer than `sessionTtlSeconds`. */
  sweepExpired(nowTs: number): void {
    for (const rec of this.store.listActive()) {
      const lastActivityTs = rec.last_tick_at ? Date.parse(rec.last_tick_at) / 1000 : rec.begun_request_ts;
      if (nowTs - lastActivityTs > this.cfg.sessionTtlSeconds) {
        this.store.voidSession(rec.session_id, 'session_ttl_expired');
      }
    }
  }

  begin(req: BeginSessionRequest): BeginSessionResult {
    const existing = this.store.getSessionByDeployRef(req.deploy_ref);
    if (existing && existing.status === 'active') {
      const source: 'lifecycle_store' | 'override' | 'legacy' =
        existing.active_calibration_version === 'legacy' ? 'legacy'
          : existing.active_calibration_version === 'override' ? 'override' : 'lifecycle_store';
      return { record: existing, created: false, config_source: source };
    }

    let resolved: ActiveCalibration | null = null;
    let configSource: 'lifecycle_store' | 'override' | 'legacy' = 'legacy';
    let degraded = false;

    try {
      if (this.cfg.compiledConfigOverride) {
        resolved = {
          version_id: 'override', compiled_config_path: this.cfg.compiledConfigOverride,
          baseline_ref: null, config: loadCompiledConfigFile(this.cfg.compiledConfigOverride),
        };
        configSource = 'override';
      } else {
        const r = resolveActiveCalibration(this.cfg.baselineHistoryDir, this.cfg.serviceId);
        if (r) { resolved = r; configSource = 'lifecycle_store'; }
      }
    } catch (e) {
      if (this.cfg.failPolicy === 'fail_closed') throw e; // ActiveCalibrationError -> caller (HTTP) maps to 503
      degraded = true; // fail_open: proceed on the legacy/no-config path
    }

    // M1 fix (final-review blocker): the naive `sess-${deploy_ref}-${ts}`
    // id collides with a prior dead (void/finished) session's record
    // whenever a retried begin computes the same deploy_ref+timestamp —
    // e.g. immediately after sweepOnBoot() voids the prior session for
    // the same deploy_ref and the caller retries with an identical
    // requested_at_ts. Overwriting that record in place would destroy its
    // void_reason/last_verdict audit trail AND resurrect its
    // <id>.verdicts.jsonl idempotency history under the new session, so a
    // genuinely fresh tick at a timestamp that collides with the dead
    // session's history would incorrectly replay a stale verdict instead
    // of being evaluated. Uniquify with a deterministic attempt-counter
    // suffix (scanning existing session records) so the dead record is
    // never touched and the new session starts with empty idempotency
    // state. The active-session idempotent-return path above is
    // unaffected.
    const sessionId = this.uniquifySessionId(`sess-${req.deploy_ref}-${req.requested_at_ts}`);
    const beginInput: BeginSessionInput = {
      session_id: sessionId,
      service_id: req.service_id ?? this.cfg.serviceId,
      deploy_id: req.deploy_id ?? req.deploy_ref,
      deploy_ref: req.deploy_ref,
      mode: req.mode ?? this.cfg.mode,
      fail_policy: this.cfg.failPolicy,
      active_calibration_version: resolved?.version_id ?? 'legacy',
      compiled_config_path: resolved?.compiled_config_path ?? null,
      baseline_ref: resolved?.baseline_ref ?? null,
      total_ticks: req.total_ticks ?? this.cfg.totalTicksDefault,
      begun_request_ts: req.requested_at_ts,
      begun_at: new Date(req.requested_at_ts * 1000).toISOString(),
      deployment: { phase: 'baking', start_time_ms: req.requested_at_ts * 1000, cloud: 'primary' },
      scenario: {
        risk_level: req.scenario.risk_level ?? 'medium',
        change_type: req.scenario.change_type ?? 'serving_code',
        author: req.scenario.author ?? 'human',
        time_window: req.scenario.time_window ?? 'ok',
        flags: req.scenario.flags ?? {},
        baseline: req.scenario.baseline,
      },
    };

    const record = this.store.beginSession(beginInput);
    this.runtimeState.set(record.session_id, {
      trendBuffer: new TrendBufferCtor(TREND_WINDOW),
      lifecycleState: freshLifecycleState(),
      failFastState: undefined,
      verdictGrouper: new VerdictGrouperCtor(),
      reversibilityClassification: undefined,
      compiledConfig: resolved?.config ?? null,
    });

    return {
      record, created: true, config_source: configSource, ...(degraded ? { degraded: true } : {}),
    };
  }

  /** M1 fix: `base` is only ever handed back unmodified when no session
   *  record occupies that id yet. A collision (always a dead — void or
   *  finished — record, since an active collision is short-circuited
   *  before this is reached) is resolved by scanning `-r2`, `-r3`, ...
   *  until an unused id is found, so retries never overwrite durable
   *  audit state and never inherit a dead session's idempotency keys. */
  private uniquifySessionId(base: string): string {
    if (!this.store.getSession(base)) return base;
    let attempt = 2;
    let candidate = `${base}-r${attempt}`;
    while (this.store.getSession(candidate)) {
      attempt += 1;
      candidate = `${base}-r${attempt}`;
    }
    return candidate;
  }

  private runtimeStateFor(session: SessionRecord): SessionRuntimeState {
    let state = this.runtimeState.get(session.session_id);
    if (!state) {
      let compiledConfig: CompiledConfig | null = null;
      if (session.compiled_config_path) {
        try {
          compiledConfig = loadCompiledConfigFile(session.compiled_config_path);
        } catch {
          compiledConfig = null; // best-effort re-hydration after restart; evaluate() runs on the legacy path
        }
      }
      state = {
        trendBuffer: new TrendBufferCtor(TREND_WINDOW),
        lifecycleState: freshLifecycleState(),
        failFastState: undefined,
        verdictGrouper: new VerdictGrouperCtor(),
        reversibilityClassification: undefined,
        compiledConfig,
      };
      this.runtimeState.set(session.session_id, state);
    }
    return state;
  }

  ingestTick(sessionId: string, req: TickRequest): TickResult {
    const session = this.store.getSession(sessionId);
    if (!session) throw new GateSessionNotFoundError(sessionId);

    if (this.store.hasTick(sessionId, req.emitted_at_ts)) {
      const stored = this.store.getStoredTickResponse(sessionId, req.emitted_at_ts)!;
      return {
        tick: stored.tick, verdict: stored.verdict, verdict_code: stored.verdict_code,
        alpha_consumed: stored.alpha_consumed, fires: stored.fires, replayed: true,
        shadow: stored.shadow, shortCircuit: null,
        ...(stored.error !== undefined ? { error: stored.error } : {}),
        ...(stored.degraded !== undefined ? { degraded: stored.degraded } : {}),
        session_status: session.status,
      };
    }

    const state = this.runtimeStateFor(session);
    for (const key of Object.keys(req.metrics)) state.trendBuffer.push(key, req.metrics[key]);

    const emittedDate = new Date(req.emitted_at_ts * 1000);
    const params: OrchestrateParams = {
      liveMetrics: req.metrics as Metrics,
      scenario: {
        id: session.session_id,
        riskLevel: session.scenario.risk_level as RiskLevel,
        bakeHours: 0,
        author: session.scenario.author as Author,
        changeType: session.scenario.change_type as ChangeType,
        timeWindow: session.scenario.time_window as TimeWindow,
        flags: session.scenario.flags as Flags,
        baseline: session.scenario.baseline as Metrics,
      },
      hoursElapsed: (req.emitted_at_ts - session.begun_request_ts) / 3600,
      trendBuffer: state.trendBuffer,
      tick: session.tick,
      totalTicks: session.total_ticks,
      deployId: session.deploy_id,
      targetCloud: session.deployment.cloud,
      stateContext: this.store.stateGateContext(sessionId),
      compiledConfig: state.compiledConfig,
      currentHourOfDay: req.hour_of_day ?? emittedDate.getUTCHours(),
      currentDayOfWeek: req.day_of_week ?? emittedDate.getUTCDay(),
      failFastState: state.failFastState,
      lifecycleEmitter: this.emitter,
      lifecycleState: state.lifecycleState,
      reversibilityClassification: state.reversibilityClassification,
      verdictGrouper: state.verdictGrouper,
      auditWriter: this.auditWriter,
      nowSeconds: req.emitted_at_ts,
    };

    let verdict: string;
    let verdictCodeVal: number;
    let alphaConsumed = 0;
    let fires: string[] = [];
    let shortCircuit: string | null = null;
    let degraded = false;
    let errorMsg: string | undefined;

    try {
      const result = this.evaluateFn(params);
      verdict = result.verdict;
      verdictCodeVal = codeFor(verdict);
      alphaConsumed = result.gateResults?.fusion?.total_alpha_spent ?? 0;
      fires = result.healthResult?.rollback.map((s) => s.id) ?? [];
      shortCircuit = result.shortCircuit;
      state.failFastState = result.failFastState;
      if (result.lifecycleState) state.lifecycleState = result.lifecycleState;
      if (result.reversibilityClassification) state.reversibilityClassification = result.reversibilityClassification;
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      if (this.cfg.failPolicy === 'fail_closed') {
        verdict = 'extend'; verdictCodeVal = -1;
      } else {
        verdict = 'proceed'; verdictCodeVal = 0; degraded = true;
      }
    }

    const shadow = session.mode === 'shadow';
    const recordedAt = new Date().toISOString();
    const entry: VerdictHistoryEntry = {
      session_id: sessionId, tick: session.tick, emitted_at_ts: req.emitted_at_ts,
      verdict, verdict_code: verdictCodeVal, alpha_consumed: alphaConsumed, fires, shadow,
      recorded_at: recordedAt,
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
      ...(degraded ? { degraded: true } : {}),
    };
    // m5 fix (final-review): a tick against a session that is already
    // dead (void/finished) at entry only ever reaches here via G3's deny
    // short-circuit (evaluateState() denies + the caller still asked to
    // evaluate directly against the runtime, bypassing the HTTP layer's
    // own pre-check) — durable state must stay byte-identical to before
    // the call: no new verdict-history line, no tick/last_verdict bump,
    // no phase/finish transition. Only a currently-active session (at
    // the tick's entry) may durably persist a tick outcome.
    if (session.status === 'active') {
      this.store.appendVerdict(entry);

      const nextTick = session.tick + 1;
      const terminal = verdict === 'rollback' || verdict === 'proceed' || nextTick >= session.total_ticks;

      this.store.updateSession(sessionId, {
        tick: nextTick,
        last_tick_at: recordedAt,
        last_verdict: {
          verdict, verdict_code: verdictCodeVal, tick: session.tick, alpha_consumed: alphaConsumed, fires,
        },
      });

      if (verdict === 'rollback') this.store.updatePhase(sessionId, 'rolled_back' as DeploymentPhase);
      if (terminal) {
        const reason = verdict === 'rollback' ? 'rollback' : (verdict === 'proceed' ? 'proceed' : 'total_ticks_reached');
        this.store.finishSession(sessionId, reason);
      }
    }

    const finalRec = this.store.getSession(sessionId)!;
    return {
      tick: session.tick, verdict, verdict_code: verdictCodeVal, alpha_consumed: alphaConsumed,
      fires, replayed: false, shadow, shortCircuit,
      ...(degraded ? { degraded: true } : {}),
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
      session_status: finalRec.status,
    };
  }

  finish(sessionId: string, reason?: string): SessionRecord {
    return this.store.finishSession(sessionId, reason);
  }

  verdictFor(deployRef: string): VerdictResponse | null {
    const session = this.store.getSessionByDeployRef(deployRef);
    if (!session) return null;

    const lv = session.last_verdict;
    let verdict = lv?.verdict ?? 'extend';
    let verdictCodeVal = lv ? codeFor(lv.verdict) : -1;
    const alphaConsumed = lv?.alpha_consumed ?? 0;
    const fires = lv?.fires ?? [];
    const extra: Partial<VerdictResponse> = {};

    // m1 fix (final-review): void handling first computes the "real"
    // (enforce-mode-equivalent) verdict per fail policy, surfacing the
    // void via `error` (fail_closed) / `degraded` (fail_open) — then, if
    // the session is in shadow mode, that real verdict is demoted into
    // `shadow_verdict_code` and the top-level verdict/verdict_code is
    // *always* forced to proceed/0 (OQ-7: "a shadow gate must never
    // block", even when the underlying session is void). Precedence
    // matters here: shadow must win last, unconditionally.
    if (session.status === 'void') {
      if (this.cfg.failPolicy === 'fail_closed') {
        verdict = 'extend'; verdictCodeVal = -1;
        extra.error = `session_void: ${session.void_reason ?? 'unknown'}`;
      } else {
        verdict = 'proceed'; verdictCodeVal = 0;
        extra.degraded = true;
      }
    }

    if (session.mode === 'shadow') {
      extra.shadow_verdict_code = verdictCodeVal;
      verdict = 'proceed'; verdictCodeVal = 0;
    }

    return {
      verdict_code: verdictCodeVal,
      verdict,
      tick: session.tick,
      total_ticks: session.total_ticks,
      config_version: session.active_calibration_version,
      alpha_consumed: alphaConsumed,
      fires,
      ...extra,
    };
  }
}
