"use strict";
// tools/_build-report-card-summary.js — percentile + summary roll-up for the
// report-card builder. Split VERBATIM out of build-report-card.js (no
// behavior change).
Object.defineProperty(exports, "__esModule", { value: true });

function percentile(sorted, p) {
    if (sorted.length === 0)
        return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
    return sorted[idx];
}
function summarize(fpr, cells, alphaTotal) {
    // D1 (REPLY-52e): split TPR into α-spending (acceptance-gated) +
    // combined (includes Family B supplements). time-to-detect reported
    // across ALL detected profiles (any family) since ops cares about
    // end-to-end catch latency.
    const alphaDetected = cells.filter((c) => c.alpha_spending_detected);
    const combinedDetected = cells.filter((c) => c.combined_detected);
    const familyBOnly = cells.filter((c) =>
        c.combined_detected && !c.alpha_spending_detected);
    const ttd = combinedDetected
        .map((c) => c.time_to_detect_ticks)
        .filter((v) => v !== null)
        .sort((a, b) => a - b);
    const median = percentile(ttd, 0.5);
    const p95 = percentile(ttd, 0.95);
    const attrMatchCount = alphaDetected.filter((c) => c.attribution_match).length;
    const villeCaught = cells.filter((c) => c.ville_bounded_caught).length;
    const classicalCaught = cells.filter((c) => c.classical_epoch_caught).length;
    return {
        alpha_spending_tpr: `${alphaDetected.length}/${cells.length}`,
        combined_tpr: `${combinedDetected.length}/${cells.length}`,
        ville_bounded_tpr: `${villeCaught}/${cells.length}`,
        classical_epoch_tpr: `${classicalCaught}/${cells.length}`,
        family_b_only_catches: familyBOnly.length,
        fpr_ville_bounded:
            `${fpr.fpr_ville_bounded.fp_count}/${fpr.healthy_window_count} ` +
            `(${fpr.fpr_ville_bounded.empirical_vs_ville_bound_ratio.toFixed(3)} × α_ville)`,
        fpr_classical_epoch:
            `${fpr.fpr_classical_epoch.fp_count}/${fpr.healthy_window_count} ` +
            `(${fpr.fpr_classical_epoch.empirical_vs_classical_bound_ratio.toFixed(3)} × α_classical)`,
        family_b_trip_rate_diagnostic:
            `${fpr.family_b_trip_count}/${fpr.healthy_window_count} ` +
            `(non-α-consuming; see fpr_calibration note)`,
        median_time_to_detect: median,
        p95_time_to_detect: p95,
        attribution_accuracy: alphaDetected.length > 0
            ? `${attrMatchCount}/${alphaDetected.length}` : '0/0',
    };
}

module.exports = {
    percentile,
    summarize,
};
