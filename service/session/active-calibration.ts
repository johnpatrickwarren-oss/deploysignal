// service/session/active-calibration.ts — Task 5 (WS4 session-durability-
// argo plan): read-only consumer of the (unlanded) Addition #15 §B store
// contract (`/Users/johnwarren/concord/repo-reviews/deploysignal-addition-15-IMPLEMENTATION_PLAN.md`,
// investigation finding #8).
//
// Reads exactly `<baselineHistoryDir>/<service_id>/active.json` —
// `{schema_version, version_id, compiled_config_path, baseline_ref,
// promoted_at, predecessor_version_id, promotion_history[]}` — plus the
// `compiled_config_path` JSON it points at. Nothing else: candidates/,
// events.jsonl, and all promotion/candidate logic belong to the
// Addition #15 store itself and are not duplicated here.
//
// Pinning (mirrors Addition #15 D4 "deploys pin compiled_config_version
// at start and never re-resolve mid-deploy"): this function is called
// exactly once, at session begin. The caller (Task 6's
// GateSessionRuntime) stores the result on the SessionRecord
// (`active_calibration_version`, `compiled_config_path`) and holds the
// loaded CompiledConfig in its session runtime for the session's
// lifetime — a later promotion (active.json swapped atomically) is
// invisible to an already-begun session; only a NEW session picks it up.

import * as fs from 'fs';
import * as path from 'path';

import type { CompiledConfig } from '../../engine/types';

export interface ActiveCalibration {
  version_id: string;
  compiled_config_path: string;
  baseline_ref: string | null;
  config: CompiledConfig;
}

/** Failure modes: active.json unreadable/invalid JSON, unknown
 *  schema_version, or a missing/unloadable compiled_config_path.
 *  Absence of active.json itself is NOT an error (see
 *  resolveActiveCalibration's null return) — it's the expected shape
 *  for a repo that hasn't landed Addition #15 yet. */
export class ActiveCalibrationError extends Error {
  constructor(message: string) {
    super(`active-calibration: ${message}`);
    this.name = 'ActiveCalibrationError';
  }
}

interface ActiveJsonContract {
  schema_version: string;
  version_id: string;
  compiled_config_path: string;
  baseline_ref: string | null;
  promoted_at?: string;
  predecessor_version_id?: string | null;
  promotion_history?: unknown[];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function resolveActiveCalibration(
  baselineHistoryDir: string,
  serviceId: string,
): ActiveCalibration | null {
  const activePath = path.join(baselineHistoryDir, serviceId, 'active.json');

  let raw: string;
  try {
    raw = fs.readFileSync(activePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // pre-#15 repo, not an error
    throw new ActiveCalibrationError(`unreadable ${activePath}: ${errMsg(e)}`);
  }

  let parsed: ActiveJsonContract;
  try {
    parsed = JSON.parse(raw) as ActiveJsonContract;
  } catch (e) {
    throw new ActiveCalibrationError(`invalid JSON in ${activePath}: ${errMsg(e)}`);
  }

  if (parsed.schema_version !== '1') {
    throw new ActiveCalibrationError(
      `unexpected schema_version in ${activePath}: ${JSON.stringify(parsed.schema_version)}`,
    );
  }
  if (!parsed.compiled_config_path) {
    throw new ActiveCalibrationError(`missing compiled_config_path in ${activePath}`);
  }

  let configRaw: string;
  try {
    configRaw = fs.readFileSync(parsed.compiled_config_path, 'utf8');
  } catch (e) {
    throw new ActiveCalibrationError(
      `unloadable compiled_config_path ${parsed.compiled_config_path} (from ${activePath}): ${errMsg(e)}`,
    );
  }

  let config: CompiledConfig;
  try {
    config = JSON.parse(configRaw) as CompiledConfig;
  } catch (e) {
    throw new ActiveCalibrationError(
      `invalid JSON at compiled_config_path ${parsed.compiled_config_path}: ${errMsg(e)}`,
    );
  }

  return {
    version_id: parsed.version_id,
    compiled_config_path: parsed.compiled_config_path,
    baseline_ref: parsed.baseline_ref ?? null,
    config,
  };
}
