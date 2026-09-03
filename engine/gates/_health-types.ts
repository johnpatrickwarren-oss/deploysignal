// engine/gates/_health-types.ts — shared types/constants for the G1 Health
// Signal Service. Lives in its own module (not the facade) so the defs and
// detector helpers can import it without creating a cycle through health.ts.

import type {
  CompiledConfig, SchemaContinuityRecord,
} from '../types';
import type { ValidPathOpts } from './_health-valid-path';

/** Week 2+3 Family A/C context. Optional — when omitted, the
 *  ratio-detector path is unchanged. When `compiledConfig.baseline_cells`
 *  has Family A populated, Page-CUSUM promotes to primary; when Family C
 *  is populated, Hotelling T² runs alongside at the end of the cascade. */
export interface HealthOpts {
  compiledConfig?: CompiledConfig | null;
  currentHourOfDay?: number;
  /** Week 3: day-of-week (0..6) for 2-D cell lookup. When absent, cell
   *  matching ignores day_of_week (works for 1-D configs). */
  currentDayOfWeek?: number;
  ticksSinceDeploy?: number;
  deployAgeDays?: number;
  /** Week 5 §S6: Addition #8 schema-continuity class for the live stream
   *  this tick. Threaded through to Family A/C/D/E detectors; Family B is
   *  unaffected per spec. */
  schemaContinuityClass?: SchemaContinuityRecord['schema_continuity'];
  /** Week 6+ Addition #13 (per ARCHITECT-REPLY-31 correction): signals
   *  whose live observation lies inside the operator's ignore band.
   *  Threaded to Family A (single-signal mSPRT) only — Family A
   *  suppresses the specific matching signal with
   *  `suppression_reason: 'ignore_threshold'` and emits
   *  `ignore_threshold_trigger_signal: signalId`. Multivariate families
   *  (C Hotelling T², E conformal Mahalanobis) evaluate the full joint
   *  vector regardless of `ignoredSignals` state — in-band signals
   *  contribute near-zero to the Mahalanobis quadratic form naturally,
   *  so explicit suppression would be redundant and would silence those
   *  families on other-signal drift the operator didn't intend to
   *  ignore. Family B structural signatures are similarly unaffected.
   *  Absent → treated as an empty set. */
  ignoredSignals?: Set<string>;
  /** Addition #23 — tenant_id for the request(s) this tick. Detector-
   *  family shadow evaluators resolve this to `tenant_tier` via
   *  `compiledConfig.tenant_tier_map` and look up `(hour, day,
   *  tenant_tier)` cells. Absent or unmapped → `'aggregate'` tier
   *  (backward compat with pre-#23 configs). */
  tenantId?: string;
  /** C64 (a) — the envelope-valid terminal path (engine/gates/_health-valid-path.ts). Absent →
   *  the path is inert and the gate is byte-identical. Threaded from
   *  `OrchestrateParams.validPath`. */
  validPath?: ValidPathOpts;
  /** C64 (a) — true on the canary's last tick (`tick >= totalTicks − 1`); the valid path reads
   *  its terminal e-value once, here, and never before. Set by the orchestrator. */
  terminalLook?: boolean;
}

/** Ratio detector IDs whose per-signal job is owned by Family A CUSUM
 *  once the swap in 2.1.g lands. Fires for these IDs get redirected to
 *  `HealthResult.family_A_legacy_shadow` for one comparison cycle.
 *  Composite detectors that *reference* these signals (`compound_lat`,
 *  `tok_econ`, `slowbleed`) stay on the primary path — they key on
 *  multi-signal structure, not a single CUSUM-covered signal. */
export const FAMILY_A_RETIRED_RATIO_IDS = new Set<string>([
  'p99', 'ttft', 'downstream', 'cost',
  'eval_quality_drop', 'tool_call_degradation',
]);
