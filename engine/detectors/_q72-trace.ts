// engine/detectors/_q72-trace.ts —
// Q72 Phase 1 instrumentation: env-gated per-tick trace logger for
// `engine/detectors/family-c-betting-e-process.ts`. Goal is to capture
// enough state at every tick to localize the Linux-vs-Darwin divergence
// surfaced in the post-Q67-merge CI cascade (DIAGNOSTIC-CI-MMD-BETTING-
// OVER-FIRING-CASCADE-2026-05-07.md).
//
// Activation: `Q72_TRACE=<path>` enables; file opened append-mode lazily
// on first call. Disabled by default — `q72TraceEnabled()` short-circuits
// to no-op so production runs pay zero overhead.
//
// Output format: JSON Lines (one JSON object per line). Three record
// types tagged by `kind`:
//   - 'process_header'   — emitted once per process at first call
//   - 'cell_header'      — emitted once per (process, cell_key) at first
//                           dispatch to that cell
//   - 'tick'             — emitted once per evaluateFamilyCBettingEProcess
//                           call (the per-tick observation)
//
// All numbers serialized at full IEEE 754 precision (Number.toString
// default; no truncation) so cross-platform diff catches sub-ULP
// divergence at the bit level.
//
// Anti-scope (Q72 Phase 1):
//   - NO trace of any other detector — Q72 scope is family_C betting only.
//   - NO trace at calibration time — substrate-side divergence (if any)
//     is captured indirectly via cell_header dump of betting_e_process_params.
//   - NO file rotation / size cap — typical Q58 #14 run = 8 seeds × ~131
//     ticks × ~20 betting_e_process cells ≈ 21k lines (~5 MB JSONL); fits
//     comfortably in a GHA workflow artifact.

// Q72 SLICE 2 Phase 3.B fix — lazy-import `node:fs` so the browser
// bundle (engine/index.browser.js) can include this module without
// pulling in the node-builtin `fs` (browser bundle has no shim for
// fs.WriteStream). Browser callers always read q72TraceEnabled() ===
// false (no `process.env`), so the lazy import is never triggered.

interface NodeFsLike {
  createWriteStream(path: string, opts: { flags: string }): { write(s: string): void };
}

let _fs: NodeFsLike | null = null;
let _writeStream: { write(s: string): void } | null = null;
let _initialized = false;
let _processHeaderEmitted = false;
const _cellHeadersEmitted = new Set<string>();

/** True iff `Q72_TRACE` env var is set to a non-empty value. */
export function q72TraceEnabled(): boolean {
  return typeof process !== 'undefined'
    && typeof process.env?.Q72_TRACE === 'string'
    && process.env.Q72_TRACE.length > 0;
}

function _ensureStream(): { write(s: string): void } | null {
  if (_initialized) return _writeStream;
  _initialized = true;
  if (!q72TraceEnabled()) return null;
  // Lazy-load node:fs only when trace is actually active.
  // require() is intentional: ES `import` is hoisted to module-load
  // time and would break browser bundling regardless of runtime gating.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _fs = require('node:fs') as NodeFsLike;
  const tracePath = process.env.Q72_TRACE!;
  _writeStream = _fs.createWriteStream(tracePath, { flags: 'a' });
  return _writeStream;
}

function _writeRecord(obj: Record<string, unknown>): void {
  const stream = _ensureStream();
  if (!stream) return;
  stream.write(JSON.stringify(obj) + '\n');
}

/** Emit the once-per-process header at first call. Captures runtime
 *  identity (pid, node version, platform, argv) so the trace consumer
 *  can attribute records to a (Darwin vs Linux) × (seed) tuple. */
export function q72EmitProcessHeader(): void {
  if (_processHeaderEmitted) return;
  if (!q72TraceEnabled()) return;
  _processHeaderEmitted = true;
  _writeRecord({
    kind: 'process_header',
    pid: process.pid,
    argv: process.argv,
    cwd: process.cwd(),
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    started_at: new Date().toISOString(),
  });
}

/** Emit per-cell header on first dispatch to that cell. Captures the
 *  betting_e_process_params snapshot + first-N baseline pool entries
 *  (so substrate divergence between platforms — different bandwidth
 *  or different baseline pool seed output — is observable upstream of
 *  the per-tick state delta).
 *
 *  `pool_first_5` carries the first 5 baseline-pool vectors verbatim;
 *  if Darwin and Linux produce differently-seeded pools (e.g.,
 *  Math.random leakage despite our deterministic seed function), the
 *  divergence shows up here before any tick-level delta. */
export function q72EmitCellHeader(
  cellKey: string,
  bettingParams: Record<string, unknown>,
  poolFirst5: ReadonlyArray<ReadonlyArray<number>>,
  poolSize: number,
): void {
  if (!q72TraceEnabled()) return;
  if (_cellHeadersEmitted.has(cellKey)) return;
  _cellHeadersEmitted.add(cellKey);
  _writeRecord({
    kind: 'cell_header',
    pid: process.pid,
    cell_key: cellKey,
    betting_params: bettingParams,
    pool_size: poolSize,
    pool_first_5: poolFirst5,
  });
}

/** Per-tick state snapshot. Captures BOTH the predecessor state (state
 *  values at function entry) AND the computed deltas this tick produces
 *  — so the consumer can identify whether divergence is (a) carried
 *  forward from a prior tick (state values diverge at entry) or (b)
 *  introduced fresh this tick (entry equal but compute output differs). */
export interface Q72TickRecord {
  cell_key: string;
  tick_id: number;
  /** state values BEFORE this tick's update */
  log_S_t_pre: number;
  ons_lambda_pre: number;
  ons_inverse_hessian_pre: number;
  witness_running_max: number;
  q_count: number;
  q_running_sum_hash: number;  // sum-of-elements; fast cross-platform diff
  /** live input snapshot */
  v_first_3: ReadonlyArray<number>;
  v_sum: number;  // sum-of-elements over full vector; for hash compare
  /** computed this tick */
  F_t: number;
  wealth_factor: number;
  log_factor: number;
  /** state values AFTER this tick's update */
  log_S_t_post: number;
  ons_lambda_post: number;
  ons_inverse_hessian_post: number;
  /** verdict */
  verdict: string;
  fired_this_tick: boolean;
}

export function q72EmitTick(rec: Q72TickRecord): void {
  if (!q72TraceEnabled()) return;
  _writeRecord({
    kind: 'tick',
    pid: process.pid,
    ...rec,
  });
}
