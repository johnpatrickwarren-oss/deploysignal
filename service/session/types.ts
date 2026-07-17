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

export interface LastVerdict {
  verdict: string;
  verdict_code: number;
  tick: number;
  alpha_consumed: number;
  fires: string[];
}

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
  deployment: SessionDeployment;
  scenario: SessionScenario;
}

export interface VerdictHistoryEntry {
  session_id: string;
  tick: number;
  emitted_at_ts: number; // idempotency key half
  verdict: string;
  verdict_code: number;
  alpha_consumed: number;
  fires: string[];
  shadow: boolean;
  recorded_at: string;
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
