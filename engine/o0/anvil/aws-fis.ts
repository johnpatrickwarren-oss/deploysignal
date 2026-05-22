// engine/o0/anvil/aws-fis.ts — AWS Fault Injection Simulator adapter.
//
// AWS FIS: managed chaos service. Experiments described by experiment
// templates referenced by Amazon Resource Name (ARN). The adapter reads
// the template via the FIS API (GetExperimentTemplate / GetExperiment)
// and translates actions (aws:ec2:stop-instances, aws:rds:reboot-db-instance,
// aws:ssm:send-command, etc.) onto ExpectedFailurePattern.kind.
//
// v1 stub.

import type {
  ChaosOrchestrationAdapter,
  ExpectedFailurePattern,
  ChaosExperimentContext,
} from './types';

export class AwsFisChaosAdapter implements ChaosOrchestrationAdapter {
  constructor(
    private readonly region: string,
    private readonly roleArn: string,
  ) {}

  /** Live impl: FIS GetExperimentTemplate { templateId } + GetExperiment
   *  { id }; maps actions[].actionId to ExpectedFailurePattern.kind;
   *  stopConditions[].source resolution determines recovery_seconds bound. */
  async fetchExpectedFailurePattern(_experiment_ref: string): Promise<ExpectedFailurePattern> {
    throw new Error('AwsFisChaosAdapter.fetchExpectedFailurePattern not yet implemented (v1 stub per Q29)');
  }

  async fetchChaosExperimentContext(_experiment_ref: string): Promise<ChaosExperimentContext> {
    throw new Error('AwsFisChaosAdapter.fetchChaosExperimentContext not yet implemented (v1 stub per Q29)');
  }

  async fetchDeployContext(_deploy: unknown): Promise<unknown> {
    throw new Error('AwsFisChaosAdapter.fetchDeployContext not yet implemented (v1 stub per Q29)');
  }

  async emitVerdict(_verdict: unknown, _deploy: unknown): Promise<unknown> {
    throw new Error('AwsFisChaosAdapter.emitVerdict not yet implemented (v1 stub per Q29)');
  }
}
