// tools/calibrate/_calibrate-worker-pool.ts — REPLY-50 D2 worker_threads pool
// for embarrassingly-parallel per-cell FastMCD/MRCD dispatch. Extracted
// VERBATIM from the pre-split tools/calibrate.ts god-file (D-54-3 god-file
// decomposition).
//
// The pool self-spawns worker threads via `new Worker(__filename)`; on load
// inside a worker, the worker-mode handler at the bottom of THIS module
// consumes `buildCell` messages and replies with the computed FamilyCPerCell
// + local phase timings. Because `__filename` resolves to this module, the
// worker-mode entry MUST live here alongside the pool.
//
// Determinism: fastMCD's PRNG seed is module-level constant; each call
// creates its own local mulberry32 instance, so parallel execution across
// workers produces bit-identical output to serial execution. MRCD inherits
// the same determinism.
//
// Serial fallback: when `cpu_count <= 2` (CI 2-core runners per Q1) OR when
// worker-pool spawning fails (sandboxed environments), the compile falls
// back to in-process serial calls — no regression vs pre-slice-2 behavior.

import * as os from 'node:os';
import {
  isMainThread, parentPort, Worker,
} from 'node:worker_threads';
import { buildFamilyCPerCell as _buildFamilyCPerCellPure } from '../calibrators/family-c.js';
import type { BuildCellTask, BuildCellReply } from './_calibrate-types.js';

export class CellWorkerPool {
  private readonly workers: Worker[];
  private readonly idle: number[] = [];
  private readonly pending: Map<number, {
    resolve: (r: BuildCellReply) => void;
    reject: (err: Error) => void;
    workerIdx: number;
  }> = new Map();
  private readonly taskQueue: Array<{
    task: BuildCellTask;
    resolve: (r: BuildCellReply) => void;
    reject: (err: Error) => void;
  }> = [];
  private nextTaskId = 1;

  constructor(size: number) {
    this.workers = new Array<Worker>(size);
    for (let i = 0; i < size; i++) {
      const w = new Worker(__filename, { argv: [] });
      this.workers[i] = w;
      this.idle.push(i);
      w.on('message', (reply: BuildCellReply) => this.onReply(i, reply));
      w.on('error', (err: unknown) => {
        this.onWorkerError(i, err instanceof Error ? err : new Error(String(err)));
      });
    }
  }

  run(spec: Omit<BuildCellTask, 'id'>): Promise<BuildCellReply> {
    return new Promise((resolve, reject) => {
      const task: BuildCellTask = { ...spec, id: this.nextTaskId++ };
      if (this.idle.length > 0) {
        const workerIdx = this.idle.pop()!;
        this.pending.set(task.id, { resolve, reject, workerIdx });
        this.workers[workerIdx].postMessage(task);
      } else {
        this.taskQueue.push({ task, resolve, reject });
      }
    });
  }

  private onReply(workerIdx: number, reply: BuildCellReply): void {
    const p = this.pending.get(reply.id);
    if (!p) return;
    this.pending.delete(reply.id);
    if (reply.error) p.reject(new Error(reply.error));
    else p.resolve(reply);
    // Dispatch next queued task to this worker or return it to idle.
    if (this.taskQueue.length > 0) {
      const next = this.taskQueue.shift()!;
      this.pending.set(next.task.id, { resolve: next.resolve, reject: next.reject, workerIdx });
      this.workers[workerIdx].postMessage(next.task);
    } else {
      this.idle.push(workerIdx);
    }
  }

  private onWorkerError(workerIdx: number, err: Error): void {
    // Fail any pending task dispatched to this worker.
    for (const [id, p] of this.pending.entries()) {
      if (p.workerIdx === workerIdx) {
        this.pending.delete(id);
        p.reject(err);
      }
    }
  }

  async terminate(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

export function chooseWorkerPoolSize(): number {
  const cpu = os.cpus().length;
  // Q1 fallback: CI 2-core runners → serial in-process (pool size 1
  // bypasses worker spawning below).
  return Math.min(Math.max(cpu - 1, 1), 8);
}

// ── Worker-mode entry ───────────────────────────────────────────────
//
// When this module is loaded inside a worker thread (via
// `new Worker(__filename)` from the main thread's pool), this block
// sets up a message handler and skips any CLI entry. BigInt serializes
// across postMessage via structured clone (Node ≥ 16), so phase-timing
// deltas transfer cleanly.
//
// Slice-3d — worker returns the pure family-c.ts FamilyCBuildResult
// shape directly. No worker-local module state; no mid-message snapshot.
// Main-thread `dispatchBuildCell` unpacks into the compile-local
// aggregator identically to the serial path.

if (!isMainThread && parentPort) {
  parentPort.on('message', (task: BuildCellTask) => {
    try {
      const { result, timings, diagnostics } = _buildFamilyCPerCellPure(
        task.rows, task.opts, task.key, task.alphaMMD,
      );
      const reply: BuildCellReply = {
        id: task.id,
        result: { result, timings, diagnostics },
      };
      parentPort!.postMessage(reply);
    } catch (err) {
      const reply: BuildCellReply = {
        id: task.id,
        error: err instanceof Error ? err.message : String(err),
      };
      parentPort!.postMessage(reply);
    }
  });
}
