// _source_selection.mjs — which bundle supplies which parameter group.
//
// Extracted from fit_noise_model.mjs after run-20260805T231835Z selected a
// synthetic-timestamp bundle for cost_req's serial parameters on series length
// alone, which is precisely what bar A3 exists to prevent. PREREGISTRATION.md §5
// defines the bars but left the multi-source selection rule unstated; this module
// is that rule, and the report discloses it as a pre-registration gap.
//
// Rule: a bundle that FAILS a bar cannot supply the groups that bar kills.
// Among bundles that pass, the primary is the one passing the most bars; ties
// broken by tick count. Non-primary passing sources are reported as cross-checks.

/** Bundles whose ingest fabricates timestamps — bar A3. Read off the ingest
 *  code, not the data: tools/_ingest-real-trace-huggingface.ts:158. */
export const SYNTHETIC_TIMESTAMP_BUNDLES = new Set(['real-huggingface-lmsys-arena-v1']);

/** Groups each bar kills, per PREREGISTRATION.md §5. */
export const BAR_KILLS = {
  A1: ['marginal', 'serial', 'periodic'],
  A2: ['marginal', 'serial', 'periodic'],
  A3: ['serial', 'periodic'],
  A4: ['serial'],
  A5: ['periodic'],
  A6: [],
};

/** Bars a single candidate source fails, on facts available before fitting. */
export function barsFailedBy(entry) {
  const failed = [];
  if (SYNTHETIC_TIMESTAMP_BUNDLES.has(entry.bundle)) failed.push('A3');
  return failed;
}

/** Can this source supply this parameter group? */
export function canSupply(entry, group) {
  return !barsFailedBy(entry).some((bar) => BAR_KILLS[bar].includes(group));
}

/**
 * Choose the primary source per parameter group.
 * @param entries inventory rows for one signal: {bundle, ticks, ...}
 * @returns {{primary: object|null, per_group: {marginal,serial,periodic}, cross_checks: object[]}}
 */
export function selectSource(entries) {
  if (entries.length === 0) {
    return { primary: null, per_group: { marginal: null, serial: null, periodic: null }, cross_checks: [] };
  }
  const rank = (e) => [barsFailedBy(e).length, -e.ticks];
  const ordered = entries.slice().sort((a, b) => {
    const [fa, ta] = rank(a), [fb, tb] = rank(b);
    return fa !== fb ? fa - fb : ta - tb;
  });
  const primary = ordered[0];
  const per_group = {};
  for (const group of ['marginal', 'serial', 'periodic']) {
    per_group[group] = ordered.find((e) => canSupply(e, group)) ?? null;
  }
  return { primary, per_group, cross_checks: ordered.slice(1) };
}
