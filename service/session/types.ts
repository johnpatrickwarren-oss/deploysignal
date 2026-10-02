// service/session/types.ts — Task 3 (WS4 session-durability-argo plan):
// file-backed SessionStore data contract. Mirrors Addition #15 §B store
// conventions (schema_version:'1' in every JSON file, atomic
// tmp+fs.renameSync writes) for the WS4 session-durability layer.
//
// service/ depends on engine/, never the other way (engine/types/
// orchestration.ts:186-188 states the doctrine for advisory/; this new
// top-level layer follows the same rule). SessionStatus/DeploymentPhase/
// StateGateContext stay defined once, in engine/types/session.ts (the
// pure contract the G3 gate consumes, Task 2) — re-exported here for
// convenience so callers only need to import from service/session/.

import type {
  DeploymentPhase, SessionStatus, StateGateContext,
} from '../../engine/types/session';
import type { TwinArmProfile } from '../../engine/types/_config-profiles';
import type { TwinArmReport } from '../../engine/gates/_health-twin';

export type { DeploymentPhase, SessionStatus, StateGateContext };

export interface StoreMeta {
  schema_version: '1';
  service_id: string;
  created_at: string;
}

export interface SessionIndex {
  schema_version: '1';
  by_deploy_ref: Record<string, string>;
}

/** C87 — one advisory fire as the gate reports it: a detector of Family A, C or D fired on `tick`
 *  and, being advisory (engine TEMPORAL_PATH_AUTHORITY), did not enter `fires` or the verdict.
 *  `id` is the rollback id the fire would have carried. */
export interface AdvisoryFire { id: string; family: 'A' | 'C' | 'D'; advisory_reason: string; tick: number }

export interface LastVerdict {
  verdict: string;
  verdict_code: number;
  tick: number;
  alpha_consumed: number;
  fires: string[];
  /** C87 — the advisory fires on that tick; absent when there were none. */
  advisory_fires?: AdvisoryFire[];
  /** Plan B — a twin session's engine verdict (the `verdict` above is the mapped one). */
  engine_verdict?: string;
}

/** Plan B — the tick response body of a twin session (the HTTP contract), stored on the verdict
 *  history line so a retried tick replays it verbatim. */
export type TwinTickResponse = Omit<TwinArmReport, 'srm_threshold'>;

export interface SessionDeployment {
  phase: DeploymentPhase;
  start_time_ms: number;
  cloud: string;
}

export interface SessionScenario {
  risk_level: string;
  change_type: string;
  author: string;
  time_window: string;
  flags: Record<string, boolean>;
  baseline: Record<string, number>;
}

export interface SessionRecord {
  schema_version: '1';
  session_id: string; // `sess-${deploy_ref}-${begun_request_ts}`
  service_id: string;
  deploy_id: string; // defaults to deploy_ref
  deploy_ref: string;
  status: SessionStatus;
  begun_at: string;
  ended_at: string | null;
  void_reason: string | null;
  mode: 'enforce' | 'shadow';
  fail_policy: 'fail_open' | 'fail_closed';
  active_calibration_version: string; // pinned at begin; 'legacy' when unresolved
  compiled_config_path: string | null;
  baseline_ref: string | null; // copied from active.json for audit
  total_ticks: number;
  tick: number; // ticks processed so far
  begun_request_ts: number; // caller-supplied unix seconds
  last_tick_at: string | null;
  last_verdict: LastVerdict | null;
  /** C87 — every advisory fire of the session so far, one entry per id at the first tick it
   *  fired; absent until one fires. Served by GET /v1/verdict. */
  advisory_fires?: AdvisoryFire[];
  deployment: SessionDeployment;
  scenario: SessionScenario;
  /** Plan B (engine ADR 0036) — present on a `mode: "twin"` session: the twin_arm it was begun
   *  with. Such a record is `mode: 'shadow'` (TWIN_ARM_AUTHORITY 'advisory'), its scenario carries
   *  no baseline, and its ticks go to the twin path (service/gate-http/_gate-twin.ts). */
  twin_arm?: TwinArmProfile;
}

export interface VerdictHistoryEntry {
  session_id: string;
  tick: number;
  emitted_at_ts: number; // idempotency key half
  verdict: string;
  verdict_code: number;
  alpha_consumed: number;
  fires: string[];
  /** C87 — the advisory fires on this tick; absent when there were none (so a line without one
   *  is byte-identical to a pre-C87 line). */
  advisory_fires?: AdvisoryFire[];
  shadow: boolean;
  recorded_at: string;
  // Task 6 (WS4 session-durability-argo plan) — strict-additive. Set when
  // GateSessionRuntime.ingestTick()'s evaluate() call threw: the tick is
  // still recorded durably (never lost) with the fail-policy-derived
  // verdict/verdict_code, plus the original error message here.
  // `degraded` is set only on the fail_open branch (verdict forced to
  // 'proceed' despite the underlying evaluation failure).
  error?: string;
  degraded?: boolean;
  /** Plan B — a twin session's full tick response (replayed verbatim on a retry). */
  twin?: TwinTickResponse;
}

/** Input to SessionStore.beginSession(): everything a caller (Task 6's
 *  GateSessionRuntime) knows before the store assigns lifecycle fields.
 *  session_id itself is caller-supplied (not store-generated) — the
 *  `sess-${deploy_ref}-${begun_request_ts}` convention lives with the
 *  caller so it stays visible in one place (OQ-4 idempotency key). */
export type BeginSessionInput = Omit<
  SessionRecord,
  'schema_version' | 'status' | 'tick' | 'ended_at' | 'void_reason' | 'last_tick_at' | 'last_verdict'
>;

/** Unknown schema_version on any store-owned JSON file — fail-loud per
 *  the plan's store-layout contract (no silent best-effort recovery for
 *  a corrupted/foreign-version record). */
export class SessionStoreSchemaError extends Error {
  constructor(filePath: string, found: unknown) {
    super(`session-store: unexpected schema_version in ${filePath}: ${JSON.stringify(found)}`);
    this.name = 'SessionStoreSchemaError';
  }
}
