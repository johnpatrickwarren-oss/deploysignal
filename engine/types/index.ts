// engine/types/index.ts — Public type contract barrel.
//
// This file is the boundary between the decision engine and its consumers
// (Phase 2 Prometheus adapter, WS5 security gate, audit replay tooling).
// Types here are stable; widening or narrowing a field is a breaking change.
//
// Hybrid module layout per ARCHITECT-REPLY-54 D-54-1 (Option C):
//   - Semantic modules for cross-cutting types (primitives, metrics,
//     policy, verdict, agent, audit, orchestration, config).
//   - Family subdirectory for family-specific params/state.
// External consumers `from '../types'` resolve here; internal code can
// also tight-import from a submodule path like `from '../types/families/a'`.

export * from '@johnpatrickwarren-oss/deploysignal-engine/types/primitives';
export * from '@johnpatrickwarren-oss/deploysignal-engine/types/metrics';
export * from './families/a';
export * from '@johnpatrickwarren-oss/deploysignal-engine/types/families/b';
export * from './families/c';
export * from './families/d';
export * from '@johnpatrickwarren-oss/deploysignal-engine/types/families/e';
export * from './agent';
export * from './verdict';
export * from '@johnpatrickwarren-oss/deploysignal-engine/types/policy';
export * from './audit';
export * from './config';
export * from './session';
export * from './orchestration';
export * from './recalibration';
