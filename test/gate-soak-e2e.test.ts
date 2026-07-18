// test/gate-soak-e2e.test.ts — R5 live shadow soak, Task 9: full
// lifecycle drill, in-process (no child processes — same pattern as
// test/gate-e2e-argo-loop.test.ts: real http.request() against a
// createGateServer() instance on port 0), driving the CLI handlers
// directly (no child_process, matching test/recalibration-cli.test.ts).
//
// Sequence: runInit + seed active.json -> runPropose (a candidate whose
// p99_latency is proposed WORSE than active, so it classifies as
// 'degradation' rather than auto-promoting 'improvement' — R5 needs a
// candidate that reaches 'reviewable' and STAYS there, per plan Task 9)
// -> runShadow --dry-run => reviewable (mandatory replay validation) ->
// runSoakStart with a small target_ticks -> createGateServer over the
// SAME baselineHistoryDir -> begin one session, POST target_ticks live
// ticks -> assert the sidecar reaches status:'complete' and the
// recalibration store's events.jsonl carries exactly one
// recalibration.soak_completed line -> runSoakStop folds the evidence
// onto CandidateRecord.soak -> runShow's output carries BOTH evidence
// blocks (shadow_report_path from the mandatory replay validation AND
// the SOAK (folded) summary line) -> runApprove still succeeds
// afterward (soak never gates review_status, R-Q4).
//
// The active + candidate CompiledConfigs here are deliberately NOT
// runs/compiled-configs/v1-legacy-equivalent.json (that fixture carries
// ONLY family_B cutoffs, no baseline_cells — it fails
// evaluateReadinessGates's signals_comparable gate outright, verified
// during implementation). Instead both configs share the
// baseline_cells/family_A+family_C shape used throughout
// test/recalibration-cli.test.ts's `makeConfig`, with the ACTIVE
// config's own baseline_mean set to exactly this file's BASELINE
// fixture value — so served ticks under BASELINE metrics carry a
// deviation of zero and never spuriously fire, without needing to
// re-derive v1-legacy-equivalent.json's specific tuned-threshold
// behavior (which test/gate-e2e-argo-loop.test.ts already covers).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createGateServer } from '../service/gate-http/server';
import type { GateServerHandle } from '../service/gate-http/server';
import type { GateHttpConfig } from '../service/gate-http/_gate-config';

import {
  runInit, runPropose, runShadow, runShow, runApprove,
} from '../tools/recalibrate/_recalibrate-cli';
import { runSoakStart, runSoakStop } from '../tools/recalibrate/_recalibrate-soak-cli';
import { readSoakSidecar } from '../tools/recalibrate/_recalibrate-soak';
import { RecalibrationStore, type ActivePointer } from '../tools/recalibrate/_recalibrate-store';
import { InMemoryLifecycleEventEmitter } from '../engine/o0/lifecycle-events';
import type { CompiledConfig } from '../engine/types';

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const BASELINE: Record<string, number> = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

function makeConfig(version: string, p99Mean: number): CompiledConfig {
  return {
    version,
    compiler_version: '0.3.0',
    compiled_at: '2026-07-01T00:00:00.000Z',
    baseline_ref: 'synthetic-v1@seed=42',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, C: 2e-4 } },
    family_c_signals: ['p99_latency'],
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{ key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' }],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: p99Mean, baseline_sigma_squared: 100, tau_squared: 100, delta_min: 5,
            },
          },
        },
        family_C: { mean_vector: [p99Mean], covariance: [[100]] },
      },
    },
  } as CompiledConfig;
}

function writeConfig(dir: string, name: string, cfg: CompiledConfig): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

interface JsonResp { status: number; json: any }

function req(baseUrl: string, method: string, urlPath: string, body?: unknown): Promise<JsonResp> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const r = http.request(baseUrl + urlPath, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode!, json: raw ? JSON.parse(raw) : undefined });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

