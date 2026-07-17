// test/active-calibration-resolve.test.ts — Task 5 (WS4
// session-durability-argo plan): resolveActiveCalibration(), a
// read-only consumer of the (unlanded) Addition #15 §B store contract.
// Reads exactly `<baselineHistoryDir>/<service_id>/active.json` and the
// `compiled_config_path` JSON it points at — nothing else (no
// candidates/, events.jsonl, or promotion logic duplicated here).
//
// Pinning (Addition #15 D4 mirror, this plan's own contract): resolved
// exactly once at session begin; a mid-session atomic swap of
// active.json (tmp+rename, simulating a real promotion) must not affect
// an already-begun session's pinned config. A NEW session begun after
// the swap resolves the new version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ActiveCalibrationError, resolveActiveCalibration,
} from '../service/session/active-calibration';
import { SessionStore } from '../service/session/session-store';
import type { BeginSessionInput } from '../service/session/types';

const ROOT = path.resolve(__dirname, '..');
const V4_CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

function tmpBaselineHistoryDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ds-active-calib-'));
}

function writeActiveJson(
  baselineHistoryDir: string,
  serviceId: string,
  fields: Record<string, unknown>,
): string {
  const serviceDir = path.join(baselineHistoryDir, serviceId);
  fs.mkdirSync(serviceDir, { recursive: true });
  const activePath = path.join(serviceDir, 'active.json');
  fs.writeFileSync(activePath, JSON.stringify(fields, null, 2));
  return activePath;
}

function atomicSwap(activePath: string, fields: Record<string, unknown>): void {
  const tmp = `${activePath}.tmp-swap`;
  fs.writeFileSync(tmp, JSON.stringify(fields, null, 2));
  fs.renameSync(tmp, activePath);
}

function baseActiveFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    version_id: 'v1',
    compiled_config_path: V4_CONFIG_PATH,
    baseline_ref: 'synthetic-v1@seed=42',
    promoted_at: '2026-01-01T00:00:00.000Z',
    predecessor_version_id: null,
    promotion_history: [],
    ...overrides,
  };
}

test('resolves version + parsed config from a hand-built active.json', () => {
  const dir = tmpBaselineHistoryDir();
  writeActiveJson(dir, 'svc-a', baseActiveFields());

  const resolved = resolveActiveCalibration(dir, 'svc-a');
  assert.ok(resolved);
  assert.equal(resolved!.version_id, 'v1');
  assert.equal(resolved!.compiled_config_path, V4_CONFIG_PATH);
  assert.equal(resolved!.baseline_ref, 'synthetic-v1@seed=42');
  assert.equal(resolved!.config.version, 'v4-fusion-novelty');
  assert.ok(resolved!.config.alpha_budget, 'CompiledConfig fields present on .config');
});

test('absent active.json returns null (pre-#15 repos)', () => {
  const dir = tmpBaselineHistoryDir();
  assert.equal(resolveActiveCalibration(dir, 'svc-no-active'), null);
});

test('bad schema_version throws ActiveCalibrationError', () => {
  const dir = tmpBaselineHistoryDir();
  writeActiveJson(dir, 'svc-a', baseActiveFields({ schema_version: '99' }));
  assert.throws(() => resolveActiveCalibration(dir, 'svc-a'), ActiveCalibrationError);
});

test('invalid JSON in active.json throws ActiveCalibrationError', () => {
  const dir = tmpBaselineHistoryDir();
  const serviceDir = path.join(dir, 'svc-a');
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(path.join(serviceDir, 'active.json'), '{ not valid json');
  assert.throws(() => resolveActiveCalibration(dir, 'svc-a'), ActiveCalibrationError);
});

test('dangling compiled_config_path throws ActiveCalibrationError', () => {
  const dir = tmpBaselineHistoryDir();
  writeActiveJson(dir, 'svc-a', baseActiveFields({
    compiled_config_path: path.join(dir, 'nonexistent-compiled-config.json'),
  }));
  assert.throws(() => resolveActiveCalibration(dir, 'svc-a'), ActiveCalibrationError);
});

