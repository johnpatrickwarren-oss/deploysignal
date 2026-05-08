// tools/nab-scoring.ts — Q64 SPEC-4 NAB scoring helper module.
//
// Per Q64-NAB-FIREWALL-SPEC.md § Implementation surface > tools/nab-
// scoring.ts. Implements Lavin-Ahmad 2015 (*Evaluating Real-Time
// Anomaly Detection Algorithms — the Numenta Anomaly Benchmark*)
// NAB scoring methodology:
//
//   - Per annotation anomaly window, the FIRST detection inside or
//     after the window scores via a sigmoid time-decay weight
//     centered at window start.
//   - Detections strictly before any anomaly window count as FP.
//   - Anomaly windows with no detection inside count as FN.
//   - Each profile (standard / reward_low_fp / reward_low_fn) applies
//     different TP/FP/FN coefficient weights.
//   - Raw score is normalized to a 0-100 range vs a random-detector
//     baseline (~0) and a perfect-detector ceiling.
//
// References:
//   - Lavin & Ahmad 2015 §3 "Evaluation Methodology"
//   - numenta/NAB README + nab/scorer.py (implementation reference)

import type { DetectorFiringDecision, NABDatasetAnnotation } from './run-nab-validation';

export interface NABProfile {
  name: 'standard' | 'reward_low_fp' | 'reward_low_fn';
  /** TP coefficient — positive contribution per true-positive detection. */
  tp_weight: number;
  /** FP coefficient — negative contribution per false-positive (outside window). */
  fp_weight: number;
  /** FN coefficient — negative contribution per anomaly window with no detection. */
  fn_weight: number;
}

/** Lavin-Ahmad 2015 Table 1 application profiles (verbatim from paper).
 *  Standard balances TP/FP/FN; reward_low_fp scales FP penalty up;
 *  reward_low_fn scales TP reward + FN penalty up. */
export const NAB_PROFILES: Record<NABProfile['name'], NABProfile> = {
  standard:       { name: 'standard',       tp_weight: 1.0, fp_weight: -0.22, fn_weight: -1.0 },
  reward_low_fp:  { name: 'reward_low_fp',  tp_weight: 1.0, fp_weight: -0.46, fn_weight: -1.0 },
  reward_low_fn:  { name: 'reward_low_fn',  tp_weight: 2.0, fp_weight: -0.22, fn_weight: -2.0 },
};

/** Sigmoid time-decay function per Lavin-Ahmad 2015 §3.2.
 *  Positions earlier in the window score higher; positions at or after
 *  window end decay toward zero. Standard 5×y centering matches
 *  numenta/NAB scorer.py reference implementation. */
function sigmoidDecay(rel_pos: number): number {
  // rel_pos: normalized (window_end - detection_tick) / window_width;
  //   1.0 at window start (best); 0.0 at window end; <0 after window
  //   (continued sigmoid decay gives small positive value for slightly-
  //   late detection within the extended early window).
  return 1.0 / (1.0 + Math.exp(-5.0 * rel_pos));
}

/** Compute NAB score per detector per dataset per profile.
 *
 *  Algorithm:
 *  1. Sort annotations by window start.
 *  2. For each window: find first firing tick within [window_start,
 *     window_end]; if found, accumulate TP × tp_weight × sigmoidDecay.
 *     If no firing in window, accumulate fn_weight.
 *  3. For each firing outside any window: accumulate fp_weight.
 *  4. Normalize to 0-100 range:
 *     normalized = 100 × (raw - random_baseline) / (perfect_score - random_baseline)
 *     where random_baseline = 0 (Lavin-Ahmad 2015 reference);
 *     perfect_score = (#anomaly_windows × tp_weight × sigmoidDecay(1.0))
 *     (ideal: every window detected exactly at start with no FPs).
 */
export function computeNABScore(
  firings: DetectorFiringDecision[],
  annotations: NABDatasetAnnotation[],
  profile: NABProfile,
): number {
  if (annotations.length === 0) {
    // Pure FP-floor case: only FPs (no TP/FN possible). Score per profile FP weight.
    const fp_count = firings.filter((f) => f.fire).length;
    const raw = fp_count * profile.fp_weight;
    // Normalize: random_baseline = 0; perfect_score = 0 (no anomalies → perfect = no firings).
    // Map raw FP-only score to 0-100: clamp at [0, 100] with FP-rate penalty.
    return Math.max(0, 100 + raw);
  }

  // Sort annotations by window start; assume non-overlapping (NAB convention).
  const wins = annotations
    .map((a) => ({ start: a.anomaly_window_start, end: a.anomaly_window_end }))
    .sort((a, b) => a.start - b.start);

  let raw = 0;
  let perfect = 0;
  // Track which firings were claimed by an anomaly window (to identify FPs).
  const claimedFiringIdx = new Set<number>();

  for (const w of wins) {
    const width = Math.max(1, w.end - w.start);
    // Find first firing within [w.start, w.end].
    const inWindowIdx = firings.findIndex((f, idx) =>
      f.fire && !claimedFiringIdx.has(idx) && f.tick >= w.start && f.tick <= w.end
    );
    if (inWindowIdx >= 0) {
      const firing = firings[inWindowIdx];
      const rel_pos = (w.end - firing.tick) / width;  // 1.0 at start; 0.0 at end
      raw += profile.tp_weight * sigmoidDecay(rel_pos);
      claimedFiringIdx.add(inWindowIdx);
    } else {
      raw += profile.fn_weight;
    }
    perfect += profile.tp_weight * sigmoidDecay(1.0);  // perfect: detection at window start
  }

  // FPs: firings outside any window AND not claimed by any window.
  for (let idx = 0; idx < firings.length; idx++) {
    const f = firings[idx];
    if (!f.fire) continue;
    if (claimedFiringIdx.has(idx)) continue;
    const insideAnyWindow = wins.some((w) => f.tick >= w.start && f.tick <= w.end);
    if (!insideAnyWindow) {
      raw += profile.fp_weight;
    }
  }

  // Normalize to 0-100 range: random_baseline = 0; perfect_score = perfect.
  const random_baseline = 0;
  if (perfect <= 0) return Math.max(0, raw);  // Defensive.
  const normalized = 100 * (raw - random_baseline) / (perfect - random_baseline);
  // Clamp to non-negative (Lavin-Ahmad 2015 NAB-leaderboard scores are non-negative).
  return Math.max(0, normalized);
}

/** Aggregate per-dataset scores into per-family score (mean aggregation
 *  per Lavin-Ahmad 2015 standard). Empty perDatasetScores returns 0. */
export function aggregateFamilyScore(perDatasetScores: Record<string, number>): number {
  const values = Object.values(perDatasetScores);
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
