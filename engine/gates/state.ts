// engine/gates/state.ts — G3 deployment state gate
//
// In-memory deployment tracking (recordDeployment/updatePhase/
// getDeployment/reset) is the pre-WS4 default — nothing reads it in
// production; the durable, service-backed implementation lands in
// Task 3 (service/session/session-store.ts SessionStore), which builds
// a StateGateContext from its file-backed store and passes it into
// evaluateState() per tick. This split keeps the engine itself free of
// fs/session I/O (rootDir purity, browser-bundle safety).
//
// Task 2 (WS4 session-durability-argo plan): evaluateState() gains an
// optional `ctx?: StateGateContext`. Absent ctx (or ctx===undefined) is
// byte-identical to the original stub — hard backward-compat gate, same
// precedent as `failFastState`/`lifecycleEmitter` in OrchestrateParams.

import type { StateResult } from '../types';
import type { StateGateContext } from '../types/session';

interface DeploymentVerdict {
  ts?: number;
  verdict?: string;
  [key: string]: unknown;
}

interface Deployment {
  id: string;
  phase: string;
  startTime: number;
  verdicts: DeploymentVerdict[];
  cloud: string;
  [key: string]: unknown;
}

interface StateStore {
  deployments: { [id: string]: Deployment };
}

let _state: StateStore = { deployments: {} };

export function recordDeployment(id: string, rec: Partial<Deployment>): void {
  _state.deployments[id] = Object.assign(
    { id, phase: 'baking', startTime: Date.now(), verdicts: [] as DeploymentVerdict[], cloud: 'primary' },
    rec,
  );
}

export function updatePhase(id: string, phase: string, snap?: DeploymentVerdict): void {
  const d = _state.deployments[id];
  if (!d) return;
  d.phase = phase;
  if (snap) d.verdicts.push(snap);
}

export function getDeployment(id: string): Deployment | null {
  return _state.deployments[id] || null;
}

export function evaluateState(_id: string, _cloud: string, ctx?: StateGateContext): StateResult {
  if (!ctx) return { allow: true, reason: null };
  if (ctx.session_status === 'void') {
    return { allow: false, reason: 'session_void: ' + (ctx.void_reason ?? 'unknown') };
  }
  if (ctx.session_status === 'finished') {
    return { allow: false, reason: 'session_finished' };
  }
  if (ctx.deployment_phase === 'rolled_back' || ctx.deployment_phase === 'finished') {
    return { allow: false, reason: 'deployment_terminal: ' + ctx.deployment_phase };
  }
  return { allow: true, reason: null };
}

export function reset(): void {
  _state = { deployments: {} };
}
