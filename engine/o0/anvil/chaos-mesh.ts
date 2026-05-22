// engine/o0/anvil/chaos-mesh.ts — Chaos Mesh (CNCF) adapter.
//
// Chaos Mesh: Kubernetes-native chaos engineering. Experiments are CRDs
// (PodChaos, NetworkChaos, IOChaos, StressChaos, TimeChaos, …) read via
// the K8s API. The adapter watches the experiment CRD in the target
// namespace and reads .spec.action + .spec.duration for the attack
// class and fault-window length.
//
// v1 stub.

import type {
  ChaosOrchestrationAdapter,
  ExpectedFailurePattern,
  ChaosExperimentContext,
} from './types';

export class ChaosMeshAdapter implements ChaosOrchestrationAdapter {
  constructor(
    private readonly kubeconfigPath: string,
    private readonly namespace: string,
  ) {}

  /** Live impl: K8s API watch on the named CRD; maps .spec.action
   *  (delay, abort, kill, partition, stress, etc.) → ExpectedFailurePattern.kind;
   *  .spec.duration (Go duration string, e.g. "60s") → recovery_seconds. */
  async fetchExpectedFailurePattern(_experiment_ref: string): Promise<ExpectedFailurePattern> {
    throw new Error('ChaosMeshAdapter.fetchExpectedFailurePattern not yet implemented (v1 stub per Q29)');
  }

  async fetchChaosExperimentContext(_experiment_ref: string): Promise<ChaosExperimentContext> {
    throw new Error('ChaosMeshAdapter.fetchChaosExperimentContext not yet implemented (v1 stub per Q29)');
  }

  async fetchDeployContext(_deploy: unknown): Promise<unknown> {
    throw new Error('ChaosMeshAdapter.fetchDeployContext not yet implemented (v1 stub per Q29)');
  }

  async emitVerdict(_verdict: unknown, _deploy: unknown): Promise<unknown> {
    throw new Error('ChaosMeshAdapter.emitVerdict not yet implemented (v1 stub per Q29)');
  }
}
