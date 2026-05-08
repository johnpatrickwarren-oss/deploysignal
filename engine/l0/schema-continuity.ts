// engine/l0/schema-continuity.ts — Addition #8 L0 extension.
//
// Per NORTH-STAR-ARCHITECTURE.md §Addition #8. A deploy that changes the
// telemetry it's being evaluated by breaks the gate's pre/post comparison;
// silently comparing old-schema canary metrics against new-schema live
// data produces meaningless verdicts. L0 computes a schema hash per
// signal at ingestion and classifies every per-tick schema observation
// against the pre-deploy baseline hash into one of four continuity classes.
//
// The hash covers *metadata*, not values: signal name, unit, semantic type,
// granularity, label-key set, quantile list (for latency quantiles), bucket
// boundaries (for histograms), span/attribute key sets (for traces).
//
// Detectors consult the emitted `schema_continuity` class before evaluating.
// The per-family suppression table below is authoritative:
//
//   continuous          — all families run normally
//   extended            — all families run normally; Family C may pick up
//                          the new dimension when re-compiled
//   breaking            — affected signal suppresses across all families;
//                          Families C/E suppress entirely (covariance /
//                          baseline model invalid)
//   observability_stack — all families suppressed; gate refuses to
//                          evaluate against its own pre-deploy baseline
//
// This file is L0 infrastructure — detectors import the
// `suppressionClassFor()` helper to check whether they should fire based
// on an upstream schema-continuity record.

import type { SchemaContinuityRecord } from '../types';

/** Inputs to the schema hash. All string-valued so the hash is stable
 *  across language/encoding round-trips. Omit keys that aren't part of
 *  the metadata to keep the hash deterministic. */
export interface SchemaDescriptor {
  signal_name: string;
  unit: string;
  /** counter | gauge | ratio | latency_quantile | categorical_rate. */
  semantic_type: string;
  /** per_request | per_second | per_minute | per_tick. */
  granularity: string;
  /** Set of label keys attached to the metric (not values — just keys). */
  label_keys?: string[];
  /** For latency_quantile: quantile list (e.g. [0.5, 0.95, 0.99]). */
  quantile_list?: number[];
  /** For histograms: bucket boundary set. */
  bucket_boundaries?: number[];
  /** For traces: span name set. */
  trace_span_names?: string[];
  /** For traces: attribute key set. */
  trace_attribute_keys?: string[];
}

/** Deterministic non-cryptographic hash. FNV-1a 32-bit on the serialized
 *  descriptor's canonical form. Crypto isn't required — the hash's job is
 *  equality comparison, not collision resistance under adversarial input. */
export function hashSchema(desc: SchemaDescriptor): string {
  const canonical = canonicalize(desc);
  const s = JSON.stringify(canonical);
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function canonicalize(desc: SchemaDescriptor): SchemaDescriptor {
  const out: SchemaDescriptor = {
    signal_name: desc.signal_name,
    unit: desc.unit,
    semantic_type: desc.semantic_type,
    granularity: desc.granularity,
  };
  if (desc.label_keys) out.label_keys = [...desc.label_keys].sort();
  if (desc.quantile_list) out.quantile_list = [...desc.quantile_list].sort((a, b) => a - b);
  if (desc.bucket_boundaries) out.bucket_boundaries = [...desc.bucket_boundaries].sort((a, b) => a - b);
  if (desc.trace_span_names) out.trace_span_names = [...desc.trace_span_names].sort();
  if (desc.trace_attribute_keys) out.trace_attribute_keys = [...desc.trace_attribute_keys].sort();
  return out;
}

/** Classify a post-deploy schema observation against the pre-deploy
 *  baseline descriptor. Returns the continuity class per Addition #8's
 *  table. */
export function classifyContinuity(
  baseline: SchemaDescriptor,
  observed: SchemaDescriptor,
  opts?: { observabilityStackDeploy?: boolean },
): SchemaContinuityRecord['schema_continuity'] {
  if (opts?.observabilityStackDeploy) return 'observability_stack';
  // Identity → continuous.
  if (hashSchema(baseline) === hashSchema(observed)) return 'continuous';

  // Breaking: unit / semantic_type / granularity / signal_name changed, or
  // quantile / bucket list changed. A label key REMOVED is breaking; a
  // label key ADDED is extended.
  if (baseline.signal_name !== observed.signal_name) return 'breaking';
  if (baseline.unit !== observed.unit) return 'breaking';
  if (baseline.semantic_type !== observed.semantic_type) return 'breaking';
  if (baseline.granularity !== observed.granularity) return 'breaking';
  if (!setEquals(baseline.quantile_list, observed.quantile_list)) return 'breaking';
  if (!setEquals(baseline.bucket_boundaries, observed.bucket_boundaries)) return 'breaking';

  // Label keys: added-only is extended; removed-any is breaking.
  const baseKeys = new Set(baseline.label_keys ?? []);
  const obsKeys  = new Set(observed.label_keys ?? []);
  for (const k of baseKeys) if (!obsKeys.has(k)) return 'breaking';

  // Trace span / attribute keys: symmetric (new additions are extended).
  const baseSpans = new Set(baseline.trace_span_names ?? []);
  const obsSpans  = new Set(observed.trace_span_names ?? []);
  for (const k of baseSpans) if (!obsSpans.has(k)) return 'breaking';
  const baseAttrs = new Set(baseline.trace_attribute_keys ?? []);
  const obsAttrs  = new Set(observed.trace_attribute_keys ?? []);
  for (const k of baseAttrs) if (!obsAttrs.has(k)) return 'breaking';

  // Everything else is extended (added label key, new span name, etc.).
  return 'extended';
}

function setEquals(a?: number[], b?: number[]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/** Emit a schema-continuity record for a post-deploy tick. `baselineRef`
 *  identifies the compiled config whose baseline this stream should be
 *  compared against; a mismatch between the live stream's baselineRef and
 *  the compiled config's baseline_ref is itself a breaking-class change. */
export function makeContinuityRecord(
  baseline: SchemaDescriptor,
  observed: SchemaDescriptor,
  baselineRef: string,
  opts?: { observabilityStackDeploy?: boolean },
): SchemaContinuityRecord {
  const klass = classifyContinuity(baseline, observed, opts);
  return {
    schema_hash: hashSchema(observed),
    schema_continuity: klass,
    schema_baseline_ref: baselineRef,
  };
}

/** Per-family suppression decision per Addition #8 §Consequences at L2.
 *  Returns the set of families that should suppress for a signal under
 *  the given continuity class. `'*'` means "all families". */
export function familiesToSuppress(
  klass: SchemaContinuityRecord['schema_continuity'],
): Array<'A' | 'B' | 'C' | 'D' | 'E'> | '*' {
  switch (klass) {
    case 'continuous': return [];
    case 'extended':   return [];  // no suppression; C/E may pick up new dim on rebaseline
    case 'breaking':   return ['A', 'C', 'D', 'E'];  // per-signal A/D; C/E suppress entirely
    case 'observability_stack': return '*';
  }
}

/** Convenience: should a specific family suppress given this class? */
export function shouldSuppress(
  klass: SchemaContinuityRecord['schema_continuity'],
  family: 'A' | 'B' | 'C' | 'D' | 'E',
): boolean {
  const list = familiesToSuppress(klass);
  if (list === '*') return true;
  return list.indexOf(family) >= 0;
}

/** Minimum post-deploy sample count before a rebaseline can complete.
 *  Addition #8 default; SRE policy overrides in production. */
export const MIN_REBASELINE_SAMPLES = 500;
