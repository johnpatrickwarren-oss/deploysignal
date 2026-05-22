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
import { translateChaosMeshSpec, type ChaosMeshCRD } from './chaos-mesh-translate';

export class ChaosMeshAdapter implements ChaosOrchestrationAdapter {
  constructor(
    private readonly kubeconfigPath: string,
    private readonly namespace: string,
  ) {}

  /** Live impl: K8s API watch on the named CRD; maps .spec.action
   *  (delay, abort, kill, partition, stress, etc.) → ExpectedFailurePattern.kind;
   *  .spec.duration (Go duration string, e.g. "60s") → recovery_seconds.
   *  v1 stub: the K8s-API client call stays unimplemented (integrator
   *  wires @kubernetes/client-node or equivalent). The translation
   *  logic is testable via translateChaosMeshSpec() exported from
   *  ./chaos-mesh-translate. */
  async fetchExpectedFailurePattern(_experiment_ref: string): Promise<ExpectedFailurePattern> {
    throw new Error('ChaosMeshAdapter.fetchExpectedFailurePattern not yet implemented (v1 stub per Q29); use translateChaosMeshSpec for offline-fixture translation');
  }

  /** Q29 SLICE 2 (proof-of-life) — translate an already-fetched CRD
   *  object to ExpectedFailurePattern. Useful for offline fixtures
   *  and tests; integrators wiring a real K8s client can compose
   *  `await k8sApi.get(...)` → `translateFromCRD(...)`. */
  translateFromCRD(crd: ChaosMeshCRD, nowUnixSeconds: number): ExpectedFailurePattern {
    return translateChaosMeshSpec(crd, nowUnixSeconds);
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
