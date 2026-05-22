// engine/cairn/score.ts — Cairn alignment scoring (Q30 § Architectural
// mechanism §2). Pure functions. No engine/detectors/* touch.

import type {
  AttributionCandidate, CandidateKind, IncidentDefinition,
  CairnScoringConfig, ScoredCandidate, SuppressedCandidate,
  RankedAttribution,
} from './types';

const DEFAULT_KERNEL_SIGMA_SECONDS: Record<CandidateKind, number> = {
  deploy: 30 * 60,             //  30 minutes
  chaos_experiment: 5 * 60,    //   5 minutes
  dependency_change: 2 * 3600, //   2 hours
  env_change: 6 * 3600,        //   6 hours
  shard_event: 15 * 60,        //  15 minutes
  generic: 1 * 3600,           //   1 hour
};

const DEFAULT_KIND_PRIOR: Record<CandidateKind, number> = {
  deploy: 0.35,
  chaos_experiment: 0.20,
  dependency_change: 0.15,
  env_change: 0.10,
  shard_event: 0.10,
  generic: 0.10,
};

const DEFAULT_EVIDENCE_BOOST: Record<'proceed' | 'extend' | 'rollback' | 'baking', number> = {
  proceed: 0.5,   // negative evidence — engine emitted clean
  extend: 1.5,    // engine was concerned
  rollback: 2.0,  // engine flagged; operator overrode and shipped anyway
  baking: 1.0,    // engine hadn't decided yet — neutral
};

const DEFAULT_GRACE_SECONDS = 60;
const KERNEL_UNDERFLOW = 1e-12;

function gaussianKernel(deltaSeconds: number, sigmaSeconds: number): number {
  const z = deltaSeconds / sigmaSeconds;
  return Math.exp(-0.5 * z * z);
}

function effectiveConfig(config: CairnScoringConfig): RankedAttribution['config_used'] {
  return {
    kernel_sigma_seconds: {
      ...DEFAULT_KERNEL_SIGMA_SECONDS,
      ...(config.kernel_sigma_seconds ?? {}),
    } as Record<CandidateKind, number>,
    kind_prior: {
      ...DEFAULT_KIND_PRIOR,
      ...(config.kind_prior ?? {}),
    } as Record<CandidateKind, number>,
    grace_seconds: config.grace_seconds ?? DEFAULT_GRACE_SECONDS,
    evidence_boost: {
      ...DEFAULT_EVIDENCE_BOOST,
      ...(config.evidence_boost ?? {}),
    },
  };
}

function evidenceBoostFor(
  candidate: AttributionCandidate,
  evidence_boost: Record<'proceed' | 'extend' | 'rollback' | 'baking', number>,
): number {
  const v = candidate.metadata?.ds_verdict;
  if (v && v in evidence_boost) {
    let boost = evidence_boost[v];
    // Negative-evidence sharpening (Q30.3): a `proceed` with very low α
    // consumed is stronger "this isn't the cause" than a `proceed` with
    // moderate α consumption.
    if (v === 'proceed' && candidate.metadata?.ds_alpha_consumed_ratio !== undefined) {
      const ratio = candidate.metadata.ds_alpha_consumed_ratio;
      if (ratio < 0.05) boost *= 0.75;
    }
    return boost;
  }
  return 1.0;
}

export interface ScoreBreakdown {
  raw_score: number;
  kernel_value: number;
  kind_prior: number;
  evidence_boost: number;
  suppressed: SuppressedCandidate | null;
}

/** Score one candidate against the incident. Returns the raw unnormalized
 *  score; `rankCandidates` does cross-candidate normalization. */
export function scoreCandidate(
  candidate: AttributionCandidate,
  incident: IncidentDefinition,
  config: CairnScoringConfig = {},
): ScoreBreakdown {
  const cfg = effectiveConfig(config);

  // Choose alignment center + sigma. Engine-inferred onset (Q30.1) wins
  // when present; combine engine-uncertainty with per-kind kernel via
  // quadrature so high-confidence engine estimates tighten the kernel.
  let centerUnix: number;
  let effectiveSigma: number;
  if (incident.engine_onset_estimate) {
    centerUnix = incident.engine_onset_estimate.center_unix;
    const engineVar = incident.engine_onset_estimate.sigma_seconds ** 2;
    const kindVar = cfg.kernel_sigma_seconds[candidate.cause_kind] ** 2;
    effectiveSigma = Math.sqrt(engineVar + kindVar);
  } else {
    centerUnix = incident.onset_time_unix;
    effectiveSigma = cfg.kernel_sigma_seconds[candidate.cause_kind];
  }

  const delta = centerUnix - candidate.timestamp_unix;
  const kind_prior = cfg.kind_prior[candidate.cause_kind];
  const evidence_boost = evidenceBoostFor(candidate, cfg.evidence_boost);

  // Mechanistic-inconsistency suppression: cause AFTER incident onset
  // (beyond grace window) cannot have caused the incident.
  if (delta < -cfg.grace_seconds) {
    return {
      raw_score: 0,
      kernel_value: 0,
      kind_prior,
      evidence_boost,
      suppressed: { candidate, suppression_reason: 'post_incident_timestamp' },
    };
  }

  // Use absolute lag for kernel (one-sided after suppression check).
  const kernel_value = gaussianKernel(Math.max(0, delta), effectiveSigma);
  const raw_score = kernel_value * kind_prior * evidence_boost;

  const suppressed: SuppressedCandidate | null =
    kernel_value < KERNEL_UNDERFLOW
      ? { candidate, suppression_reason: 'kernel_underflow' }
      : null;

  return { raw_score, kernel_value, kind_prior, evidence_boost, suppressed };
}

/** Rank candidates by alignment posterior. Replay-clean: sort is stable
 *  by (posterior desc, then timestamp asc) for determinism. */
export function rankCandidates(
  candidates: AttributionCandidate[],
  incident: IncidentDefinition,
  config: CairnScoringConfig = {},
): RankedAttribution {
  const cfg = effectiveConfig(config);
  const scored: ScoredCandidate[] = [];
  const suppressed: SuppressedCandidate[] = [];

  for (const c of candidates) {
    const s = scoreCandidate(c, incident, config);
    if (s.suppressed) {
      suppressed.push(s.suppressed);
      continue;
    }
    scored.push({
      candidate: c,
      posterior: 0,
      raw_score: s.raw_score,
      kernel_value: s.kernel_value,
      kind_prior: s.kind_prior,
      evidence_boost: s.evidence_boost,
    });
  }

  const total = scored.reduce((acc, s) => acc + s.raw_score, 0);
  for (const s of scored) s.posterior = total > 0 ? s.raw_score / total : 0;

  scored.sort((a, b) => {
    if (b.posterior !== a.posterior) return b.posterior - a.posterior;
    return a.candidate.timestamp_unix - b.candidate.timestamp_unix;
  });

  return {
    ranked: scored,
    suppressed,
    incident,
    config_used: cfg,
  };
}