async function listen(handle: GateServerHandle): Promise<string> {
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const port = (handle.server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

test('e2e: propose -> shadow-validate -> soak start -> live ticks -> soak stop -> show carries both evidence blocks -> approve still succeeds', async () => {
  const storeDir = tmpRoot('ds-gate-soak-e2e-store-');
  const baselineHistoryDir = tmpRoot('ds-gate-soak-e2e-baseline-');
  const serviceId = 'svc-soak-e2e';
  const NOW = Math.floor(Date.now() / 1000);

  runInit({ root: baselineHistoryDir, serviceId });
  const store = new RecalibrationStore(path.join(baselineHistoryDir, serviceId));
  const emitter = new InMemoryLifecycleEventEmitter();

  // Active baseline: baseline_mean === this file's BASELINE.p99_latency
  // exactly, so served ticks fed BASELINE metrics carry a zero
  // deviation and the session bakes cleanly for as many ticks as we
  // choose to post.
  const activeConfig = makeConfig('v1-e2e-active@seed=1', BASELINE.p99_latency);
  const activeConfigPath = writeConfig(store.dir, 'active-config.json', activeConfig);
  const activePointer: ActivePointer = {
    schema_version: '1',
    version_id: 'v1-e2e-active@seed=1',
    candidate_id: null,
    compiled_config_path: activeConfigPath,
    baseline_ref: 'e2e@v1',
    promoted_at: '2026-06-01T00:00:00.000Z',
    predecessor_version_id: null,
    promotion_history: [],
  };
  fs.writeFileSync(path.join(store.dir, 'active.json'), JSON.stringify(activePointer));

  // Candidate: p99_latency proposed WORSE (1.5x) -> 'degradation', so
  // shadow-validation lands it in 'reviewable', not auto-promoted.
  const candidateConfig = makeConfig('v2-e2e-candidate@seed=2', BASELINE.p99_latency * 1.5);
  const candidateConfigPath = writeConfig(store.dir, 'candidate-config.json', candidateConfig);

  const proposeResult = await runPropose(store, emitter, {
    candidateId: 'cand-soak-e2e',
    candidateConfigPath,
    creationReason: 'operator_manual',
    sourceWindow: { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', n_samples: 100 },
    now: '2026-07-01T00:00:00.000Z',
  });
  assert.equal(proposeResult.exitCode, 0);
  assert.equal(store.readCandidate('cand-soak-e2e').review_status, 'pending_shadow');

  const shadowResult = await runShadow(store, emitter, {
    candidateId: 'cand-soak-e2e',
    scenarios: ['anthropic_tpu_output_corruption_step_2025_09'],
    seeds: [42],
    outputDir: path.join(store.dir, 'shadow-out'),
    dryRun: true,
    now: '2026-07-05T00:00:00.000Z',
  });
  assert.equal(shadowResult.exitCode, 0);
  const afterShadow = store.readCandidate('cand-soak-e2e');
  assert.equal(afterShadow.review_status, 'reviewable', 'mandatory replay validation lands the candidate in reviewable, not decided');
  assert.ok(afterShadow.shadow_report_path, 'replay validation evidence is present');

  const TARGET_TICKS = 3;
  const soakStartResult = runSoakStart(store, {
    candidateId: 'cand-soak-e2e', requestedBy: 'op-soak', targetTicks: TARGET_TICKS, now: '2026-07-06T00:00:00.000Z',
  });
  assert.equal(soakStartResult.exitCode, 0);

  const cfg: GateHttpConfig = {
    port: 0,
    bind: '127.0.0.1',
    sharedSecret: null,
    storeDir,
    baselineHistoryDir,
    serviceId,
    failPolicy: 'fail_closed',
    mode: 'enforce',
    totalTicksDefault: 50, // generous headroom past TARGET_TICKS so the session never terminates mid-soak
    sessionTtlSeconds: 3600,
    requestTimeoutMs: 4000,
    auditDir: path.join(storeDir, serviceId, 'audit'),
  };

  let handle: GateServerHandle | undefined;
  try {
    handle = createGateServer(cfg);
    const baseUrl = await listen(handle);

    const begin = await req(baseUrl, 'POST', '/v1/sessions', {
      deploy_ref: 'deploy-soak-e2e', requested_at_ts: NOW, scenario: { baseline: BASELINE },
    });
    assert.equal(begin.status, 201);
    assert.equal(begin.json.config_source, 'lifecycle_store');
    const sessionId = begin.json.session_id;

    for (let i = 0; i < TARGET_TICKS; i++) {
      const tick = await req(baseUrl, 'POST', `/v1/sessions/${sessionId}/ticks`, {
        emitted_at_ts: NOW + i * 30, metrics: BASELINE,
      });
      assert.equal(tick.status, 200);
      assert.equal(tick.json.error, undefined, `served tick ${i} must not error under zero-deviation BASELINE metrics`);
    }

    const sidecar = readSoakSidecar(store.dir, 'cand-soak-e2e');
    assert.ok(sidecar, 'the soak controller observed at least one tick');
    assert.equal(sidecar!.status, 'complete');
    assert.equal(sidecar!.stats.ticks_observed, TARGET_TICKS);

    const storedEvents = store.readEvents();
    const completions = storedEvents.filter((e) => e.type === 'recalibration.soak_completed');
    assert.equal(completions.length, 1, 'exactly one recalibration.soak_completed line in the recalibration store\'s events.jsonl');
    assert.equal((completions[0].payload as { candidate_id: string }).candidate_id, 'cand-soak-e2e');
  } finally {
    if (handle) await handle.close();
  }

  const soakStopResult = runSoakStop(store, { candidateId: 'cand-soak-e2e', reviewer: 'op-soak', now: '2026-07-07T00:00:00.000Z' });
  assert.equal(soakStopResult.exitCode, 0);

  const foldedRec = store.readCandidate('cand-soak-e2e');
  assert.ok(foldedRec.soak, 'soak stop folded evidence onto CandidateRecord.soak');
  assert.equal(foldedRec.soak!.sidecar.status, 'complete');
  assert.equal(foldedRec.soak!.stopped_early, false, 'the soak reached target_ticks before being stopped');
  assert.equal(foldedRec.review_status, 'reviewable', 'folding soak evidence does not gate review_status — R-Q4');

  const showResult = await runShow(store, emitter, 'cand-soak-e2e', '2026-07-07T00:05:00.000Z');
  assert.equal(showResult.exitCode, 0);
  const joined = showResult.lines.join('\n');
  assert.ok(joined.includes('"shadow_report_path"'), 'show output carries the replay-validation evidence block');
  assert.ok(joined.includes('SOAK (folded)'), 'show output carries the folded live-soak evidence block');
  assert.ok(showResult.lines.some((l) => l.startsWith('SOAK (folded):') && l.includes('3/3 ticks')));

  const approveResult = await runApprove(store, emitter, {
    candidateId: 'cand-soak-e2e', reviewer: 'op-approve', reasonCode: 'regression', now: '2026-07-08T00:00:00.000Z',
  });
  assert.equal(approveResult.exitCode, 0, 'soak never gates — approve succeeds normally with soak evidence present');

  const approved = store.readCandidate('cand-soak-e2e');
  assert.equal(approved.status, 'active');
  assert.equal(approved.review_status, 'decided');
  assert.equal(approved.outcome, 'operator_approved');
  assert.ok(approved.soak, 'the folded soak evidence survives the approve transition (additive field, spread-based transition)');
  assert.equal(store.readActive()!.version_id, 'v2-e2e-candidate@seed=2');
});
