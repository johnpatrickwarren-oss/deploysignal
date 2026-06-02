'use strict';
/**
 * tools/_build-canned-demos-patch.js — cell-patch + calibration helpers for
 * the canned demo generator (split out of build-canned-demos.js verbatim).
 */

const { path, ROOT, seededLCG, FAMILY_A_SIGNALS, FAMILY_C_SIGNALS } = require('./_build-canned-demos-shared');

// Estimate per-signal σ² from a slice of the demo's own pre-onset rows.
// This way σ² captures the demo's natural noise distribution rather than
// a flat 5%-of-baseline guess that under-tolerates small-baseline signals
// (downstream_err at 0.0011 has ~25% relative noise; flat 5% trips mSPRT).
function estimateSigmaSquared(baseline, ticks, sliceCount) {
  const n = Math.min(sliceCount, ticks.length);
  const out = {};
  for (const sig of FAMILY_A_SIGNALS) {
    const b = baseline[sig];
    if (b === undefined) { out[sig] = null; continue; }
    let s2 = 0; let cnt = 0;
    for (let t = 0; t < n; t++) {
      const m = ticks[t].metrics || ticks[t];
      if (m[sig] === undefined) continue;
      const d = m[sig] - b;
      s2 += d * d; cnt++;
    }
    // Floor: 5% of baseline² — guards against signals whose pre-onset slice
    // is artificially flat (perfect repeats) producing σ²=0 → divide-by-zero.
    const floor = Math.pow(b * 0.05, 2);
    out[sig] = cnt > 0 ? Math.max(s2 / cnt, floor) : floor;
  }
  return out;
}

function buildCellPatch(baseline, hourOfDay, dayOfWeek, sigmaMap) {
  const perSignal = {};
  for (const sig of FAMILY_A_SIGNALS) {
    const b = baseline[sig];
    if (b === undefined) continue;
    // Use empirical σ² from the demo's pre-onset slice when supplied;
    // fallback to (5% baseline)² otherwise. τ² = σ² so the mSPRT log-shrink
    // prior is log(0.5)/2 ≈ -0.347 per tick at x=0.
    const var2 = (sigmaMap && sigmaMap[sig] !== null && sigmaMap[sig] !== undefined)
      ? sigmaMap[sig]
      : Math.max(Math.pow(b * 0.05, 2), 1e-10);
    perSignal[sig] = {
      baseline_mean: b,
      baseline_sigma_squared: var2,
      tau_squared: var2,
      delta_min: b * 0.04,
    };
  }
  return {
    target_cell: { hour_of_day: hourOfDay, day_of_week: dayOfWeek },
    family_A_per_signal: perSignal,
    family_C_mean_vector: FAMILY_C_SIGNALS.map(s => baseline[s] !== undefined ? baseline[s] : 0),
    family_E_calibration_scores: null,
  };
}

// Synthesize Family E calibration scores from a demo's clean / pre-onset
// trajectory. Each calibration score is the Mahalanobis distance of the
// relative-deviation vector against the patched cell's (mean_vector,
// covariance) — uses the engine's own mahalanobisDistance helper so the
// calibration scores are scored on the same metric the runtime detector
// uses. Conformal p-value math stays exchangeable.
function buildE_CalibrationScores(baseline, ticks, sliceCount, covariance) {
  const { mahalanobisDistance } = require(path.join(ROOT, 'dist', 'engine', 'detectors', 'conformal'));
  const scores = [];
  const slice = ticks.slice(0, sliceCount);
  function relDev(m) {
    const r = new Array(FAMILY_C_SIGNALS.length);
    for (let i = 0; i < FAMILY_C_SIGNALS.length; i++) {
      const sig = FAMILY_C_SIGNALS[i];
      const b = baseline[sig];
      const v = m[sig];
      r[i] = (b !== undefined && v !== undefined && Math.abs(b) > 1e-12) ? (v - b) / b : 0;
    }
    return r;
  }
  for (const t of slice) {
    const r = relDev(t.metrics || t);
    const s = mahalanobisDistance(r, covariance);
    if (s !== null && isFinite(s)) scores.push(s);
  }
  // Pad with deterministic synthetic samples (small-jitter around baseline)
  // so calibration ≥ 100 — α_E override (1e-2) requires ≥ 99 scores per
  // conformal underpowered guard.
  const rand = seededLCG(7919);
  while (scores.length < 100) {
    const m = {};
    for (const sig of FAMILY_C_SIGNALS) {
      const b = baseline[sig];
      if (b === undefined) continue;
      m[sig] = b * (1 + (rand() - 0.5) * 0.012);  // ±0.6% jitter
    }
    const r = relDev(m);
    const s = mahalanobisDistance(r, covariance);
    if (s !== null && isFinite(s)) scores.push(s);
  }
  scores.sort((a, b) => a - b);
  return scores;
}

function attachPatch(demo, calibrationSliceCount) {
  const sigmaMap = estimateSigmaSquared(demo.baseline, demo.ticks, calibrationSliceCount);
  const patch = buildCellPatch(demo.baseline, demo.currentHourOfDay, demo.currentDayOfWeek, sigmaMap);
  // W5 §REPLY-16 Q2: Family E now always consults aggregate_fallback for
  // calibration scores (~20 K pooled baseline). The per-cell calibration
  // override and α_E=1e-2 override are no longer needed — α_E reverts to
  // the v4 default (1e-4) which is natively achievable against the
  // aggregate's sample size.
  delete patch.family_E_calibration_scores;
  demo.cell_patch = patch;
  return demo;
}

module.exports = {
  estimateSigmaSquared,
  buildCellPatch,
  buildE_CalibrationScores,
  attachPatch,
};
