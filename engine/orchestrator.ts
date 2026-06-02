// engine/orchestrator.ts — five-gate orchestrator (facade).
// Sequence: G4 (blast radius) → G2 (policy) → G5 (approval) → G3 (state) → G1 (health).
// Each gate may short-circuit and emit a verdict via the audit writer.
//
// This module was split for cohesion (god-file → submodules). The public
// surface is unchanged: `evaluate` re-exports from `_orchestrator-evaluate`.
// Implementation lives in sibling `_orchestrator-*.ts` modules:
//   - _orchestrator-evaluate.ts   — entrypoint + gate-stage decomposition
//   - _orchestrator-config.ts     — compiled-config threshold overlay
//   - _orchestrator-fanout.ts     — post-L3 grouping + parallel fan-out
//   - _orchestrator-lifecycle.ts  — Addition #14 lifecycle emission helpers

export { evaluate } from './_orchestrator-evaluate';
