// engine/types/evidence-surface.ts — per-detector evidence surface.
//
// Since the engine v0.6.8-pre re-pin these are the package's own types
// (ADR 0027, engine types/verdict-extensions/evidence-surface.ts), not a
// local mirror. The engine's package.json `exports` map has no entry for
// `./types/verdict-extensions/evidence-surface` (only `cluster-topology`
// is listed), and this repo resolves with `moduleResolution: node16`, so
// the direct subpath import does not resolve. The types are derived from
// the exported `DetectorVerdict.evidence` field instead — structurally
// the same types, and they cannot drift from the package. Existing
// imports from './evidence-surface' and '../types' are unchanged.
//
// Emitted only by the multiplicative wealth detectors — Family A betting
// e-process and mixture, Family C safe-Hotelling and betting e-process,
// Family D spectral e-detector. Absent on every other verdict, so every
// consumer in this repo reads it as optional and behaves identically
// without it. Validity boundary: these fields are evidence only when the
// wealth process is a supermartingale under H0 (compiled baseline is the
// truth); on an estimated-baseline path they are bookkeeping, not
// evidence (engine `detectors/validity-envelope.ts`; knowledge
// stats/validity-premise-chain).

import type { DetectorVerdict } from '@johnpatrickwarren-oss/deploysignal-engine/types/verdict';

/** The detector's wealth-process bookkeeping at one tick, in nats. */
export type EvidenceSurface = NonNullable<DetectorVerdict['evidence']>;

/** Which threshold `log_threshold` is the log of: `'ville'` (nominal
 *  `1/α`), `'bootstrap'` (calibrator's empirical quantile), `'priced'`. */
export type ThresholdKind = NonNullable<EvidenceSurface['threshold_kind']>;
