// tools/recalibrate/_recalibrate-soak.ts — R5 live shadow soak, Task 4:
// CLI-side soak I/O + fold. This module owns the soak.json manifest and
// folds a completed/in-progress sidecar snapshot onto CandidateRecord
// at `soak stop` time.
//
// Per-file ownership doctrine (implementation plan §1 — binding, same
// table as service/gate-http/_gate-soak.ts's header):
//
//   soak.json (manifest)                THIS MODULE (sole writer)
//   soak/<candidate_id>.state.json      service/gate-http/_gate-soak.ts
//   (sidecar)                            — this module reads it only
//   soak/<candidate_id>.ticks.jsonl     service-owned, read-only here
//   candidates/<id>.json                THIS MODULE, via
//                                        RecalibrationStore.writeCandidate
//                                        (foldSoakEvidence is the ONLY
//                                        place this module ever writes a
//                                        CandidateRecord.soak field — no
//                                        state-machine transition, no
//                                        history entry: soak never gates,
//                                        R-Q4)
//   events.jsonl                        BOTH — sole multi-writer file,
//                                        append-only (see _gate-soak.ts
//                                        header for the O_APPEND
//                                        atomicity argument)
//
// This module never imports service/gate-http/* (D6 layering stays
// tools/ -> engine/ only in that direction too; the reverse import
// direction, service/ -> engine/, is what _gate-soak.ts already does).

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  SoakManifest, SoakSidecar, CandidateRecord, CandidateSoakEvidence,
} from '../../engine/types/recalibration';
import type { RecalibrationStore } from './_recalibrate-store';

/** Write-temp + fs.renameSync — same atomic-rename convention as
 *  _recalibrate-store.ts's writeAtomic / service/gate-http/_gate-soak.ts's
 *  writeAtomic. */
function writeAtomic(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, contents);
  fs.renameSync(tmpPath, filePath);
}

export function soakManifestPath(storeDir: string): string {
  return path.join(storeDir, 'soak.json');
}

export function soakSidecarPath(storeDir: string, candidateId: string): string {
  return path.join(storeDir, 'soak', `${candidateId}.state.json`);
}

/** Absence of soak.json is not an error (no soak has ever been started
 *  for this service) — returns null. A present-but-corrupt manifest
 *  throws (this module is the sole writer; corruption here is a real
 *  bug, not an expected state, unlike the service-side reader which
 *  must never throw on the served tick path). */
export function readSoakManifest(storeDir: string): SoakManifest | null {
  const filePath = soakManifestPath(storeDir);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SoakManifest;
}

export function writeSoakManifest(storeDir: string, m: SoakManifest): void {
  fs.mkdirSync(storeDir, { recursive: true });
  writeAtomic(soakManifestPath(storeDir), `${JSON.stringify(m, null, 2)}\n`);
}

/** Absence of the sidecar is not an error — the soak controller hasn't
 *  observed a tick yet (or was never active). Returns null. */
export function readSoakSidecar(storeDir: string, candidateId: string): SoakSidecar | null {
  const filePath = soakSidecarPath(storeDir, candidateId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SoakSidecar;
}

/** Fold a sidecar snapshot onto the candidate record (CLI is the sole
 *  candidates/*.json writer). Pure record math + store.writeCandidate;
 *  NO state-machine transition, NO history entry — soak is ADDITIONAL
 *  evidence only (R-Q4), it never gates review_status. `stopped_early`
 *  is derived from the sidecar's own status, not passed by the caller:
 *  a sidecar that reached `target_ticks` is `complete`; anything else
 *  folded at `soak stop` time was stopped before its target. */
export function foldSoakEvidence(
  store: RecalibrationStore,
  rec: CandidateRecord,
  sidecar: SoakSidecar,
  foldedBy: string,
  nowIso: string,
): CandidateRecord {
  const soak: CandidateSoakEvidence = {
    sidecar,
    folded_at: nowIso,
    folded_by: foldedBy,
    stopped_early: sidecar.status !== 'complete',
  };
  const updated: CandidateRecord = { ...rec, soak };
  store.writeCandidate(updated);
  return updated;
}

/** One human-readable summary line's worth of sidecar stats, shared by
 *  `soakEvidenceLines` (below) and `runSoakStatus`
 *  (_recalibrate-soak-cli.ts) so the two don't drift. */
export function formatSoakSidecarSummary(sidecar: SoakSidecar): string {
  const s = sidecar.stats;
  const wbr = s.disagreement.would_be_rollback;
  return `${s.ticks_observed}/${sidecar.window.target_ticks} ticks, status=${sidecar.status}, `
    + `disagreements=${s.disagreement.verdict_disagreements}/${s.disagreement.total_compared}, `
    + `would_be_rollback(active_only=${wbr.active_only}, candidate_only=${wbr.candidate_only}, both=${wbr.both}), `
    + `sessions_enrolled=${s.coverage.sessions_enrolled}, `
    + `sessions_skipped_midstream=${s.coverage.sessions_skipped_midstream}, `
    + `voids=${sidecar.voids.length}`;
}

/** Render lines for `show`: a "SOAK (folded)" one-line summary when
 *  `rec.soak` already carries a folded snapshot (the durable, CLI-owned
 *  evidence — always preferred once it exists), else a "SOAK (live)"
 *  summary read straight from the sidecar when one exists (an
 *  in-progress soak that hasn't been stopped/folded yet), else `[]`
 *  (never soaked — `show`'s output is byte-identical to pre-soak). */
export function soakEvidenceLines(storeDir: string, rec: CandidateRecord): string[] {
  if (rec.soak) {
    const e = rec.soak;
    return [`SOAK (folded): ${formatSoakSidecarSummary(e.sidecar)}, `
      + `stopped_early=${e.stopped_early}, folded_at=${e.folded_at}, folded_by='${e.folded_by}'`];
  }
  const sidecar = readSoakSidecar(storeDir, rec.candidate_id);
  if (!sidecar) return [];
  return [`SOAK (live): ${formatSoakSidecarSummary(sidecar)}`];
}
