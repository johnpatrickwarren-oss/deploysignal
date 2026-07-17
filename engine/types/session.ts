// engine/types/session.ts — Task 2 (WS4 session-durability-argo plan):
// pure data contract for the G3 state gate. The service layer (Task 3's
// SessionStore, service/session/) builds a StateGateContext from its
// file-backed store before each evaluate() call; the engine itself never
// touches fs/session persistence — this keeps engine/gates/state.ts
// browser-bundle-safe (no callbacks, no I/O) and rootDir-pure.

export type SessionStatus = 'active' | 'finished' | 'void';
export type DeploymentPhase = 'baking' | 'promoted' | 'rolled_back' | 'finished';

/** Pure data snapshot — the service layer builds this from its file-backed
 *  store before each evaluate() call. Absent => G3 behaves exactly as the
 *  pre-WS4 stub (allow: true). No callbacks, no fs, browser-bundle safe. */
export interface StateGateContext {
  session_status: SessionStatus;
  void_reason?: string | null;
  deployment_phase?: DeploymentPhase;
}
