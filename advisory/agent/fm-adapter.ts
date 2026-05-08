// advisory/agent/fm-adapter.ts — Addition #27 FM adapters.
//
// v1 ships 3 concrete adapters per REPLY-49 D1 / D5:
//   - StubAdapter: deterministic scripted responses for tests +
//     v1 acceptance path. Also the default when
//     `ConfiguredAgent.fm_vendor === 'stub'`.
//   - MosaicNativeAdapter: CONTRACT ONLY in v1. Real MLflow /
//     Unity Catalog wiring is deferred per D5. invokeStructured
//     throws `INTEGRATION_PENDING` so orchestrator integration
//     fails loudly if a misconfigured deploy sets `fm_vendor:
//     'mosaic_native'` current-cycle.
//   - ClaudeBedrockAdapter: CONTRACT ONLY in v1. Same for follow-on
//     migration path as MosaicNativeAdapter.

import type { AgentInputContext, FmAdapter, StubScript } from './types';

/** Scripted-response adapter used across the test harness + as the
 *  v1 default on deploys with `fm_vendor: 'stub'`. Maintains a
 *  per-instance call counter so scripts can script stateful
 *  behaviors like "return malformed output for the first call,
 *  then valid output on re-query" (exercises rail f). */
export class StubAdapter implements FmAdapter {
  readonly id = 'stub_adapter_v1';
  readonly vendor = 'stub' as const;
  private readonly script: StubScript;
  private callCount = 0;

  constructor(script: StubScript) {
    this.script = script;
  }

  /** Public for test visibility — lets a test reset the counter
   *  between scenarios without constructing a fresh adapter. */
  resetCallCount(): void {
    this.callCount = 0;
  }

  callCountForTest(): number {
    return this.callCount;
  }

  async invokeStructured(ctx: AgentInputContext, _schema: unknown): Promise<unknown> {
    const response = this.script.respond(ctx, this.callCount);
    this.callCount += 1;
    return response;
  }
}

const INTEGRATION_PENDING = 'INTEGRATION_PENDING: real FM wiring is deferred per REPLY-49 D5';

/** v1 stub for Mosaic-native FM via MLflow / Unity Catalog. Real
 *  wiring lands in follow-on alongside Family E Tier-3 foundation-model
 *  work (per TPM-REPLY-39). Test-suite callers should use
 *  StubAdapter; production callers should pre-check the environment
 *  and not configure this adapter until wiring lands. */
export class MosaicNativeAdapter implements FmAdapter {
  readonly id = 'mosaic_native_v1_contract';
  readonly vendor = 'mosaic_native' as const;

  async invokeStructured(_ctx: AgentInputContext, _schema: unknown): Promise<unknown> {
    throw new Error(INTEGRATION_PENDING);
  }
}

/** v1 stub for Claude-via-Bedrock (non-the target platform deployments).
 *  Same for follow-on migration timing as MosaicNativeAdapter. */
export class ClaudeBedrockAdapter implements FmAdapter {
  readonly id = 'claude_bedrock_v1_contract';
  readonly vendor = 'claude_bedrock' as const;

  async invokeStructured(_ctx: AgentInputContext, _schema: unknown): Promise<unknown> {
    throw new Error(INTEGRATION_PENDING);
  }
}
