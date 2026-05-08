// engine/gates/state.ts — G3 deployment state gate
// Stub for now; tracks deployment lifecycle and exposes evaluateState().

import type { StateResult } from '../types';

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

export function evaluateState(_id: string, _cloud: string): StateResult {
  return { allow: true, reason: null };
}

export function reset(): void {
  _state = { deployments: {} };
}
