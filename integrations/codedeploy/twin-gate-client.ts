// integrations/codedeploy/twin-gate-client.ts — a minimal client for the twin gate's HTTP
// contract: POST /v1/sessions (mode "twin") and POST /v1/sessions/{id}/ticks. Built against the
// contract, not the gate service's code; fetch is injected.

import {
  assertTwinTickBody,
} from '../../service/sources/twin-contract';
import type {
  TwinArmBody, TwinSessionRequest, TwinSessionResponse, TwinTickBody, TwinTickResponse,
} from '../../service/sources/twin-contract';

export interface GateFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}
export type GateFetchLike = (url: string, init: GateFetchInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TwinGateClientConfig {
  baseUrl: string;
  fetch: GateFetchLike;
  /** Sent as x-ds-gate-token when the gate runs with a shared secret. */
  token?: string;
}

export class TwinGateClient {
  private readonly base: string;

  constructor(private readonly cfg: TwinGateClientConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, '');
  }

  async openSession(twinArm: TwinArmBody, signal?: AbortSignal): Promise<TwinSessionResponse> {
    const req: TwinSessionRequest = { mode: 'twin', twin_arm: twinArm };
    return (await this.post('/v1/sessions', req, 201, signal)) as TwinSessionResponse;
  }

  async tick(sessionId: string, body: TwinTickBody, signal?: AbortSignal): Promise<TwinTickResponse> {
    assertTwinTickBody(body);
    return (await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/ticks`, body, 200, signal)) as TwinTickResponse;
  }

  private async post(path: string, body: unknown, expectStatus: number, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.token) headers['x-ds-gate-token'] = this.cfg.token;
    const init: GateFetchInit = { method: 'POST', headers, body: JSON.stringify(body) };
    if (signal) init.signal = signal;
    const res = await this.cfg.fetch(`${this.base}${path}`, init);
    const json = await res.json().catch(() => ({}));
    if (res.status !== expectStatus) {
      const err = (json as { error?: unknown }).error;
      throw new Error(`twin gate ${path}: HTTP ${res.status} (expected ${expectStatus})${err ? `: ${String(err)}` : ''}`);
    }
    return json;
  }
}
