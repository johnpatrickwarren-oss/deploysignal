// service/gate-http/_gate-maintenance.ts — R4 in-service maintenance
// scheduler. Converts the recalibrate CLI's lazy `check` due-detection
// (tools/recalibrate/_recalibrate-cli.ts's `runCheck`, exit code 3 =
// calendar due) into ACTION, hosted by this same gate-http service — no
// new daemon.
//
// WRITE-SPLIT DOCTRINE (README.md's ownership table, binding — same
// doctrine _gate-soak.ts's header documents for the soak store): the
// recalibrate CLI is the sole writer of candidates/*.json, active.json,
// soak.json, exclusion-windows.json under
// runs/baseline-history/<service_id>/. This module NEVER writes any of
// those files directly and NEVER imports tools/recalibrate/* (layering:
// service/ -> engine/ only, same D6 precedent _gate-soak.ts follows). It
// acts purely as a SCHEDULER/INVOKER: on each tick it spawns the
// recalibrate CLI as a child process (`node <recalibrate-bin> check ...`,
// and — only when exit code 3/calendar-due AND auto-refresh is enabled —
// `node <recalibrate-bin> refresh ... --creation-reason calendar_safety_net`).
// The CLI remains the sole writer of the recalibration store; this module
// only ever reads the child's exit code/stdout/stderr.
//
// WHY THE COMPILED tools/recalibrate.js, NOT THE RAW .ts (investigation
// finding, load-bearing): tools/recalibrate.ts's own internal imports are
// extensionless (`from './recalibrate/_recalibrate-cli'`, CommonJS-style
// resolution — this repo's tsconfig targets `module: "CommonJS"`).
// Running the raw .ts file directly under Node's native type-stripping
// (`node tools/recalibrate.ts`) makes Node detect ESM syntax (top-level
// `import`/`export`) and switch to its ESM resolver, which does NOT
// auto-append `.js` to extensionless specifiers the way the CJS resolver
// does — the child fails immediately with ERR_MODULE_NOT_FOUND on its own
// first internal import, before ever reaching argv dispatch. The COMPILED
// tools/recalibrate.js (a plain CommonJS file, emitted by
// `tsc -p tsconfig.test.json` — see that config's `include` list, which
// this task adds `tools/recalibrate.ts` to, mirroring the existing
// tools/calibrate.ts precedent) loads via the CJS resolver instead, whose
// extensionless `require()` DOES resolve `./recalibrate/_recalibrate-cli`
// to its sibling `.js` — confirmed by hand: `node tools/recalibrate.ts
// check ...` throws ERR_MODULE_NOT_FOUND; `node tools/recalibrate.js
// check ...` (post `tsc -p tsconfig.test.json`) runs correctly end to
// end. So `resolveRecalibrateBin` below defaults to the repo-relative
// COMPILED path. DS_GATE_RECALIBRATE_BIN (_gate-config.ts) is the
// escape hatch for any deployment that packages/builds this differently
// (e.g. a bundled single-file CLI, or a wrapper script) — set it and this
// module spawns exactly that path instead, no resolution logic involved.
//
// REPO-ROOT RESOLUTION: this file lives at service/gate-http/, so
// `path.resolve(__dirname, '..', '..')` is the repo root — the same
// __dirname-relative-ROOT convention tools/*.js build/report scripts
// already use (tools/build-report-card-io.js: `path.resolve(__dirname,
// '..')`; tools/benchmark-tick-latency.ts: same pattern one level up).
//
// NEVER CRASHES THE SERVER: every method here is safe to call
// unconditionally from server.ts. A spawn failure, a child timeout, a
// non-zero unexpected exit code, or a maintenance-log write failure is
// captured into the run summary / a bounded error counter — never thrown
// into the caller. The one-at-a-time guard means an overlapping tick is a
// silent no-op skip (no history entry), not an error.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_CHILD_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_HISTORY_LIMIT = 20;
const TAIL_MAX_CHARS = 4000; // bounds the in-memory history's per-run stdout/stderr footprint

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/** Test seam — mirrors _gate-session-runtime.ts's `EvaluateFn`/
 *  `setEvaluateFnForTest` pattern: inject a stand-in for the real child-
 *  process spawn so unit tests can drive exit codes/output deterministically
 *  without an actual `node tools/recalibrate.js` subprocess (that real
 *  path IS exercised, once, by the dedicated real-spawn integration test —
 *  see test/gate-maintenance.test.ts). `recalibrateBinPath` is the
 *  recalibrate CLI's own path (e.g. the compiled tools/recalibrate.js, or
 *  a DS_GATE_RECALIBRATE_BIN override) — never called by production code
 *  paths other than the default `defaultExecFile` below, which is the one
 *  place that actually prepends `process.execPath` (the .js file is not
 *  independently executable — see this file's header). */
