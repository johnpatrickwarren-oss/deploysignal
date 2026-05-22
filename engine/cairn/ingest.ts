// engine/cairn/ingest.ts — Cairn audit-stream ingest helpers (PRD-30 AC-3).
//
// Pure functions over the existing wire shapes (DS audit JSONL, Tessera
// VerdictGroupPayload, Anvil ExpectedFailurePattern, generic external
// events). No new schema introduced at Cairn v1; the consumer side reads
// only the fields named in each minimal-shape interface below, so the
// ingest helpers remain loosely coupled to the source-side types.

import type { AttributionCandidate } from './types';

/** Minimal DS audit-record shape Cairn reads. */
export interface MinimalDsRecord {
  deploy_id?: string;
  ts?: number;
  verdict?: 'proceed' | 'extend' | 'rollback' | 'baking';
  alpha_consumed?: number;
  alpha_budget?: number;
  config_version?: string;
}

export function candidatesFromDsAudit(records: MinimalDsRecord[]): AttributionCandidate[] {
  const out: AttributionCandidate[] = [];
  for (const r of records) {
    if (!r.deploy_id || r.ts === undefined) continue;
    const ratio =
      r.alpha_consumed !== undefined && r.alpha_budget !== undefined && r.alpha_budget > 0
        ? r.alpha_consumed / r.alpha_budget
        : undefined;
    out.push({
      cause_id: `deploy:${r.deploy_id}`,
      cause_kind: 'deploy',
      timestamp_unix: r.ts,
      evidence_ref: `ds-audit:${r.deploy_id}@${r.ts}${r.config_version ? '#' + r.config_version : ''}`,
      metadata: {
        ds_verdict: r.verdict,
        ds_alpha_consumed_ratio: ratio,
      },
    });
  }
  return out;
}

/** Minimal Tessera VerdictGroupPayload shape Cairn reads. */
export interface MinimalTesseraPayload {
  group_id?: string;
  shard_id?: string;
  event_ts?: number;
  verdict?: string;
}

export function candidatesFromTesseraFeed(
  payloads: MinimalTesseraPayload[],
): AttributionCandidate[] {
  const out: AttributionCandidate[] = [];
  for (const p of payloads) {
    if (!p.group_id || p.event_ts === undefined) continue;
    out.push({
      cause_id: `tessera-shard:${p.shard_id ?? 'unknown'}:${p.group_id}`,
      cause_kind: 'shard_event',
      timestamp_unix: p.event_ts,
      evidence_ref: `tessera-verdict-group:${p.group_id}`,
      metadata: {
        extra: { tessera_verdict: p.verdict, shard_id: p.shard_id },
      },
    });
  }
  return out;
}

/** Minimal Anvil ExpectedFailurePattern record Cairn reads. */
export interface MinimalAnvilExperiment {
  experiment_id: string;
  fault_start_unix: number;
  kind: string;
  affected_signals?: string[];
  recovery_seconds?: number;
}

export function candidatesFromAnvilExperiments(
  experiments: MinimalAnvilExperiment[],
): AttributionCandidate[] {
  return experiments.map((e) => ({
    cause_id: `chaos:${e.experiment_id}`,
    cause_kind: 'chaos_experiment',
    timestamp_unix: e.fault_start_unix,
    evidence_ref: `anvil-experiment:${e.experiment_id}`,
    metadata: {
      expected_failure_kind: e.kind,
      extra: {
        affected_signals: e.affected_signals,
        recovery_seconds: e.recovery_seconds,
      },
    },
  }));
}

/** Generic external-event shape; webhook payloads from incident-mgmt
 *  systems, env-change feeds, etc. land here. Production-grade adapters
 *  for PagerDuty / Opsgenie / incident.io are Slice 2 (PRD-30 AS-1). */
export interface ExternalEvent {
  event_id: string;
  timestamp_unix: number;
  event_kind: 'dependency_change' | 'env_change' | 'generic';
  description?: string;
  source?: string;
}

export function candidatesFromExternalEvents(
  events: ExternalEvent[],
): AttributionCandidate[] {
  return events.map((e) => ({
    cause_id: `external:${e.event_id}`,
    cause_kind: e.event_kind,
    timestamp_unix: e.timestamp_unix,
    evidence_ref: `${e.source ?? 'external'}:${e.event_id}`,
    metadata: {
      extra: { description: e.description, source: e.source },
    },
  }));
}
