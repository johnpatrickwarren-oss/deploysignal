// engine/o0/anvil/litmus.ts — LitmusChaos (CNCF graduated) adapter.
//
// Litmus: Kubernetes-native chaos via ChaosExperiment + ChaosEngine CRDs.
// The adapter reads ChaosEngine.spec.experiments[] and resolves each
// referenced ChaosExperiment custom resource to extract its env
// (TOTAL_CHAOS_DURATION, CHAOS_INTERVAL, FAULT_TYPE, etc.) for
// translation to ExpectedFailurePattern.
//
// v1 stub.

import type {
  ChaosOrchestrationAdapter,
  ExpectedFailurePattern,
  ChaosExperimentContext,
} from './types';

export class LitmusChaosAdapter implements ChaosOrchestrationAdapter {
  constructor(
    private readonly kubeconfigPath: string,
    private readonly namespace: string,
  ) {}

  /** Live impl: K8s API GET on the named ChaosEngine; for each
   *  spec.experiments[i].name, GET the corresponding ChaosExperiment CR
   *  and translate its env to ExpectedFailurePattern. */
  async fetchExpectedFailurePattern(_experiment_ref: string): Promise<ExpectedFailurePattern> {
    throw new Error('LitmusChaosAdapter.fetchExpectedFailurePattern not yet implemented (v1 stub per Q29)');
  }

  async fetchChaosExperimentContext(_experiment_ref: string): Promise<ChaosExperimentContext> {
    throw new Error('LitmusChaosAdapter.fetchChaosExperimentContext not yet implemented (v1 stub per Q29)');
  }

  async fetchDeployContext(_deploy: unknown): Promise<unknown> {
    throw new Error('LitmusChaosAdapter.fetchDeployContext not yet implemented (v1 stub per Q29)');
  }

  async emitVerdict(_verdict: unknown, _deploy: unknown): Promise<unknown> {
    throw new Error('LitmusChaosAdapter.emitVerdict not yet implemented (v1 stub per Q29)');
  }
}