export type ExecFileFn = (
  recalibrateBinPath: string, args: string[], opts: { cwd: string; timeoutMs: number },
) => Promise<ExecResult>;

function defaultExecFile(
  recalibrateBinPath: string, args: string[], opts: { cwd: string; timeoutMs: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      // Run the recalibrate CLI THROUGH the current node binary
      // (`process.execPath`), not as an executable itself — a plain .js
      // file has no exec bit / shebang, so spawning it directly as `bin`
      // fails EACCES.
      process.execPath,
      [recalibrateBinPath, ...args],
      {
        cwd: opts.cwd, timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            code: 0, stdout, stderr, timedOut: false,
          });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        // execFile's timeout option SIGKILLs the child on expiry; that
        // shows up here as `killed: true, signal: 'SIGKILL'` with no
        // numeric exit code — everything else (a normal non-zero exit,
        // e.g. `check`'s exit code 3) shows up as `err.code` being the
        // numeric exit code itself.
        const timedOut = err.killed === true && err.signal === 'SIGKILL';
        const numericCode = typeof err.code === 'number' ? err.code : null;
        resolve({
          code: numericCode, stdout, stderr, timedOut, error: err.message,
        });
      },
    );
  });
}

function tail(s: string, maxLen = TAIL_MAX_CHARS): string {
  return s.length > maxLen ? s.slice(-maxLen) : s;
}

export interface MaintenanceChildResult {
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  timed_out: boolean;
  error?: string;
}

function toChildResult(r: ExecResult): MaintenanceChildResult {
  return {
    exit_code: r.code,
    stdout_tail: tail(r.stdout),
    stderr_tail: tail(r.stderr),
    timed_out: r.timedOut,
    ...(r.error !== undefined ? { error: r.error } : {}),
  };
}

export interface MaintenanceRunSummary {
  started_at: string;
  finished_at: string;
  check: MaintenanceChildResult;
  auto_refresh_triggered: boolean;
  refresh?: MaintenanceChildResult;
}

export type MaintenanceRunOutcome = MaintenanceRunSummary | { skipped: true };

export interface MaintenanceStatus {
  enabled: boolean;
  auto_refresh: boolean;
  interval_seconds: number;
  last_run: MaintenanceRunSummary | null;
  history_count: number;
}

export interface MaintenanceSchedulerConfig {
  intervalSeconds: number;
  autoRefresh: boolean;
  refreshBundleDir: string | null;
  refreshWindow: string | null;
  /** DS_GATE_RECALIBRATE_BIN override — see this file's header. */
  recalibrateBin: string | null;
  serviceId: string;
  /** Root under which `<baselineHistoryDir>/<serviceId>/` is the
   *  recalibration store this module's spawned children act against
   *  (`check --service <serviceId> --root <baselineHistoryDir>`). Matches
   *  GateRuntimeConfig.baselineHistoryDir exactly. */
  baselineHistoryDir: string;
  /** Session-store root — the durable maintenance.jsonl log lives at
   *  `<storeDir>/<serviceId>/maintenance.jsonl` (session-store side, NOT
   *  the recalibration store — see this file's header). */
  storeDir: string;
  childTimeoutMs?: number;
  historyLimit?: number;
}

/** Repo-relative default: see this file's header for why the COMPILED
 *  .js, not the raw .ts, is the correct default target. Resolved from
 *  `__dirname` (this file's own on-disk location), NOT `process.cwd()` —
 *  the binary lives at a fixed place relative to the repo checkout
 *  regardless of what directory the server process was launched from. */
function resolveRecalibrateBin(override: string | null): string {
  if (override) return override;
  const repoRoot = path.resolve(__dirname, '..', '..');
  return path.join(repoRoot, 'tools', 'recalibrate.js');
}

