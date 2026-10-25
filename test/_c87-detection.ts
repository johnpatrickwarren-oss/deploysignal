// test/_c87-detection.ts — C87 (2026-10-02): the corpus detection metric.
//
// Families A, C and D are ADVISORY (engine/guarantees.ts TEMPORAL_PATH_AUTHORITY): their fires
// are recorded and never reach rollback[]. The corpus tests that used to count "the deploy rolled
// back" as detection now count "the deploy rolled back OR an advisory A/C/D fire was recorded".
// The advisory half is read from the marks the health gate leaves on the fired verdicts
// (`advisory_id`: the rollback id the fire would have carried before C87), so the set of ids a
// test sees is the set it saw on rollback[] before, minus nothing and plus nothing.
//
// A runner that stops at the first detection reports `'advisory'` as its outcome when that
// detection was an advisory fire; the deploy's own verdict at that tick was not `rollback`.

import { temporalAdvisoryFireIds } from '../dist/engine/_verdict-advisory';

/** The advisory A/C/D fire ids on one orchestrate() result (or a bare HealthResult). */
export function advisoryIds(r: any): string[] {
  const hr = r && r.healthResult !== undefined ? r.healthResult : r;
  return temporalAdvisoryFireIds(hr);
}

/** rollback[] ids followed by the advisory A/C/D fire ids: what "detection" is made of. */
export function detectionIds(r: any): string[] {
  const hr = r && r.healthResult !== undefined ? r.healthResult : r;
  const rb: string[] = ((hr && hr.rollback) || []).map((s: any) => s.id);
  return rb.concat(temporalAdvisoryFireIds(hr));
}

/** Detection on one tick: the deploy rolled back, or an advisory A/C/D fire was recorded. */
export function detectedAt(r: any): boolean {
  return r.verdict === 'rollback' || advisoryIds(r).length > 0;
}

/** Detection as a run outcome: `'rollback'` or `'advisory'` (see header). */
export function isDetection(outcome: string): boolean {
  return outcome === 'rollback' || outcome === 'advisory';
}
