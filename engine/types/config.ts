// engine/types/config.ts — FACADE. CompiledConfig, CompilerOptions, baseline
// bundle shapes, workload-profile types, tenant-tier configuration, and
// compile-phase instrumentation. The declarations live in cohesive
// `_config-*` submodules; this file re-exports the entire surface verbatim so
// every historical `from '.../types/config'` import keeps resolving unchanged.

// ── Tenant-tier configuration + runtime resolution ────────────────
export { resolveTenantTier } from './_config-tenant';
export type { TenantTier, TenantTierConfig } from './_config-tenant';

// ── Baseline bundle / cell shapes, bake profiles, regression profiles ─
export type {
  BundleMetadata,
  RegressionDeltaKind,
  RegressionInjectionPoint,
  RegressionProfile,
  BaselineBundle,
  BaselineCellEntry,
  BaselineCellsConfig,
  BakeProfile,
} from './_config-baseline-bundle';

// ── CompiledConfig + directly-owned satellite types ───────────────
export type {
  WarmupConfig,
  FpClassifierConfig,
  CompiledConfig,
  BaselineCurationDecisionId,
  BaselineCurationDecision,
  BaselineProvenance,
  Warning,
  CompilePhases,
} from './_config-compiled';

// ── CompilerOptions + topology-source pointer ─────────────────────
export type {
  CompilerOptions,
  ConfiguredTopologyRef,
} from '@johnpatrickwarren-oss/deploysignal-engine/types/config';

// ── Reference workload profiles, overrides, effective config ──────
export type {
  WorkloadProfileSliEntry,
  WorkloadProfileBakeEntry,
  WorkloadProfile,
  CustomerOverride,
  EffectiveConfig,
} from './_config-profiles';

// ── Topic 60 report-card + sweep-checkpoint types ─────────────────
export type {
  Q60DetectorFamily,
  ProfileReportCardBlock,
  ShadowCompareBlock,
  SweepCheckpoint,
} from './_config-report-cards';