export class MaintenanceScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly history: MaintenanceRunSummary[] = [];
  private lastRun: MaintenanceRunSummary | null = null;
  private readonly logPath: string;
  private logErrors = 0;
  private lastLogError: string | null = null;
  private execFileFn: ExecFileFn = defaultExecFile;

  constructor(private readonly cfg: MaintenanceSchedulerConfig) {
    this.logPath = path.join(cfg.storeDir, cfg.serviceId, 'maintenance.jsonl');
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    } catch (e) {
      this.recordLogFailure(e);
    }
  }

  /** Test-only seam (mirrors GateSessionRuntime.setEvaluateFnForTest):
   *  injects a stand-in for the real child-process spawn. Never called by
   *  production code paths. */
  setExecFileFnForTest(fn: ExecFileFn): void {
    this.execFileFn = fn;
  }

  isEnabled(): boolean {
    return this.cfg.intervalSeconds > 0;
  }

  /** Starts the interval timer when enabled (intervalSeconds > 0); a
   *  no-op when disabled or already started. The timer is `.unref()`d —
   *  it must never hold the process open on its own (a maintenance tick
   *  in flight at shutdown is abandoned, not awaited; `stop()` just
   *  clears the timer, it doesn't cancel an in-flight child). */
  start(): void {
    if (!this.isEnabled() || this.timer) return;
    const timer = setInterval(() => {
      this.tick();
    }, this.cfg.intervalSeconds * 1000);
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one maintenance cycle now (also what the interval timer calls).
   *  Safe to call directly — e.g. from an operator tool, or a test driving
   *  a deterministic tick. Skips (returns `{skipped: true}`, no history
   *  entry) if a previous run is still executing — the one-at-a-time
   *  guard. */
  async runOnce(): Promise<MaintenanceRunOutcome> {
    return this.tick();
  }

  getStatus(): MaintenanceStatus {
    return {
      enabled: this.isEnabled(),
      auto_refresh: this.cfg.autoRefresh,
      interval_seconds: this.cfg.intervalSeconds,
      last_run: this.lastRun,
      history_count: this.history.length,
    };
  }

  /** Bounded in-memory history (last `historyLimit`, default 20 — never
   *  called by the served request path, only readyz/diagnostics). */
  getHistory(): MaintenanceRunSummary[] {
    return [...this.history];
  }

  getLogStatus(): { errors: number; last_error: string | null } {
    return { errors: this.logErrors, last_error: this.lastLogError };
  }

  private async tick(): Promise<MaintenanceRunOutcome> {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      return await this.runMaintenance();
    } finally {
      this.running = false;
    }
  }

  private async runMaintenance(): Promise<MaintenanceRunSummary> {
    const startedAt = new Date().toISOString();
    const bin = resolveRecalibrateBin(this.cfg.recalibrateBin);
    // Spawn with the SERVER's own process.cwd(), not the repo root the
    // binary itself is resolved from — cfg.baselineHistoryDir/storeDir
    // are commonly relative paths (defaults: 'runs/baseline-history',
    // 'runs/sessions') already resolved by the rest of this service
    // against process.cwd(); the spawned CLI must resolve its own
    // `--root <baselineHistoryDir>` the same way, or a server launched
    // from a directory other than the repo root would point the child at
    // the wrong store.
    const cwd = process.cwd();

    const checkResult = await this.spawnGuarded(
      bin,
      ['check', '--service', this.cfg.serviceId, '--root', this.cfg.baselineHistoryDir],
      cwd,
    );

    let refreshResult: ExecResult | undefined;
    const autoRefreshTriggered = checkResult.code === 3 && this.cfg.autoRefresh;
    if (autoRefreshTriggered) {
      refreshResult = await this.spawnGuarded(
        bin,
        [
          'refresh', '--service', this.cfg.serviceId, '--root', this.cfg.baselineHistoryDir,
          '--bundle-dir', this.cfg.refreshBundleDir as string, '--window', this.cfg.refreshWindow as string,
          '--creation-reason', 'calendar_safety_net',
        ],
        cwd,
      );
    }

    const summary: MaintenanceRunSummary = {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      check: toChildResult(checkResult),
      auto_refresh_triggered: autoRefreshTriggered,
      ...(refreshResult ? { refresh: toChildResult(refreshResult) } : {}),
    };

    this.recordRun(summary);
    return summary;
  }

  /** Never throws — a spawn/execFileFn failure that somehow escapes
   *  `defaultExecFile`'s own error handling (or a broken test stub) is
   *  still captured into the run summary rather than propagating into
   *  `runMaintenance`/the interval timer's callback. */
  private async spawnGuarded(bin: string, args: string[], cwd: string): Promise<ExecResult> {
    try {
      return await this.execFileFn(bin, args, { cwd, timeoutMs: this.cfg.childTimeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS });
    } catch (e) {
      return {
        code: null, stdout: '', stderr: '', timedOut: false, error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private recordRun(summary: MaintenanceRunSummary): void {
    this.lastRun = summary;
    this.history.push(summary);
    const limit = this.cfg.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    if (this.history.length > limit) this.history.splice(0, this.history.length - limit);
    this.appendLog(summary);
  }

  /** Durable, append-only, service-store-side log (never the
   *  recalibration store — see this file's header). Mirrors
   *  service/session/jsonl-lifecycle-emitter.ts's fail-loud-but-never-
   *  throws discipline: an fs failure increments a counter instead of
   *  propagating. */
  private appendLog(summary: MaintenanceRunSummary): void {
    try {
      fs.appendFileSync(this.logPath, `${JSON.stringify(summary)}\n`, 'utf8');
    } catch (e) {
      this.recordLogFailure(e);
    }
  }

  private recordLogFailure(e: unknown): void {
    this.logErrors += 1;
    this.lastLogError = e instanceof Error ? e.message : String(e);
  }
}
