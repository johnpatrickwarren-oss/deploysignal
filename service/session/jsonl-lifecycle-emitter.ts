// service/session/jsonl-lifecycle-emitter.ts — Task 4 (WS4
// session-durability-argo plan): durable JSONL implementation of
// engine/o0/lifecycle-events.ts's LifecycleEventEmitter contract.
//
// Session begin/end are already durable in SessionRecord itself
// (Task 3, service/session/session-store.ts); this emitter durably
// persists the EXISTING o0 lifecycle event union — evaluation.triggered/
// started/tick/suppressed/finished plus the consolidated
// verdict_group.*/agent_proposal.* events — with NO extension of
// LifecycleEventType. Addition #15 (unlanded, feat/addition-15-lifecycle)
// plans its own JsonlLifecycleEventEmitter scoped inside
// tools/recalibrate/_recalibrate-store.ts; this one ships independently
// in service/session/ per OQ-6 — converge the two implementations
// post-merge, once both branches have landed. Neither branch touches
// engine/o0/lifecycle-events.ts's union from this side, so there is no
// merge conflict.
//
// Fail-loud like Task 1's audit writer: emit() never rejects/throws —
// engine/o0/lifecycle-events.ts's safeEmit() fire-and-forget contract
// expects that (real adapters own their own error paths and must not
// break the deploy flow) — but every fs failure increments a counter
// surfaced via status() instead of being silently discarded.

import * as fs from 'fs';
import * as path from 'path';

import type {
  LifecycleEventEmitter, LifecycleEventPayload, LifecycleEventType,
} from '../../engine/o0/lifecycle-events';

export interface JsonlLifecycleEventEmitterStatus {
  errors: number;
  last_error: string | null;
  healthy: boolean;
}

export interface RecordedLifecycleLine {
  at: string;
  type: LifecycleEventType;
  payload: LifecycleEventPayload;
}

export class JsonlLifecycleEventEmitter implements LifecycleEventEmitter {
  private errors = 0;
  private lastError: string | null = null;

  constructor(private readonly filePath: string) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (e) {
      this.recordFailure(e);
    }
  }

  async emit(t: LifecycleEventType, p: LifecycleEventPayload): Promise<void> {
    const line: RecordedLifecycleLine = { at: new Date().toISOString(), type: t, payload: p };
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (e) {
      this.recordFailure(e);
    }
    // Never rejects — mirrors engine/o0/lifecycle-events.ts's safeEmit(),
    // which the orchestrator hot path relies on for fire-and-forget
    // emission.
  }

  status(): JsonlLifecycleEventEmitterStatus {
    return { errors: this.errors, last_error: this.lastError, healthy: this.errors === 0 };
  }

  readAll(): RecordedLifecycleLine[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      // ENOENT: file never written. ENOTDIR: the events-file path itself
      // is unwritable (e.g. its parent is a plain file, not a
      // directory) — the same condition emit() already recorded via
      // status(). Either way, readAll() is a query, not the fail-loud
      // write path: "nothing durable yet" is the correct answer.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw e;
    }
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RecordedLifecycleLine);
  }

  private recordFailure(e: unknown): void {
    this.errors++;
    this.lastError = e instanceof Error ? e.message : String(e);
  }
}
