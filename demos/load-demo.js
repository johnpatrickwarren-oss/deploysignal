'use strict';
// demos/load-demo.js — Shared demo-fixture loader (D-54-4 slice 2b).
//
// Resolves baseline_ref + applies optional per-demo overrides to
// produce the fully-materialized demo shape that matches the pre-
// consolidation inline format. Runs server-side (Node tests +
// tools/build-demo.js + tools/build-canned-demos.js all consume).
//
// Shape contract:
//   Raw demo JSON may carry:
//     baseline_ref          — relative path (from demos/) to a
//                             shared baseline file. Absent on legacy
//                             (pre-D-54-4) demos; the loader returns
//                             them unchanged.
//     baseline_override     — optional deep-merge patch over the
//                             ref'd `baseline` object.
//     cell_patch_override   — optional deep-merge patch over the
//                             ref'd `cell_patch` object.
//   The shared baseline JSON (under demos/baselines/) carries:
//     { id, baseline: {...}, cell_patch: {...} }
//
// Resolution result: the raw demo object, MINUS the three _ref /
// _override keys, PLUS the resolved `baseline` + `cell_patch`
// fields (pre-consolidation shape). Downstream consumers see the
// same JSON surface they did before consolidation.
//
// Merge conventions (per ARCHITECT-REPLY-54 D-54-4 + TPM disposition
// per REPLY-51 D4 precedent):
//   - Arrays REPLACE entirely. No element-level merge.
//   - Objects DEEP-MERGE recursively.
//   - null DISABLES — the key is dropped from the merged result.

const fs   = require('fs');
const path = require('path');

const DEMOS_ROOT    = __dirname;
// For back-compat with callers that need the resolved cell_patch /
// baseline but aren't reading from disk (e.g., tools/build-canned-
// demos.js builds in-memory demo objects).
const DEEP_MERGE_SENTINEL_NULL = null;

/** Recursive merge per the D-54-4 conventions. */
function deepMerge(base, override) {
  // null sentinel: drop the key from the merged result. This mirrors
  // how null propagates through Object.assign-style chains and is
  // how the override system signals "remove this field."
  if (override === DEEP_MERGE_SENTINEL_NULL) return DEEP_MERGE_SENTINEL_NULL;
  // undefined override → preserve base.
  if (override === undefined) return base;
  // Array override: full replace, no element merge.
  if (Array.isArray(override)) return override.slice();
  // Primitive or non-array override: replace base.
  if (typeof override !== 'object') return override;
  // Object override: recurse per-key.
  const out = (typeof base === 'object' && base !== null && !Array.isArray(base))
    ? { ...base } : {};
  for (const k of Object.keys(override)) {
    const merged = deepMerge(base == null ? undefined : base[k], override[k]);
    if (merged === DEEP_MERGE_SENTINEL_NULL) {
      delete out[k];
    } else {
      out[k] = merged;
    }
  }
  return out;
}

/** Resolve an already-parsed raw demo object. Exposed for callers
 *  that construct the raw object in memory (generator path). */
function resolveDemo(rawDemo) {
  if (!rawDemo || typeof rawDemo !== 'object') return rawDemo;
  if (!rawDemo.baseline_ref) return rawDemo;
  const baselinePath = path.join(DEMOS_ROOT, rawDemo.baseline_ref);
  const baselineDoc = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const {
    baseline_ref: _ref,
    baseline_override: bOv,
    cell_patch_override: cOv,
    ...rest
  } = rawDemo;
  // Carry the reference on the resolved doc for audit + observability
  // (downstream consumers can log which baseline this run used).
  const resolved = {
    ...rest,
    baseline: deepMerge(baselineDoc.baseline, bOv),
    cell_patch: deepMerge(baselineDoc.cell_patch, cOv),
    _baseline_ref: rawDemo.baseline_ref,
    _baseline_id: baselineDoc.id,
  };
  return resolved;
}

/** Read a demo-script JSON from disk and return the resolved shape.
 *  Pre-consolidation (flat) demos pass through unchanged. */
function loadDemoScript(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return resolveDemo(raw);
}

/** Read + resolve all demos under demos/scripts/ in filename order.
 *  Used by tools/build-demo.js + test harnesses that iterate the
 *  full demo catalog. */
function loadAllDemoScripts(scriptsDir) {
  const dir = scriptsDir || path.join(DEMOS_ROOT, 'scripts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const out = {};
  for (const f of files) {
    out[f.replace(/\.json$/, '')] = loadDemoScript(path.join(dir, f));
  }
  return out;
}

module.exports = {
  deepMerge,
  resolveDemo,
  loadDemoScript,
  loadAllDemoScripts,
};
