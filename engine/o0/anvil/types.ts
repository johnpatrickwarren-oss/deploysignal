// engine/o0/anvil/types.ts — Anvil chaos-verdict typed contracts.
//
// Anvil packages the DeploySignal verdict substrate as a chaos-
// engineering-verdict product (Addition #29 / PRD-29 / Q29). The types
// here are the adapter-boundary contract: every chaos-platform adapter
// under engine/o0/anvil/ produces these shapes, and the orchestrator
// consumes ExpectedFailurePattern via OrchestrateParams.expectedFailurePattern.

/** Family identifiers that may be suppressed during the fault window. */
export type SuppressibleFamily = 'A' | 'B' | 'C' | 'D' | 'E';

/** Operator-declared expectation of what the injected fault should do.
 *  Declared at chaos-experiment start. The chaos adapter populates this
 *  from the source platform's experiment definition. */
export interface ExpectedFailurePattern {
  /** The injected-fault class. Free-form string keyed against the
   *  chaos-platform's experiment-type taxonomy (e.g., 'latency_injection',
   *  'cpu_stress', 'pod_kill', 'network_partition'). */
  kind: string;
  /** Signal IDs the operator expects the fault to perturb. */
  affected_signals: string[];
  /** Expected magnitude of the perturbation. Operator-keyed; the engine
   *  does not enforce the value. */
  magnitude: number;
  /** Unit for `magnitude`. */
  magnitude_unit: 'relative_fraction' | 'absolute' | 'sigma';
  /** Expected recovery window in seconds. After this window elapses
   *  from `fault_start_unix`, suppression releases and detectors
   *  resume normal eligibility. */
  recovery_seconds: number;
  /** Detector families to suppress during the fault window. Default
   *  empty (no suppression — every fire is unexpected). Per Q29.1
   *  architect-pick, granularity is family-level (not per-signal). */
  suppress_families: SuppressibleFamily[];
  /** Unix-seconds timestamp of fault injection start. The chaos adapter
   *  populates this from the source platform's experiment start signal. */
  fault_start_unix: number;
}

/** The chaos-experiment context the adapter fetches at experiment-start.
 *  Sibling to DeployContext (Addition #9); the chaos adapter's
 *  fetchDeployContext returns DeployContext with strategy 'chaos_experiment'
 *  and expected_failure_pattern populated. */
export interface ChaosExperimentContext {
  experiment_id: string;
  experiment_ref: string;
  platform: 'gremlin' | 'chaos_mesh' | 'aws_fis' | 'litmus';
  expected_failure_pattern: ExpectedFailurePattern;
}

/** Structural-type sketch for OrchestrationAdapter / DeployContext per
 *  Addition #9. Until Addition #9 materializes a typed module export,
 *  these locals stand in. Replace with the canonical import when the
 *  upstream interface ships. See Q29 § OQ-29.2. */
export interface OrchestrationAdapterLike {
  emitVerdict(verdict: unknown, deploy: unknown): Promise<unknown>;
  fetchDeployContext(deploy: unknown): Promise<unknown>;
}

/** Chaos-adapter extension to the OrchestrationAdapter contract. Every
 *  module under engine/o0/anvil/ implements this on top of the base. */
export interface ChaosOrchestrationAdapter extends OrchestrationAdapterLike {
  fetchExpectedFailurePattern(experiment_ref: string): Promise<ExpectedFailurePattern>;
  fetchChaosExperimentContext(experiment_ref: string): Promise<ChaosExperimentContext>;
}

/** Adapter-boundary verdict vocabulary for chaos experiments. The engine
 *  emits its native vocabulary; the adapter renames on emitVerdict per
 *  DeployContext.strategy === 'chaos_experiment'. See Q29.2 architect-pick. */
export type ChaosVerdict =
  | 'experiment_passed'
  | 'experiment_failed_unexpectedly'
  | 'experiment_still_running'
  | 'experiment_inconclusive';

export type EngineNativeVerdict =
  | 'proceed'
  | 'extend'
  | 'rollback'
  | 'suppressed_insufficient_samples';

/** Translation table — engine verdict → chaos verdict — applied at the
 *  adapter boundary only. Keep in sync with engine/verdict.ts native
 *  verdict set. The `firing_family_in_suppress_set` argument does NOT
 *  change the verdict label; it rides on the audit-record annotation
 *  so post-mortem review can distinguish "expected fault produced
 *  expected signal" from "unexpected blast on a non-suppressed family." */
export function translateToChaosVerdict(
  engine_verdict: EngineNativeVerdict,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _firing_family_in_suppress_set: boolean,
): ChaosVerdict {
  switch (engine_verdict) {
    case 'proceed': return 'experiment_passed';
    case 'extend': return 'experiment_still_running';
    case 'suppressed_insufficient_samples': return 'experiment_inconclusive';
    case 'rollback': return 'experiment_failed_unexpectedly';
  }
}

/** Helper — is the supplied tick-time within the fault window declared
 *  by the pattern? Used by the orchestrator suppression check. */
export function tickWithinFaultWindow(
  pattern: ExpectedFailurePattern,
  now_unix_seconds: number,
): boolean {
  const start = pattern.fault_start_unix;
  const end = start + pattern.recovery_seconds;
  return now_unix_seconds >= start && now_unix_seconds <= end;
}
