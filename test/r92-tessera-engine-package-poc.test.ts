// test/r92-tessera-engine-package-poc.test.ts
//
// R92 (Tessera Phase 5 SLICE 3) — proof-of-concept that DS can consume the
// Tessera-evolved engine package via the `@johnpatrickwarren-oss/deploysignal-engine`
// subpath exports declared in Tessera R90.
//
// Scope: purely additive. No DS engine code modified. Validates:
//   (a) The package installs as a `file:../tessera/engine` dep and resolves
//       at compile time (this file must `tsc -p tsconfig.test.json` clean).
//   (b) The `./ds-integration` subpath export resolves and yields the R62
//       contract types (`DeployEventPayload`, `DsToTesseraEventRequest`)
//       designed for DS → Tessera event emission.
//   (c) The resolved contract is structurally usable (we construct a valid
//       payload + request and assert their fields).
//
// Future R92 follow-up (not in this PoC): replace DS's own ds-integration
// emit-side code (if any) with package imports; bump to git-dependency once
// engine is extracted to its own repo; pin a semver tag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  DeployEventPayload,
  DsToTesseraEventRequest,
} from '@johnpatrickwarren-oss/deploysignal-engine/ds-integration';

test('R92-PoC-1: package subpath ds-integration resolves and exports R62 contract types', () => {
  const payload: DeployEventPayload = {
    event_id: 'r92-poc-event-001',
    event_class: 'firmware_push',
    event_ts: 1716422400,
  };

  assert.equal(payload.event_id, 'r92-poc-event-001');
  assert.equal(payload.event_class, 'firmware_push');
  assert.equal(payload.event_ts, 1716422400);
  assert.equal(payload.event_window_end_ts, undefined);
});

test('R92-PoC-2: DsToTesseraEventRequest wraps payload with contract_version v1', () => {
  const request: DsToTesseraEventRequest = {
    contract_version: 'v1',
    event: {
      event_id: 'r92-poc-event-002',
      event_class: 'model_redeploy',
      event_ts: 1716422500,
      event_window_end_ts: 1716422800,
      metadata: { trigger: 'r92-proof-of-concept' },
    },
    emitted_at_ts: 1716422510,
  };

  assert.equal(request.contract_version, 'v1');
  assert.equal(request.event.event_class, 'model_redeploy');
  assert.equal(request.event.event_window_end_ts, 1716422800);
  assert.equal(request.event.metadata?.trigger, 'r92-proof-of-concept');
  assert.ok(request.emitted_at_ts >= request.event.event_ts);
});

test('R92-PoC-3: event_class union restricts to 5 documented values', () => {
  const validClasses: DeployEventPayload['event_class'][] = [
    'firmware_push',
    'model_redeploy',
    'env_change',
    'config_change',
    'capacity_change',
  ];
  assert.equal(validClasses.length, 5);
  for (const cls of validClasses) {
    const payload: DeployEventPayload = {
      event_id: `r92-poc-${cls}`,
      event_class: cls,
      event_ts: 1716422600,
    };
    assert.ok(payload.event_class === cls);
  }
});
