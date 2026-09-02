// engine/types/evidence-surface.ts — per-detector evidence surface.
//
// Mirrors @johnpatrickwarren-oss/deploysignal-engine/types/verdict-extensions/
// evidence-surface (ADR 0027); replace with the package import at the re-pin
// that carries it. Structurally identical to the engine's definition so the
// swap is a one-line import change with no shape migration.
//
// Emitted only by the multiplicative wealth detectors — Family A betting
// e-process and mixture, Family C safe-Hotelling and betting e-process,
// Family D spectral e-detector. Absent on every other verdict and absent
// entirely on package versions that predate ADR 0027, so every consumer
// in this repo reads it as optional and behaves identically without it.

/** Which threshold `log_threshold` is the log of. `'ville'` is the
 *  nominal `1/α`; `'bootstrap'` is the calibrator's empirical quantile
 *  that ships in place of it (knowledge stats/ville-guarantee-is-
 *  empirical: median 2.4e4 × 1/α for Family A betting); `'priced'` is a
 *  threshold set from a cost model rather than a false-alarm rate. */
export type ThresholdKind = 'ville' | 'bootstrap' | 'priced';

/** The detector's wealth-process bookkeeping at one tick, on the scale
 *  evidence actually accrues on (nats), alongside the linear
 *  `statistic`/`threshold` pair that `DetectorVerdict` already carries.
 *
 *  Validity boundary: these fields are evidence only when the wealth
 *  process is a supermartingale under H0, which holds iff the compiled
 *  baseline parameters are the truth. On an estimated-baseline path
 *  they are the detector's bookkeeping, not evidence — the Family A
 *  plug-in detectors are recorded at E[e|H0] → ~1e8 under estimated
 *  baselines (engine `detectors/validity-envelope.ts`; knowledge
 *  stats/validity-premise-chain). `anytime_p` in particular is only an
 *  anytime-valid p-value under that premise. */
export interface EvidenceSurface {
  /** Exact `log M_t` (nats). */
  log_wealth: number;
  /** Realized `Δ log M` this tick; `null` if wealth was not advanced. */
  log_increment: number | null;
  /** `λ_t`; `null` for mixture / likelihood-ratio detectors. */
  bet: number | null;
  /** Wealth updates so far. */
  n: number;
  /** Log of the threshold in force; `null` if no threshold. */
  log_threshold: number | null;
  threshold_kind: ThresholdKind | null;
  /** `log_threshold − log_wealth`; ≤ 0 once crossed. */
  nats_to_threshold: number | null;
  /** `log_wealth / n`; `null` at `n = 0`. */
  growth_rate_hat: number | null;
  /** `max_{s≤t} log M_s`. */
  log_peak_wealth: number;
  /** `min(1, exp(−log_peak_wealth))` — anytime-valid p-value under the
   *  validity premise above. */
  anytime_p: number;
}
