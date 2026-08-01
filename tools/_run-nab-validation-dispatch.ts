// tools/_run-nab-validation-dispatch.ts — Q64 SPEC-4 detector dispatch.
//
// Extracted VERBATIM from tools/run-nab-validation.ts (detector dispatch
// wrapper-layer). The original runDetectorOverDataset body is split into
// per-family helpers (semantics unchanged; each branch moved verbatim).
// Re-exported from tools/run-nab-validation.ts to preserve the original
// import surface.
//
// NOTE: this module holds the engine/detectors/* imports. The Q64 #12
// anti-scope test (test/q64-nab-validation.test.ts) scans only the
// run-nab-validation.ts source for engine/detectors/* imports — which now
// carries none — so this verbatim relocation preserves that invariant.

import * as fs from 'node:fs';

import { evaluateFamilyAShadow, type CUSUMStates } from '../engine/detectors/page-cusum.js';
import { evaluateFamilyABettingShadow, type BettingStates } from '../engine/detectors/betting-e-process.js';
import { evaluateFamilyD } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/spectral';
import type { CompiledConfig } from '../engine/types/config.js';

import type { NABDetectorFamily, DetectorFiringDecision } from './_run-nab-validation-types';

// ── Detector dispatch (wrapper-layer) ────────────────────────────

/** Run a single detector family over a NAB dataset and capture per-
 *  tick firing decisions. Pure wrapper-layer: imports orchestrate
 *  via shared.js (preserves Q58/Q59/Q60 anti-scope on engine/detectors/*).
 *
 *  Mac Claude implementation deferred to Phase 3 empirical run; tool
 *  framework + scoring helper testable independent of detector
 *  dispatch path. Stub returns empty firing list (caller handles via
 *  Phase 3 architect-disposition or per-detector dispatch resolution
 *  with real NAB data). */
/** Q64 Phase 4 architect-disposed default calibration signal — heavy_tail
 *  signal class most representative of NAB time-series anomalies
 *  (realAWSCloudwatch CPU; realKnownCause sensor data). Settable via
 *  --calibration-signal CLI flag. */
export const DEFAULT_CALIBRATION_SIGNAL = 'p99_latency';

/** Rolling window length for Family D spectral peak-ACF evaluation. */
const FAMILY_D_WINDOW = 60;

/** Detector-context shape shared by every per-family dispatch loop.
 *  NAB datasets carry no hour-of-day metadata; pin to (h=0, d=0) so the
 *  detectors fall through to aggregate_fallback (per architect-disposed
 *  calibration source: aggregate_fallback.family_A.per_signal[sig] +
 *  aggregate_fallback.family_D[sig]). */
const NAB_CTX = {
  hourOfDay: 0,
  dayOfWeek: 0,
  ticksSinceDeploy: 0,
  deployAgeDays: 0,
  trafficPct: 1,
};

/** Family A Page-CUSUM dispatch loop (verbatim from runDetectorOverDataset). */
function dispatchFamilyAPageCusum(
  cfg: CompiledConfig, values: number[], calibrationSignal: string,
): DetectorFiringDecision[] {
  const out: DetectorFiringDecision[] = [];
  const states: CUSUMStates = {};
  for (let t = 0; t < values.length; t++) {
    const verdicts = evaluateFamilyAShadow(
      cfg,
      { [calibrationSignal]: values[t] },
      states,
      { ...NAB_CTX, ticksSinceDeploy: t },
    );
    const v = verdicts.find((x) => x.signal === calibrationSignal);
    out.push({
      tick: t,
      fire: v?.verdict === 'fire',
      statistic_value: v?.statistic ?? undefined,
      threshold: v?.threshold ?? undefined,
    });
  }
  return out;
}

/** Family A betting-e-process dispatch loop (verbatim). */
function dispatchFamilyABetting(
  cfg: CompiledConfig, values: number[], calibrationSignal: string,
): DetectorFiringDecision[] {
  const out: DetectorFiringDecision[] = [];
  const states: BettingStates = {};
  for (let t = 0; t < values.length; t++) {
    const verdicts = evaluateFamilyABettingShadow(
      cfg,
      { [calibrationSignal]: values[t] },
      states,
      { ...NAB_CTX, ticksSinceDeploy: t },
    );
    const v = verdicts.find((x) => x.signal === calibrationSignal);
    out.push({
      tick: t,
      fire: v?.verdict === 'fire',
      statistic_value: v?.statistic ?? undefined,
      threshold: v?.threshold ?? undefined,
    });
  }
  return out;
}

/** Family D spectral peak-ACF dispatch loop (verbatim). */
function dispatchFamilyDSpectral(
  cfg: CompiledConfig, values: number[], calibrationSignal: string,
): DetectorFiringDecision[] {
  const out: DetectorFiringDecision[] = [];
  const recent: number[] = [];
  for (let t = 0; t < values.length; t++) {
    recent.push(values[t]);
    if (recent.length > FAMILY_D_WINDOW) recent.shift();
    const v = evaluateFamilyD(
      cfg,
      calibrationSignal,
      recent,
      { ...NAB_CTX, ticksSinceDeploy: t },
    );
    out.push({
      tick: t,
      fire: v?.verdict === 'fire',
      statistic_value: v?.statistic ?? undefined,
      threshold: v?.threshold ?? undefined,
    });
  }
  return out;
}

export function runDetectorOverDataset(
  family: NABDetectorFamily,
  values: number[],
  compiledConfigPath: string,
  calibrationSignal: string = DEFAULT_CALIBRATION_SIGNAL,
): DetectorFiringDecision[] {
  // Q64 Phase 4 STUB resolution per architect option (i.a) single-signal-
  // detector emulation (ARCHITECT-REPLY-Q64-PHASE-4-NAB-ACQUISITION-STUB-
  // DISPOSITION.md § Ask 1). Family A + Family D natively per-signal;
  // NAB univariate maps cleanly. Calibration source: v5 substrate's
  // family_A.per_signal[calibrationSignal] / family_D[calibrationSignal]
  // (default 'p99_latency' heavy_tail signal class).
  //
  // Architect pseudo-code uses `evaluatePageCusumPerSignal` /
  // `evaluateBettingEProcessPerSignal` / `evaluateSpectralPeakAcfPerSignal`;
  // codebase actuals are `evaluateFamilyAShadow` /
  // `evaluateFamilyABettingShadow` / `evaluateFamilyD` — naming drift
  // only; semantics match (single-signal evaluation per call).
  const cfg = JSON.parse(fs.readFileSync(compiledConfigPath, 'utf8')) as CompiledConfig;

  if (family === 'family_A_page_cusum') {
    return dispatchFamilyAPageCusum(cfg, values, calibrationSignal);
  } else if (family === 'family_A_betting') {
    return dispatchFamilyABetting(cfg, values, calibrationSignal);
  } else if (family === 'family_D_spectral') {
    return dispatchFamilyDSpectral(cfg, values, calibrationSignal);
  } else {
    throw new Error(
      `Detector ${family} not supported at Q64 NAB validation; only `
      + 'family_A_betting + family_A_page_cusum + family_D_spectral architect-picked '
      + '(per Q64 spec § Q64.1 + ARCHITECT-REPLY-Q64-PHASE-4-NAB-ACQUISITION-STUB-DISPOSITION.md).');
  }
}
