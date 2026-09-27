// integrations/codedeploy/after-allow-traffic.ts — CodeDeploy ECS blue/green AfterAllowTraffic
// lifecycle hook (a Lambda handler) that runs the randomized twin gate for the deployment.
//
// Flow: open a twin session (POST /v1/sessions, mode "twin"), then per tick wait for the window
// to close (+ settleMs for metric publication lag), fetch the window from the MetricSource, post
// it (POST /v1/sessions/{id}/ticks), and stop on any verdict other than "extend", at max_ticks,
// or before the Lambda deadline. Finally call PutLifecycleEventHookExecutionStatus.
//
// DEADLINES. Every gate and source call races a deadline: callTimeoutMs, capped by the Lambda's
// remaining time minus safetyMs. On timeout the call's AbortSignal fires and the run ends as an
// error, which reports "Succeeded" like any other error. The Put itself is tried up to putAttempts
// times, each bounded by putTimeoutMs and the remaining time; the handler resolves even when every
// attempt fails, because a rejected async Lambda invocation is retried by Lambda and would run the
// whole gate again. A hook whose Put never lands is timed out by CodeDeploy.
//
// AUTHORITY. The twin arm is advisory (TWIN_ARM_AUTHORITY = 'advisory'; the gate's responses
// carry "authority": "advisory"). While advisory, no path here turns a twin verdict into a failed
// rollout: the hook reports "Succeeded" for every verdict, and for gate or source errors, and logs
// the verdict. `enforce` (default false) maps rollback/halt/hold to "Failed", and it takes effect
// only when the gate's own response states an authority other than "advisory"; with the gate
// advisory, enforce: true logs that it was overridden and still reports "Succeeded". Making the
// twin arm authoritative is a separate ADR after a real-service A/A run.
//
// PREMISE. The twin gate needs a fresh control arm on the old version at the canary's weight
// (ORCHESTRATION-ADAPTERS.md, "Twin gate"). CodeDeploy's own canary shifts traffic from the warm
// production task set to a cold new one, which violates the premise at start-up; configure the
// listener with three target groups rather than pointing the hook at CodeDeploy's two.
//
// DURATION. A Lambda runs at most 15 minutes and a CodeDeploy hook times out after 1 hour.
// max_ticks * tickMs + settleMs must fit the Lambda timeout, or the hook stops early at the
// deadline and reports "hold". Longer analyses belong in a longer-lived runner calling this
// same function.

import { PutLifecycleEventHookExecutionStatusCommand } from '@aws-sdk/client-codedeploy';
import type { PutLifecycleEventHookExecutionStatusCommandOutput } from '@aws-sdk/client-codedeploy';

import type { MetricSource } from '../../service/sources/metric-source';
import type {
  TwinArmBody, TwinGateVerdict, TwinSessionResponse, TwinTickBody, TwinTickResponse,
} from '../../service/sources/twin-contract';

/** The slice of CodeDeployClient this hook uses; a CodeDeployClient satisfies it. */
export interface CodeDeployLike {
  send(
    command: PutLifecycleEventHookExecutionStatusCommand, options?: { abortSignal?: AbortSignal },
  ): Promise<PutLifecycleEventHookExecutionStatusCommandOutput>;
}

/** The slice of TwinGateClient this hook uses. */
export interface TwinGateLike {
  openSession(twinArm: TwinArmBody, signal?: AbortSignal): Promise<TwinSessionResponse>;
  tick(sessionId: string, body: TwinTickBody, signal?: AbortSignal): Promise<TwinTickResponse>;
}

export interface AfterAllowTrafficDeps {
  codedeploy: CodeDeployLike;
  gate: TwinGateLike;
  source: MetricSource;
  twinArm: TwinArmBody;
  /** Tick length; windows are aligned to multiples of it (CloudWatch needs a multiple of 60 s). */
  tickMs: number;
  /** Wait after a window closes before fetching it (CloudWatch ALB metrics lag 1–3 min). Default 0. */
  settleMs?: number;
  /** Time kept back for the Put: calls are cut this long before the Lambda deadline. Default 30 s. */
  safetyMs?: number;
  /** Time a window needs after it closes for its fetch and tick; no window starts without it. Default 10 s. */
  tickReserveMs?: number;
  /** Upper bound on each gate or source call, with or without a Lambda context. Default 60 s. */
  callTimeoutMs?: number;
  /** PutLifecycleEventHookExecutionStatus attempts. Default 3. */
  putAttempts?: number;
  /** Bound on each Put attempt. Default 5 s. */
  putTimeoutMs?: number;
  /** Wait before Put retry n is putBackoffMs * n. Default 500 ms. */
  putBackoffMs?: number;
  /** Default false. Only honoured when the gate's response authority is not "advisory". */
  enforce?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
}

export interface AfterAllowTrafficEvent {
  DeploymentId: string;
  LifecycleEventHookExecutionId: string;
}

export interface LambdaContextLike {
  getRemainingTimeInMillis(): number;
}

export type HookStatus = 'Succeeded' | 'Failed';

export interface AfterAllowTrafficOutcome {
  status: HookStatus;
  verdict: TwinGateVerdict | 'error';
  ticks: number;
  /** The authority the gate last stated, or null when no tick response arrived. */
  authority: string | null;
  reason: string;
  /** Whether a PutLifecycleEventHookExecutionStatus call succeeded. */
  reported: boolean;
}

interface RunResult {
  verdict: TwinGateVerdict | 'error';
  ticks: number;
  authority: string | null;
  error?: string;
}

