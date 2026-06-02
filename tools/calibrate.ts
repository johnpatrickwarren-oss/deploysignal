// tools/calibrate.ts — Week-1 NS calibration compiler (slim facade).
//
// Reads a healthy BaselineBundle (from tools/gen-synthetic-baseline.ts) and an
// α-budget, and emits a CompiledConfig whose Family B cutoffs reproduce today's
// hand-tuned thresholds (engine/gates/policy.ts THRESHOLD_PROFILES._default)
// within ±5%, plus Family A/C/D/E per-cell calibration.
//
// D-54-3 god-file decomposition — the former ~2938-line monolith is split
// into cohesive `tools/calibrate/_calibrate-*.ts` submodules (types,
// constants, aggregator, tenant-tiers, data-prep, family-wrappers, audits,
// derive-cells, family-d-stamp, main, worker-pool). This file is now a slim
// entrypoint/facade that re-exports the exact public surface every external
// importer of `tools/calibrate` relies on, and keeps the CLI `main()`
// auto-run gate. Code was moved VERBATIM; no numeric/statistical computation
// changed.
//
// CLI:
//   node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 \
//                           --alpha 1e-3 \
//                           --out runs/compiled-configs/v1-legacy-equivalent.json

import { isMainThread } from 'node:worker_threads';
import { main } from './calibrate/_calibrate-main.js';

// ── Public export surface (every name imported elsewhere from
//    `tools/calibrate` must remain importable here) ──────────────────

// Phase-timing finalization + compile aggregator factory (tests:
// compile-phases-instrumentation.test.ts).
export {
  finalizePhaseTimings,
  newCompileAggregatorExported,
} from './calibrate/_calibrate-aggregator.js';
export type { CompileAggregator, PhaseTimingsNs } from './calibrate/_calibrate-types.js';

// Tenant-tier bucketing (tests: tenant-tier-bucketing.test.ts).
export {
  DEFAULT_TENANT_TIER_CONFIG,
} from './calibrate/_calibrate-constants.js';
export {
  assignTier,
  buildTenantTierMap,
  hashTenantTierConfig,
} from './calibrate/_calibrate-tenant-tiers.js';

// Family C per-cell wrapper (tests: compile-phases-instrumentation.test.ts,
// compile-mcd-skip-low-variance.test.ts).
export { buildFamilyCPerCell } from './calibrate/_calibrate-family-wrappers.js';

// Re-export fastMCD from the extracted module so test/mcd.test.ts and any
// other import-from-'tools/calibrate' consumers keep working byte-compatibly.
export { fastMCD } from './calibrators/family-c.js';

// Family E selector + resolver symbols (tests:
// variant-selector-migration.test.ts).
export {
  resolveFamilyEVariantSelector,
  buildFamilyEPerCell,
  buildFamilyEPerCellUnweighted,
} from './calibrators/family-e.js';
export type { FamilyEVariantSelector } from './calibrators/family-e.js';

// Re-export the CLI entrypoint so callers that import `main` keep working.
export { main } from './calibrate/_calibrate-main.js';

// Auto-run main() only when invoked in CLI mode. When imported as a
// module — e.g., from test/mcd.test.ts exercising the `fastMCD` helper
// — main() does not run. Gated on the presence of `--baseline` in
// argv so the check is independent of module system (CJS vs ESM).
// Under Node 25 TS loader, `require.main === module` isn't reliable.
//
// Workers spawned via `new Worker(__filename)` load the worker-pool module
// directly (not this facade), so they never reach this gate; the
// `isMainThread` guard is retained for defense-in-depth.
if (isMainThread && process.argv.some((a) => a === '--baseline')) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
