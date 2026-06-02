"use strict";
// tools/_build-report-card-cell.js — shared cell-key helpers for the
// report-card builder. Split VERBATIM out of build-report-card.js (no
// behavior change): cell-row collection, populated-cell listing, per-cell
// mean computation, and compiled-config cell lookup. These are consumed by
// both the window generators and the firing-id classifier.
Object.defineProperty(exports, "__esModule", { value: true });

/** Collect rows (one row per tick) from all baseline runs at the
 *  specified cell key. Returns an array of per-signal objects. */
function collectCellRows(baseline, hourOfDay, dayOfWeek) {
    const signals = baseline.manifest.signals;
    const rows = [];
    for (const run of baseline.runs) {
        const hs = run.hour_of_day;
        const ds = run.day_of_week;
        if (!hs || !ds) continue; // need cell metadata
        for (let i = 0; i < hs.length; i++) {
            if (hs[i] !== hourOfDay || ds[i] !== dayOfWeek) continue;
            const row = {};
            let ok = true;
            for (const s of signals) {
                const v = run.signal_series[s]?.[i];
                if (v === undefined) { ok = false; break; }
                row[s] = v;
            }
            if (ok) rows.push(row);
        }
    }
    return rows;
}
/** List cell keys with ≥ minSamples samples. Used to pick the
 *  candidate cells for the 131-window FPR sweep. */
function listPopulatedCells(baseline, minSamples) {
    const signals = baseline.manifest.signals;
    const counts = new Map(); // key → count
    for (const run of baseline.runs) {
        const hs = run.hour_of_day;
        const ds = run.day_of_week;
        if (!hs || !ds) continue;
        for (let i = 0; i < hs.length; i++) {
            const k = `${hs[i]}-${ds[i]}`;
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }
    }
    const keys = [];
    for (const [k, n] of counts.entries()) {
        if (n >= minSamples) {
            const [h, d] = k.split('-').map((x) => parseInt(x, 10));
            keys.push({ hour_of_day: h, day_of_week: d, n_samples: n });
        }
    }
    return keys;
}
/** Compute per-signal mean from bootstrap-source cell rows. Used as the
 *  scenario.baseline so Family B ratios stay near 1.0 on healthy windows. */
function cellMeanFromRows(rows, signals) {
    const out = {};
    if (rows.length === 0) {
        for (const s of signals) out[s] = 0;
        return out;
    }
    for (const s of signals) {
        let sum = 0;
        for (const r of rows) sum += r[s] ?? 0;
        out[s] = sum / rows.length;
    }
    return out;
}
function lookupCell(compiledConfig, cellKey) {
    if (!cellKey || !compiledConfig?.baseline_cells?.cells) return null;
    return compiledConfig.baseline_cells.cells.find((c) =>
        c.key && c.key.hour_of_day === cellKey.hour_of_day &&
        c.key.day_of_week === cellKey.day_of_week
    ) ?? null;
}

module.exports = {
    collectCellRows,
    listPopulatedCells,
    cellMeanFromRows,
    lookupCell,
};