export function createAfterAllowTrafficHandler(deps: AfterAllowTrafficDeps) {
  if (!(deps.tickMs > 0)) throw new Error(`after-allow-traffic: tickMs must be positive, got ${deps.tickMs}`);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));
  const settleMs = deps.settleMs ?? 0;
  const safetyMs = deps.safetyMs ?? 30_000;
  const tickReserveMs = deps.tickReserveMs ?? 10_000;
  const callTimeoutMs = deps.callTimeoutMs ?? 60_000;
  const putAttempts = Math.max(1, deps.putAttempts ?? 3);
  const putTimeoutMs = deps.putTimeoutMs ?? 5_000;
  const putBackoffMs = deps.putBackoffMs ?? 500;

  const hasTimeFor = (windowEnd: number, ctx?: LambdaContextLike): boolean =>
    !ctx || ctx.getRemainingTimeInMillis() >= windowEnd + settleMs - now() + tickReserveMs + safetyMs;

  /** Time a gate or source call may take now. */
  const callBudget = (ctx?: LambdaContextLike): number =>
    ctx ? Math.min(callTimeoutMs, ctx.getRemainingTimeInMillis() - safetyMs) : callTimeoutMs;

  async function run(event: AfterAllowTrafficEvent, ctx: LambdaContextLike | undefined, r: RunResult): Promise<void> {
    const session = await bounded('gate openSession', callBudget(ctx), (signal) => deps.gate.openSession(deps.twinArm, signal));
    log({ event: 'twin_gate_session', deployment_id: event.DeploymentId, session_id: session.session_id });
    let start = Math.ceil(now() / deps.tickMs) * deps.tickMs;
    while (r.ticks < deps.twinArm.max_ticks && hasTimeFor(start + deps.tickMs, ctx)) {
      const end = start + deps.tickMs;
      const wait = end + settleMs - now();
      if (wait > 0) await sleep(wait);
      const body = await bounded('source fetchTick', callBudget(ctx), (signal) => deps.source.fetchTick(start, end, signal));
      const res = await bounded('gate tick', callBudget(ctx), (signal) => deps.gate.tick(session.session_id, body, signal));
      r.ticks += 1;
      r.authority = res.authority;
      r.verdict = res.verdict;
      log({ event: 'twin_gate_tick', deployment_id: event.DeploymentId, tick: res.tick, verdict: res.verdict,
        engine_verdict: res.engine_verdict, authority: res.authority, srm_e: res.srm_e, metrics: res.metrics });
      if (res.verdict !== 'extend') return;
      start = end;
    }
    r.verdict = 'hold'; // extend at max_ticks or at the deadline: no decision reached
  }

  return async function handler(event: AfterAllowTrafficEvent, ctx?: LambdaContextLike): Promise<AfterAllowTrafficOutcome> {
    const r: RunResult = { verdict: 'extend', ticks: 0, authority: null };
    try {
      await run(event, ctx, r);
    } catch (e) {
      r.verdict = 'error';
      r.error = e instanceof Error ? e.message : String(e);
      log({ event: 'twin_gate_error', deployment_id: event.DeploymentId, error: r.error });
    }
    const { status, reason } = decideStatus(r, deps.enforce === true);
    log({ event: 'twin_gate_final', deployment_id: event.DeploymentId, verdict: r.verdict, ticks: r.ticks,
      authority: r.authority, status, reason });
    const reported = await put(event, status, ctx);
    return { status, verdict: r.verdict, ticks: r.ticks, authority: r.authority, reason, reported };
  };

  async function put(event: AfterAllowTrafficEvent, status: HookStatus, ctx?: LambdaContextLike): Promise<boolean> {
    const command = new PutLifecycleEventHookExecutionStatusCommand({
      deploymentId: event.DeploymentId,
      lifecycleEventHookExecutionId: event.LifecycleEventHookExecutionId,
      status,
    });
    for (let attempt = 1; attempt <= putAttempts; attempt++) {
      if (attempt > 1) {
        const backoff = putBackoffMs * (attempt - 1);
        if (ctx && ctx.getRemainingTimeInMillis() - backoff <= 0) break;
        await sleep(backoff);
      }
      const budget = ctx ? Math.min(putTimeoutMs, ctx.getRemainingTimeInMillis()) : putTimeoutMs;
      if (!(budget > 0)) break;
      try {
        await bounded('PutLifecycleEventHookExecutionStatus', budget,
          (signal) => deps.codedeploy.send(command, { abortSignal: signal }));
        return true;
      } catch (e) {
        log({ event: 'twin_gate_put_error', deployment_id: event.DeploymentId, attempt, status,
          error: e instanceof Error ? e.message : String(e) });
      }
    }
    return false;
  }
}

/**
 * Run `call` with an AbortSignal and reject once `ms` passes, aborting the signal. A call that
 * ignores the signal is abandoned; the caller does not wait for it.
 */
export async function bounded<T>(label: string, ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!(ms > 0)) throw new Error(`${label}: timed out (no time left before the deadline)`);
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label}: timed out after ${ms} ms`);
      ac.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => call(ac.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Advisory unless enforce is set AND the gate itself stated a non-advisory authority. */
export function decideStatus(r: Pick<RunResult, 'verdict' | 'authority'>, enforce: boolean): { status: HookStatus; reason: string } {
  if (!enforce) return { status: 'Succeeded', reason: 'advisory: enforce is off; verdict logged only' };
  if (r.authority === null || r.authority === 'advisory') {
    return { status: 'Succeeded', reason: `advisory: enforce requested but gate authority is ${r.authority ?? 'unknown'}` };
  }
  if (r.verdict === 'proceed') return { status: 'Succeeded', reason: `enforced (${r.authority}): proceed` };
  return { status: 'Failed', reason: `enforced (${r.authority}): ${r.verdict}` };
}
