// engine/audit.ts — Audit log writer + record builder (facade).
//
// This module was split for cohesion/size; it now re-exports the stable
// public surface verbatim from sibling _audit-* modules. The public API is
// load-bearing (consumed by orchestrator.ts and the audit test suite), so
// every name importable from here historically remains importable here.
//
//   createAuditWriter  → engine/_audit-writer.ts
//   buildAuditRecord   → engine/_audit-record.ts (v2 helpers in _audit-families.ts)

export { createAuditWriter } from './_audit-writer';
export { buildAuditRecord } from './_audit-record';
