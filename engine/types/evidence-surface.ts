// engine/types/evidence-surface.ts — per-detector evidence surface.
//
// Since the engine v0.6.9-pre re-pin these are a plain re-export of the
// package's own types (ADR 0027, engine types/verdict-extensions/
// evidence-surface.ts) via the `./types/verdict-extensions/evidence-surface`
// entry the engine's `exports` map now carries. At v0.6.8-pre that entry
// was missing, so this file derived the same types from
// `DetectorVerdict['evidence']`. The file is kept so existing imports from
// './evidence-surface' and '../types' are unchanged.
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

export type { EvidenceSurface, ThresholdKind } from '@johnpatrickwarren-oss/deploysignal-engine/types/verdict-extensions/evidence-surface';
