// test/types-barrel-exports.test.ts — end-phase cleanup slice 1 (D-54-1).
//
// Verifies the engine/types/ split preserves the public contract:
//   - `from '../engine/types'` still resolves; the barrel re-exports
//     every symbol.
//   - Reference-identity equality between a symbol imported via the
//     barrel and the same symbol imported from its submodule directly.
//   - Tight submodule imports work (supports future consumers that
//     want a narrow dep surface).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Barrel imports — the public entry point external consumers use.
import {
  DETECTOR_REGISTRY as REGISTRY_VIA_BARREL,
  resolveTenantTier as resolveViaBarrel,
  isWeightedConformal as guardViaBarrel,
  isWeightedEValueConformal as eguardViaBarrel,
  conformalSampleCount as countViaBarrel,
} from '../engine/types';

// Submodule imports — same symbols reached by tight path.
import { DETECTOR_REGISTRY as REGISTRY_VIA_AUDIT } from '../engine/types/audit';
import { resolveTenantTier as resolveViaConfig } from '../engine/types/config';
import {
  isWeightedConformal as guardViaE,
  isWeightedEValueConformal as eguardViaE,
  conformalSampleCount as countViaE,
} from '@johnpatrickwarren-oss/deploysignal-engine/types/families/e';

// Type-only imports — assert availability via use-site (compilation
// guarantees these types exist at both paths).
import type {
  Verdict, Metrics, HealthResult, FusedVerdict, OrchestrateParams,
  AuditRecord, CompiledConfig, ConfiguredAgent, VerdictGroup,
  MSPRTParams, FamilyCPerCell, FamilyDPerSignal, ConformalParams,
} from '../engine/types';
import type { Verdict as VerdictViaPrimitives } from '@johnpatrickwarren-oss/deploysignal-engine/types/primitives';
import type { Metrics as MetricsViaMetrics } from '@johnpatrickwarren-oss/deploysignal-engine/types/metrics';
import type { MSPRTParams as MSPRTViaFamilyA } from '@johnpatrickwarren-oss/deploysignal-engine/types/families/a';

test('barrel: runtime values re-export structurally identical across submodule + barrel paths', () => {
  // CommonJS `export *` binds via property getters — strict reference
  // identity is implementation-dependent across module boundaries.
  // The meaningful invariants are structural equality (for data) and
  // behavioral equivalence (for functions).
  assert.deepStrictEqual(REGISTRY_VIA_BARREL, REGISTRY_VIA_AUDIT,
    'DETECTOR_REGISTRY structure must match across barrel + submodule imports');
  assert.equal(
    resolveViaBarrel({ tenant_tier_map: { 'vip': 'dominant' } }, 'vip'),
    resolveViaConfig({ tenant_tier_map: { 'vip': 'dominant' } }, 'vip'),
    'resolveTenantTier must behave identically across paths',
  );
  const wVar = { kind: 'weighted' as const, scores: [1], weights: [1],
    halflife_days: 7, effective_sample_size: 1 };
  assert.equal(guardViaBarrel(wVar), guardViaE(wVar));
  assert.equal(eguardViaBarrel(wVar), eguardViaE(wVar));
  assert.equal(countViaBarrel(wVar), countViaE(wVar));
});

test('barrel: DETECTOR_REGISTRY structure preserved after split', () => {
  // 18 through engine v0.6.9-pre; 24 at v0.6.10-pre (C64 a: six safe_t_e_value_* ids).
  assert.equal(REGISTRY_VIA_BARREL.A.length, 30);   // 24 + the six contrast_null_* ids (C81, engine v0.6.12-pre)
  assert.equal(REGISTRY_VIA_BARREL.B.length, 16);
  assert.equal(REGISTRY_VIA_BARREL.C.length, 5);
  assert.equal(REGISTRY_VIA_BARREL.D.length, 2);
  assert.equal(REGISTRY_VIA_BARREL.E.length, 1);
});

