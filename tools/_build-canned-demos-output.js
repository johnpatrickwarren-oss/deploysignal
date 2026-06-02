'use strict';
/**
 * tools/_build-canned-demos-output.js — output-shaping + write helpers for
 * the canned demo generator (split out of build-canned-demos.js verbatim).
 *
 * `writeIfChanged` takes `checkMode` as an explicit argument (the entry
 * computes it from process.argv) so behavior matches the original closure.
 */

const { fs, path, ROOT } = require('./_build-canned-demos-shared');

function writeIfChanged(filePath, content, checkMode) {
  let prev = '';
  try { prev = fs.readFileSync(filePath, 'utf8'); } catch (_) { /* fresh */ }
  if (prev === content) return false;
  if (checkMode) return true;  // signal stale
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

// D-54-4 slice 2b — transform a flat (legacy) demo output to the
// baseline_ref + overrides shape. Diff baseline + cell_patch against
// the shared baselines/llm-inference-streaming.json; emit minimal
// overrides per the D-54-4 merge conventions (arrays replace fully;
// objects deep-merge; null disables).
const STREAMING_BASELINE_REF = 'baselines/llm-inference-streaming.json';
const STREAMING_BASELINE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'demos', 'baselines', 'llm-inference-streaming.json'),
  'utf8',
));
const ORDER = [
  'id', 'name', 'description', 'narrative',
  'baseline_ref', 'baseline_override', 'cell_patch_override',
  'riskLevel', 'author', 'changeType', 'timeWindow', 'bakeHours', 'flags',
  'currentHourOfDay', 'currentDayOfWeek',
  'tenantId', 'tenant_tier_map', 'tenant_tier_config',
  'cadence_ms', 'total_ticks', 'narrative_reference',
  'ticks', 'expected_outcome',
];

function _diffForOverride(base, current) {
  if (JSON.stringify(base) === JSON.stringify(current)) return undefined;
  const out = {};
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(current || {})]);
  for (const k of keys) {
    if (!(k in base)) { out[k] = current[k]; continue; }
    if (!(k in current)) { out[k] = null; continue; }
    const bv = base[k], cv = current[k];
    if (typeof bv === 'object' && !Array.isArray(bv) && bv !== null &&
        typeof cv === 'object' && !Array.isArray(cv) && cv !== null) {
      const sub = _diffForOverride(bv, cv);
      if (sub !== undefined) out[k] = sub;
    } else if (JSON.stringify(bv) !== JSON.stringify(cv)) {
      out[k] = cv;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toRefShape(flat) {
  const baselineOverride = _diffForOverride(STREAMING_BASELINE.baseline, flat.baseline);
  const cellPatchOverride = _diffForOverride(STREAMING_BASELINE.cell_patch, flat.cell_patch);
  const { baseline: _b, cell_patch: _cp, ...rest } = flat;
  const merged = {
    ...rest,
    baseline_ref: STREAMING_BASELINE_REF,
    ...(baselineOverride ? { baseline_override: baselineOverride } : {}),
    ...(cellPatchOverride ? { cell_patch_override: cellPatchOverride } : {}),
  };
  const ordered = {};
  for (const k of ORDER) if (k in merged) ordered[k] = merged[k];
  for (const k of Object.keys(merged)) if (!(k in ordered)) ordered[k] = merged[k];
  return ordered;
}

module.exports = {
  writeIfChanged,
  toRefShape,
  _diffForOverride,
  STREAMING_BASELINE_REF,
  STREAMING_BASELINE,
  ORDER,
};
