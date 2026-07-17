// engine/recalibration/pinning.ts — Addition #15 baseline-maintenance
// lifecycle. Deploy-pinning validation (plan §B D4): a deploy already
// carries its baseline pin two ways — the record's top-level
// `compiled_config_version` and every detector trip's per-trip
// `Provenance.baseline_version`. Promotion (Task 6/8/9) swaps
// active.json, which mid-deploy could in principle change which
// version an in-flight deploy resolves against; this module is the
// pure validation helper an operator (or an invariant test, plan §C
// Task 10 #3) runs against a deploy's audit records after the fact to
// confirm no baseline-version flip actually reached the deploy.
//
// D6 (engine/tools split): pure, no fs, no I/O; no orchestrator change.

import type { AuditRecordV2, FamilyId, DetectorId } from '../types';

export interface PinViolation {
  record_index: number;
  ts: string;
  kind: 'compiled_config_version' | 'trip_provenance_baseline_version';
  expected: string;
  actual: string;
  family_id?: FamilyId;
  detector_id?: DetectorId;
}

/** Validate that every record in `records` stayed pinned to
 *  `pinnedVersion` on both surfaces:
 *    1. `record.compiled_config_version` (top-level).
 *    2. `record.families[*].detectors[*].provenance.baseline_version`
 *       (every detector trip on every family, fired or not — any trip
 *       that ran consulted a cell against some baseline_version).
 *
 *  Returns one PinViolation per mismatched surface (a single record can
 *  contribute up to `1 + n_trips` violations); an empty array means the
 *  entire deploy stayed pinned. */
export function validateDeployPinning(
  records: AuditRecordV2[],
  pinnedVersion: string,
): PinViolation[] {
  const violations: PinViolation[] = [];

  records.forEach((record, record_index) => {
    if (record.compiled_config_version !== pinnedVersion) {
      violations.push({
        record_index,
        ts: record.ts,
        kind: 'compiled_config_version',
        expected: pinnedVersion,
        actual: record.compiled_config_version,
      });
    }

    for (const family_id of Object.keys(record.families) as FamilyId[]) {
      const family = record.families[family_id];
      if (!family) continue;
      for (const trip of family.detectors) {
        if (trip.provenance.baseline_version !== pinnedVersion) {
          violations.push({
            record_index,
            ts: record.ts,
            kind: 'trip_provenance_baseline_version',
            expected: pinnedVersion,
            actual: trip.provenance.baseline_version,
            family_id,
            detector_id: trip.detector_id,
          });
        }
      }
    }
  });

  return violations;
}