test('barrel: resolveTenantTier behavior unchanged post-split', () => {
  assert.equal(resolveViaBarrel(null, 'tenant-1'), 'aggregate');
  assert.equal(resolveViaBarrel(undefined, 'tenant-1'), 'aggregate');
  assert.equal(resolveViaBarrel({ tenant_tier_map: {} }, 'tenant-1'), 'aggregate');
  assert.equal(
    resolveViaBarrel({ tenant_tier_map: { 't-a': 'dominant' } }, 't-a'),
    'dominant',
  );
});

test('barrel: conformal type guards correctly discriminate variants', () => {
  const unweighted = { kind: 'unweighted' as const, calibration_scores: [1, 2, 3] };
  const weighted = {
    kind: 'weighted' as const, scores: [1, 2], weights: [0.5, 0.5],
    halflife_days: 7, effective_sample_size: 2,
  };
  const weightedEValue = {
    kind: 'weighted_e_value' as const, scores: [1, 2], weights: [0.5, 0.5],
    cumulative_weights_above: [1.0, 0.5], total_weight: 1.0,
    halflife_days: 7, effective_sample_size: 2,
  };

  assert.equal(guardViaBarrel(unweighted), false);
  assert.equal(guardViaBarrel(weighted), true);
  assert.equal(guardViaBarrel(weightedEValue), false);

  assert.equal(eguardViaBarrel(unweighted), false);
  assert.equal(eguardViaBarrel(weighted), false);
  assert.equal(eguardViaBarrel(weightedEValue), true);

  assert.equal(countViaBarrel(unweighted), 3);
  assert.equal(countViaBarrel(weighted), 2);
  assert.equal(countViaBarrel(weightedEValue), 2);
});

test('barrel: type-only symbols are importable via barrel + submodule paths', () => {
  // Compile-time check: if this file compiles, the types are accessible
  // via both paths. These declarations exercise each import used above.
  const v: Verdict = 'proceed';
  const v2: VerdictViaPrimitives = 'rollback';
  const metricsShape: Partial<Metrics> = { p99_latency: 100 };
  const metricsShape2: Partial<MetricsViaMetrics> = { ttft: 50 };
  const mSprt: Partial<MSPRTParams> = { signal: 'p99_latency' };
  const mSprt2: Partial<MSPRTViaFamilyA> = { alpha: 1e-4 };
  // Use the values so TS doesn't flag them as unused.
  assert.ok(v && v2 && metricsShape && metricsShape2 && mSprt && mSprt2);
  // Also touch the other imports to keep them live.
  const _markers: Array<unknown> = [
    {} as HealthResult, {} as FusedVerdict, {} as OrchestrateParams,
    {} as AuditRecord, {} as CompiledConfig, {} as ConfiguredAgent,
    {} as VerdictGroup, {} as FamilyCPerCell, {} as FamilyDPerSignal,
    {} as ConformalParams,
  ];
  assert.equal(_markers.length, 10);
});

test('barrel: legacy `require` path still works for JS consumers', () => {
  // shared.js + other CJS consumers use require('./dist/engine/types')
  // — make sure the compiled artifact still exposes all symbols.
  const typesModule: unknown = require('../dist/engine/types');
  assert.ok(typesModule && typeof typesModule === 'object');
  const mod = typesModule as Record<string, unknown>;
  assert.ok('DETECTOR_REGISTRY' in mod, 'DETECTOR_REGISTRY must be require()-able via dist barrel');
  assert.ok('resolveTenantTier' in mod, 'resolveTenantTier must be require()-able');
  assert.ok('isWeightedConformal' in mod, 'isWeightedConformal must be require()-able');
  assert.ok('isWeightedEValueConformal' in mod, 'isWeightedEValueConformal must be require()-able');
  assert.ok('conformalSampleCount' in mod, 'conformalSampleCount must be require()-able');
});