test('malformed JSON at compiled_config_path throws ActiveCalibrationError', () => {
  const dir = tmpBaselineHistoryDir();
  const badConfigPath = path.join(dir, 'bad-config.json');
  fs.writeFileSync(badConfigPath, 'not json at all');
  writeActiveJson(dir, 'svc-a', baseActiveFields({ compiled_config_path: badConfigPath }));
  assert.throws(() => resolveActiveCalibration(dir, 'svc-a'), ActiveCalibrationError);
});

// ────────────────────────────────────────────────────────────────────
// Pinning: resolved once at begin; a mid-session promotion must not
// affect the already-begun session.
// ────────────────────────────────────────────────────────────────────

test('pinning: mid-session active.json swap does not affect the already-begun session; a new session resolves v2', () => {
  const baselineDir = tmpBaselineHistoryDir();
  const activePath = writeActiveJson(baselineDir, 'svc-a', baseActiveFields({ version_id: 'v1' }));

  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-active-calib-sessions-'));
  const store = SessionStore.init(sessionRoot, 'svc-a');

  // Session 1 begins: resolves + pins v1.
  const resolvedAtBegin1 = resolveActiveCalibration(baselineDir, 'svc-a');
  assert.ok(resolvedAtBegin1);
  assert.equal(resolvedAtBegin1!.version_id, 'v1');

  const beginInput1: BeginSessionInput = {
    session_id: 'sess-deploy-1-1700000000',
    service_id: 'svc-a',
    deploy_id: 'deploy-1',
    deploy_ref: 'deploy-1',
    mode: 'enforce',
    fail_policy: 'fail_closed',
    active_calibration_version: resolvedAtBegin1!.version_id,
    compiled_config_path: resolvedAtBegin1!.compiled_config_path,
    baseline_ref: resolvedAtBegin1!.baseline_ref,
    total_ticks: 60,
    begun_request_ts: 1_700_000_000,
    begun_at: new Date(1_700_000_000 * 1000).toISOString(),
    deployment: { phase: 'baking', start_time_ms: 1_700_000_000_000, cloud: 'primary' },
    scenario: {
      risk_level: 'medium', change_type: 'serving_code', author: 'human', time_window: 'ok',
      flags: {}, baseline: { p99_latency: 185 },
    },
  };
  const session1 = store.beginSession(beginInput1);
  assert.equal(session1.active_calibration_version, 'v1');

  // Mid-session atomic promotion: active.json swapped to v2 (a
  // different real compiled config so the parsed .version differs).
  const v2ConfigPath = path.join(ROOT, 'runs', 'compiled-configs', 'v1-legacy-equivalent.json');
  atomicSwap(activePath, baseActiveFields({
    version_id: 'v2', compiled_config_path: v2ConfigPath, predecessor_version_id: 'v1',
  }));

  // The already-begun session's pinned record is untouched.
  const rereadSession1 = store.getSession(session1.session_id)!;
  assert.equal(rereadSession1.active_calibration_version, 'v1');
  assert.equal(rereadSession1.compiled_config_path, V4_CONFIG_PATH);

  // A NEW session begun after the swap resolves v2.
  const resolvedAtBegin2 = resolveActiveCalibration(baselineDir, 'svc-a');
  assert.ok(resolvedAtBegin2);
  assert.equal(resolvedAtBegin2!.version_id, 'v2');
  assert.equal(resolvedAtBegin2!.compiled_config_path, v2ConfigPath);
  assert.equal(resolvedAtBegin2!.config.version, 'v1-legacy-equivalent');

  const beginInput2: BeginSessionInput = {
    ...beginInput1,
    session_id: 'sess-deploy-2-1700000100',
    deploy_id: 'deploy-2',
    deploy_ref: 'deploy-2',
    active_calibration_version: resolvedAtBegin2!.version_id,
    compiled_config_path: resolvedAtBegin2!.compiled_config_path,
    baseline_ref: resolvedAtBegin2!.baseline_ref,
    begun_request_ts: 1_700_000_100,
  };
  const session2 = store.beginSession(beginInput2);
  assert.equal(session2.active_calibration_version, 'v2');
  assert.equal(session2.compiled_config_path, v2ConfigPath);
});
