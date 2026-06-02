"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CellWorkerPool = void 0;
exports.chooseWorkerPoolSize = chooseWorkerPoolSize;
const os = __importStar(require("node:os"));
const node_worker_threads_1 = require("node:worker_threads");
const family_c_js_1 = require("../calibrators/family-c.js");
class CellWorkerPool {
    constructor(size) {
        this.idle = [];
        this.pending = new Map();
        this.taskQueue = [];
        this.nextTaskId = 1;
        this.workers = new Array(size);
        for (let i = 0; i < size; i++) {
            const w = new node_worker_threads_1.Worker(__filename, { argv: [] });
            this.workers[i] = w;
            this.idle.push(i);
            w.on('message', (reply) => this.onReply(i, reply));
            w.on('error', (err) => {
                this.onWorkerError(i, err instanceof Error ? err : new Error(String(err)));
            });
        }
    }
    run(spec) {
        return new Promise((resolve, reject) => {
            const task = { ...spec, id: this.nextTaskId++ };
            if (this.idle.length > 0) {
                const workerIdx = this.idle.pop();
                this.pending.set(task.id, { resolve, reject, workerIdx });
                this.workers[workerIdx].postMessage(task);
            }
            else {
                this.taskQueue.push({ task, resolve, reject });
            }
        });
    }
    onReply(workerIdx, reply) {
        const p = this.pending.get(reply.id);
        if (!p)
            return;
        this.pending.delete(reply.id);
        if (reply.error)
            p.reject(new Error(reply.error));
        else
            p.resolve(reply);
        // Dispatch next queued task to this worker or return it to idle.
        if (this.taskQueue.length > 0) {
            const next = this.taskQueue.shift();
            this.pending.set(next.task.id, { resolve: next.resolve, reject: next.reject, workerIdx });
            this.workers[workerIdx].postMessage(next.task);
        }
        else {
            this.idle.push(workerIdx);
        }
    }
    onWorkerError(workerIdx, err) {
        // Fail any pending task dispatched to this worker.
        for (const [id, p] of this.pending.entries()) {
            if (p.workerIdx === workerIdx) {
                this.pending.delete(id);
                p.reject(err);
            }
        }
    }
    async terminate() {
        await Promise.all(this.workers.map((w) => w.terminate()));
    }
}
exports.CellWorkerPool = CellWorkerPool;
function chooseWorkerPoolSize() {
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
if (!node_worker_threads_1.isMainThread && node_worker_threads_1.parentPort) {
    node_worker_threads_1.parentPort.on('message', (task) => {
        try {
            const { result, timings, diagnostics } = (0, family_c_js_1.buildFamilyCPerCell)(task.rows, task.opts, task.key, task.alphaMMD);
            const reply = {
                id: task.id,
                result: { result, timings, diagnostics },
            };
            node_worker_threads_1.parentPort.postMessage(reply);
        }
        catch (err) {
            const reply = {
                id: task.id,
                error: err instanceof Error ? err.message : String(err),
            };
            node_worker_threads_1.parentPort.postMessage(reply);
        }
    });
}
