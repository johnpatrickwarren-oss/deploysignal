# DeploySignal gate-http — Argo Rollouts Level-1 adapter

`service/gate-http/` runs the DeploySignal engine as an ordinary HTTP
service so an Argo Rollouts `AnalysisTemplate` can gate a canary/blue-green
step against it, per `ORCHESTRATION-ADAPTERS.md` §Level 1 ("web metric
provider" — "zero K8s-specific code in the engine... works with anything
that can hit HTTP"). Level 2 (`gate-cli` / Kubernetes Job adapter) and
above are out of scope here.

See `service/gate-http/argo/analysis-template.yaml` for the concrete
`AnalysisTemplate`.

## Session bootstrap — who calls POST /v1/sessions

Argo's `web` metric provider only **polls** `GET /v1/verdict/{deploy-ref}`
— it never POSTs anything. Something upstream of the AnalysisTemplate has
to begin the session first, before the first poll lands, or
`GET /v1/verdict` for an unknown `deploy_ref` returns `404`. In practice
this is a pre-analysis step in the same pipeline that creates/updates the
`Rollout` — e.g. a `PreRolloutAnalysis` hook, a CI job step immediately
before `kubectl apply`/`argo rollouts set image`, or a small init step in
the deployment pipeline that already knows the deploy's `baseline`
metrics, `risk_level`, `change_type`, and `author`. That caller:

1. `POST /v1/sessions` with `deploy_ref` set to the same value the
   `AnalysisTemplate`'s `{{args.deploy-ref}}` will carry (the plan's
   OQ-4 idempotency key — Argo's rollout-revision-scoped ref is unique
   per revision, so retried bootstrap calls are safe: same `deploy_ref`
   while the session is `active` returns the existing session, `200`
   not `201`).
2. Starts pushing ticks (`POST /v1/sessions/{id}/ticks`, see below) on
   its own cadence — independent of Argo's `interval`.
3. Argo's `AnalysisTemplate` starts polling `GET /v1/verdict/{deploy-ref}`
   per its own `interval`/`count`, and acts on the mapped verdict code.

## Metric ingestion model — push, not pull (OQ-2)

`ORCHESTRATION-ADAPTERS.md` deliberately leaves per-Level-1 metric
acquisition undefined: "the gate runs as an ordinary HTTP service" with
its own telemetry. This implementation's default is **push**:
`POST /v1/sessions/{id}/ticks` with `{emitted_at_ts, metrics}` — the
caller (a metrics-shipping sidecar, a Prometheus-scraping cron, an
existing telemetry pipeline) owns polling its own metric source and
pushing observations to the gate. A Prometheus-puller adapter would mean
credentials + a polling loop + a new dependency surface inside the gate
itself, against the zero-new-deps constraint (`node:http`/`node:crypto`
only, matching `tools/claude-proxy.js`'s precedent) — push keeps the
Level-1 adapter minimal; a puller is a natural follow-on, not shipped
here.

Argo's own poll cadence (`interval: 30s` in the example template) is
**independent** of the tick-push cadence — Argo is only reading the
*current* cached verdict (`GET /v1/verdict`, read-only, no side effects),
not driving evaluation itself.

## Verdict mapping

Per `ORCHESTRATION-ADAPTERS.md`'s "Mapping verdict semantics" table,
reproduced by `VERDICT_CODE` in `_gate-session-runtime.ts`:

| DeploySignal verdict | `verdict_code` | Argo analysis status | Argo behavior |
|---|---|---|---|
| `proceed` | `0` | Successful | advance to the next canary step |
| `rollback` | `1` | Failed | trigger Rollout abort/rollback |
| `extend` (incl. G3 deny, any non-terminal tick, e.g. `baking`) | `-1` | Inconclusive | retry next `interval` — exactly right for "come back with more data" |

The `AnalysisTemplate`'s `successCondition`/`failureCondition`/
`inconclusiveCondition` reference these three codes directly
(`result == 0` / `result == 1` / `result == -1`).

## fail_open / fail_closed / shadow

- **`DS_GATE_FAIL_POLICY`** governs every place an internal failure could
  otherwise force a decision: an `evaluate()` throw mid-tick, or an
  `active.json` (WS3 #15) resolution throw at session begin.
  - `fail_closed` (default — "never silently defaults to permissive",
    per `ORCHESTRATION-ADAPTERS.md`'s conservative-default doctrine): a
    tick-evaluation throw records `verdict_code: -1` (Inconclusive, OQ-5
    — not `1`/Failed; Argo's own `count`/`failureLimit` bounds a
    persistently-erroring analysis, so hard-failing the rollout on a
    *gate-internal* error is more aggressive than the doctrine requires).
    A begin-time `active.json` resolution throw returns HTTP `503` —
    the caller (the bootstrap step above) sees the failure and can retry
    or alert, rather than silently starting an unpinned/degraded session.
  - `fail_open`: the same tick throw instead records `verdict_code: 0`
    (proceed) with `degraded: true` alongside; a begin-time throw
    returns `201` with `config_source: 'legacy'` and `degraded: true`
    (the session still starts and evaluates, just without a pinned
    compiled config). Either way the underlying error message is
    recorded durably (`error` field, both in the HTTP response and the
    session's verdict history) — a fail-open decision is never a
    *silent* one.
- **`DS_GATE_MODE=shadow`**: the real verdict is still computed and
  recorded on every tick (`shadow: true` in the durable history), but
  `GET /v1/verdict` always masks to `verdict_code: 0`/`verdict: proceed`
  with `shadow_verdict_code` carrying the real code alongside (OQ-7 — "a
  shadow gate must never block, including during bake"). Use this to run
  the gate against live traffic without it ever being able to fail a
  Rollout, while still collecting the same durable evidence a real gate
  would.

## Restart / void semantics — why a restart voids in-flight sessions

DeploySignal's detector state (`TrendBuffer`'s CUSUM/betting/MMD/
Hotelling/conformal wealth maps — see the WS4 plan's investigation
finding #4) is an e-process: each observation must be bet on **exactly
once**, or the underlying anytime-valid (Ville-bound) guarantee that is
this product's core statistical claim breaks. That state is held
in-memory per session in `GateSessionRuntime`'s runtime map, and that map
does not survive a process restart.

Rather than attempt snapshot/resume (which would require atomic
full-`TrendBuffer` persistence after *every* tick, plus a guarantee that
a resumed tick is never re-applied), this implementation's shipped
default (OQ-1) is **declare-void-and-restart**: `sweepOnBoot()` — called
once at server startup, before `listen()` — durably voids every session
the store still has marked `active` from a prior process's lifetime
(`void_reason: 'service_restart'`). G3 (`engine/gates/state.ts`, fed by
`SessionStore.stateGateContext`) then denies any further tick against a
voided session (`shortCircuit: 'state'`, surfaced over HTTP as `409` from
the pre-tick status check, or as an `extend`/`-1` verdict if a tick
somehow still reaches the runtime directly — defense in depth). A caller
whose analysis was mid-flight across a gate restart needs to begin a new
session for that `deploy_ref` and let Argo's `Inconclusive` retry
semantics absorb the gap.

The idempotency keys and durable per-tick verdict history this
implementation builds (Tasks 3/6) are exactly the prerequisite for a
*future* snapshot-resume implementation — this one does not build resume
itself.

Sessions also void on an idle TTL (`DS_GATE_SESSION_TTL_SECONDS`, default
3600s, `void_reason: 'session_ttl_expired'`) — a lazy sweep run on every
`/v1/*` request (no background timer), so a bootstrap step that begins a
session and then never ticks it does not leak an `active` session
forever.

## Security boundary

The gate binds to `127.0.0.1` by default (`DS_GATE_BIND`) and, when
`DS_GATE_SHARED_SECRET` is set, requires every `/v1/*` request to carry a
matching `x-ds-gate-token` header (constant-time compared;
`/healthz`/`/readyz` are exempt so orchestration/liveness probes never
need the secret). **This is not auth/SSO/RBAC infrastructure** — per the
project's enterprise-infrastructure anti-scope, there is no user
identity, no RBAC, no token issuance/rotation service. Deployers who need
to expose this beyond localhost or a private cluster network front it
with their own ingress auth (mTLS, an API gateway, a service-mesh
authorization policy) — the shared-secret header is a minimum bar against
an accidental open port, not a substitute for that.

## WS3 Addition #15 (`runs/baseline-history/`) — read-only dependency

At session begin, the gate resolves the currently-**active** compiled
calibration for `DS_GATE_SERVICE_ID` by reading exactly
`<DS_GATE_BASELINE_HISTORY_DIR>/<service_id>/active.json` (the WS3
Addition #15 §B contract: `{schema_version, version_id,
compiled_config_path, baseline_ref, ...}`) plus the `CompiledConfig` JSON
it points at. Nothing else in that store (`candidates/`, `events.jsonl`,
promotion history) is read or duplicated here — promotion/candidate
lifecycle is entirely WS3's.

Resolution happens **once**, at session begin, and the result is pinned
on the `SessionRecord` (`active_calibration_version`,
`compiled_config_path`) for that session's entire lifetime — a
mid-session promotion (WS3 atomically swapping `active.json`) never
affects an already-begun session; only a session begun *after* the swap
picks up the new version.

**Graceful `legacy` fallback**: a repo that hasn't landed WS3 Addition
#15 yet (`active.json` absent) is not an error — the session begins with
`config_source: 'legacy'`, `active_calibration_version: 'legacy'`,
`compiled_config_path: null`, and evaluates against the engine's
hand-tuned Family B thresholds only (no compiled per-cell config). Use
`DS_GATE_COMPILED_CONFIG` to point at a specific compiled-config file
directly, bypassing `active.json` resolution entirely
(`config_source: 'override'`) — useful for pre-#15 repos that already
have a hand-picked compiled config, or for pinning a specific version
during a WS3 rollout.

## R5 live shadow soak — candidate evaluation against real traffic

On top of the existing served path, the gate can additionally
shadow-evaluate a **candidate** `CompiledConfig` (an Addition #15
recalibration candidate under review) against the exact same live ticks
a session already serves — no separate traffic replay, no synthetic
scenario generation. This is `service/gate-http/_gate-soak.ts`'s
`SoakController`, wired into `GateSessionRuntime` in Tasks 2-3 (see that
file's header for the enrollment/non-interference/restart-honesty
design). It is driven from the CLI:

```
node tools/recalibrate.ts soak start  --service <id> --candidate-id <id> --requested-by <id> \
     [--target-ticks 200] [--max-duration-seconds <n>]
node tools/recalibrate.ts soak status --service <id>
node tools/recalibrate.ts soak stop   --service <id> --candidate-id <id> --reviewer <id>
```

**R-Q4 posture — soak is ADDITIONAL evidence, it never gates.** There is
no state-machine change: `shadow_validated` (the existing mandatory
replay-comparison gate, `tools/recalibrate/_recalibrate-shadow.ts`)
remains the only route to `reviewable`, and `approve`/`reject` work
identically whether or not a candidate has ever been soaked. A soak
result folded onto `CandidateRecord.soak` (at `soak stop`) is read-only
context for the human reviewer, never an automated decision input.

### Per-file ownership (single-writer doctrine)

The service must durably record soak results in the SAME
`runs/baseline-history/<service_id>/` store the `recalibrate` CLI
already owns. No file ever gets two read-modify-write writers; the one
shared file is append-only:

| File | Owner (sole writer) | Other side |
|---|---|---|
| `store-meta.json`, `candidates/*.json`, `active.json`, `exclusion-windows.json` | recalibrate CLI (unchanged) | service reads only |
| **`soak.json`** (manifest — one soak per service at a time) | recalibrate CLI (`soak start`/`soak stop`) | service polls it read-only, lazily, per tick |
| **`soak/<candidate_id>.state.json`** (sidecar — live accumulated stats) | gate-http service (`SoakController`) | CLI reads only (`soak status`, `show`, fold-on-stop) |
| **`soak/<candidate_id>.ticks.jsonl`** (per-tick evidence log, append-only) | gate-http service | CLI reads only |
| `events.jsonl` | **both** — but strictly append-only: every append is one `fs.appendFileSync` (`'a'`/`O_APPEND`) of a single compact line, atomic for local-filesystem writes well under the page/`PIPE_BUF` limit. This is the sole multi-writer file in the store. | — |

The service never imports `tools/recalibrate/*` — it re-implements the
tiny soak-manifest/sidecar file contract on the read/append side
(`service/gate-http/_gate-soak.ts`), the same precedent
`service/session/active-calibration.ts` set for `active.json`. The
`.gate-runtime.lock` (session-store-scoped) is untouched; no new
lockfile is needed because no read-modify-write file gains a second
writer.

### Enrollment, coverage, and cost

A session joins an active soak only at its own first evaluated tick
(`tick === 0`) — a soak that starts mid-session skips that session
(`sessions_skipped_midstream`) rather than feeding a candidate detector
a truncated warm-up history. Once enrolled, every subsequent tick for
that session runs a **second** `evaluate()` call — against the
candidate's own `TrendBuffer`/lifecycle/fail-fast/reversibility state,
never the served session's — strictly after the served verdict is
computed and durably persisted, in its own try/catch (a shadow-side
failure only increments `candidate_errored_ticks`; it can never affect
the served `TickResult`). Cost: one extra `evaluate()` call at roughly
the same ~30-60μs/tick the served path already costs, plus one small
atomic sidecar write (tmp+rename, ~100μs) per soaked tick — negligible
next to normal tick cadence, and zero when no soak is active (a single
`fs.statSync` per tick).

`soak status` and `show` (once a soak has been folded) report
disagreement counts (`verdict_disagreements`, `would_be_rollback` split
into `active_only`/`candidate_only`/`both`), per-family fire counts, and
coverage (`sessions_enrolled`, `sessions_skipped_midstream`, errored-tick
counts). A restart mid-soak is handled the same way a restart handles
served sessions: in-memory shadow accumulators are lost, but the
sidecar's last flush survives, and the controller appends a durable
`{reason: 'service_restart'}` admission to the sidecar on the next
construction — never a silent gap.

**Re-soak semantics.** Re-`start`ing a soak for the same candidate after its
window *completed* archives the old sidecar/ticks log (timestamp-suffixed)
and starts fresh. Re-starting after an *early stop* (sidecar still
`accumulating`) **resumes** the existing accumulation under the original
window — a new `--target-ticks` takes effect only after the current window
completes. The fold performed at `soak stop` always preserves a durable
snapshot, so neither path loses evidence.

## R4 in-service maintenance scheduler — turning "due" into "acted on"

`tools/recalibrate.ts check` (D2's calendar safety net,
`_recalibrate-sweep.ts`'s `checkCalendarSafetyNet`) already knows how to
*determine* a baseline refresh is due — no recalibration activity since a
calendar threshold, no open candidate in flight — and exits `3` when it
is. Left as a bare CLI subcommand, that's still a lazy check: something
external (a person, a cron entry) has to actually run it and act on the
result. `service/gate-http/_gate-maintenance.ts`'s `MaintenanceScheduler`
closes that gap: an env-gated interval job, hosted by this same gate-http
service process, that periodically runs `check` and — opt-in,
separately — `refresh` when it comes back due. No new daemon; no new
port; no new process to deploy or monitor.

### Config (env vars, `_gate-config.ts`) — DEFAULT OFF

| Var | Default | Meaning |
|---|---|---|
| `DS_GATE_MAINTENANCE_INTERVAL_SECONDS` | `0` (disabled) | How often the scheduler runs `check`. Unset or `0` means the scheduler never even starts a timer — this is an opt-in feature, not an always-on one, matching the "never silently defaults to permissive/active" posture the rest of this service follows. |
| `DS_GATE_MAINTENANCE_AUTO_REFRESH` | `false` (check-only) | `'true'` to actually spawn `refresh` when `check` comes back calendar-due (exit `3`). Default is check-only: due-ness is still detected and logged every interval, but nothing is proposed automatically until an operator opts in. |
| `DS_GATE_REFRESH_BUNDLE_DIR` | — | Bundle directory passed to `refresh --bundle-dir`. **Required** when auto-refresh is enabled. |
| `DS_GATE_REFRESH_WINDOW` | — | Window passed to `refresh --window` (e.g. `trailing-30d`). **Required** when auto-refresh is enabled. |
| `DS_GATE_RECALIBRATE_BIN` | repo-relative `tools/recalibrate.js` | Overrides the resolved path to the recalibrate CLI entry point — see "spawning the CLI" below. |

Validated at **startup**, not lazily at the first scheduled tick:
`loadConfigFromEnv` throws a `GateConfigError` if
`DS_GATE_MAINTENANCE_AUTO_REFRESH=true` is set without both
`DS_GATE_REFRESH_BUNDLE_DIR` and `DS_GATE_REFRESH_WINDOW` — auto-acting on
a calendar-due refresh with nothing to refresh *from* is a configuration
mistake, not a runtime condition to silently degrade around.

### Why the scheduler SPAWNS the CLI, rather than calling it in-process

This is the write-split doctrine (the per-file ownership table earlier in
this README, and `_gate-soak.ts`'s header) applied to a new case:
`candidates/*.json`, `active.json`, `soak.json`, and
`exclusion-windows.json` under `runs/baseline-history/<service_id>/` are
**CLI-owned** — the recalibrate CLI is their sole read-modify-write
writer. `MaintenanceScheduler` must never become a second writer of any of
those files, so it never imports `tools/recalibrate/*` in-process (same
D6 layering `_gate-soak.ts` follows: `service/` → `engine/` only) and
never touches those files directly. Instead, each tick spawns the
recalibrate CLI as an actual child process
(`child_process.execFile`) — the CLI process does its own store I/O
exactly as if an operator had typed the command by hand, and this module
only ever reads back the child's exit code and stdout/stderr. The write
boundary is enforced by OS process isolation, not by code discipline
inside a shared module.

Concretely, each tick:

1. Spawns `check --service <id> --root <baselineHistoryDir>`.
2. If that exits `3` (calendar due) **and** `DS_GATE_MAINTENANCE_AUTO_REFRESH=true`, spawns
   `refresh --service <id> --root <baselineHistoryDir> --bundle-dir <DS_GATE_REFRESH_BUNDLE_DIR> --window <DS_GATE_REFRESH_WINDOW> --creation-reason calendar_safety_net`.
   Exit `3` without auto-refresh enabled is logged and left as-is —
   check-only is the default for a reason.

### Spawning the CLI — why the compiled `tools/recalibrate.js`, not the raw `.ts`

`tools/recalibrate.ts`'s own internal imports are extensionless
(`from './recalibrate/_recalibrate-cli'`, this repo's CommonJS
convention). Running the raw `.ts` file directly under Node's native
type-stripping makes Node detect the top-level `import`/`export` syntax
and switch to its ESM resolver, which — unlike the CommonJS resolver —
does **not** auto-append `.js` to an extensionless specifier; the child
fails immediately with `ERR_MODULE_NOT_FOUND` on its own first internal
import, before ever reaching argv dispatch (confirmed by hand while
building this feature). The **compiled** `tools/recalibrate.js` (a plain
CommonJS file, emitted by `tsc -p tsconfig.test.json` — this task added
`tools/recalibrate.ts` to that config's `include` list, mirroring the
existing `tools/calibrate.ts` precedent; it wasn't previously compiled as
a facade, only its `_recalibrate-cli.ts` submodule was, pulled in
transitively by test imports) loads via the CommonJS resolver instead,
which resolves the extensionless `require()`s correctly — confirmed
working end to end by the real-spawn integration test
(`test/gate-maintenance.test.ts`).

`resolveRecalibrateBin` therefore defaults to this repo-relative compiled
path, resolved from `_gate-maintenance.ts`'s own `__dirname`
(`service/gate-http/` → repo root is two levels up), never from
`process.cwd()` — the binary lives at a fixed place relative to the repo
checkout regardless of what directory the server process happens to be
launched from. `DS_GATE_RECALIBRATE_BIN` is the escape hatch for any
deployment that packages or builds this differently (a bundled
single-file CLI, a wrapper script, a different build layout) — set it and
the scheduler spawns exactly that path instead, no resolution logic
involved. The spawned child itself is always run as
`<node binary> <recalibrate-bin-path> <args...>` (`process.execPath`,
not a bare `bin` — a `.js` file has no exec bit/shebang, so spawning it
directly as the executable fails `EACCES`), with `cwd` set to the
**server's own `process.cwd()`** (not the repo root) — `baselineHistoryDir`/
`storeDir` are commonly relative paths, already resolved by the rest of
this service against `process.cwd()`, and the spawned CLI must resolve
its own `--root` argument the same way.

### Failure isolation — the scheduler can never crash the server

Every method on `MaintenanceScheduler` is safe to call unconditionally
from `server.ts`'s hot paths. A spawn failure (`ENOENT`, `EACCES`, a
rejecting stub in tests), a child timeout (default 300s, `SIGKILL`ed on
expiry), or an unexpected non-zero exit code is captured into that run's
summary — `{exit_code, stdout_tail, stderr_tail, timed_out, error?}` —
never thrown into the interval timer's callback or into an HTTP request.
The interval timer itself is `.unref()`d, so an enabled scheduler never
holds the process open on its own. A one-at-a-time guard means a tick
that fires while the previous run's child is still executing is silently
skipped (no history entry, no log line) rather than piling up concurrent
spawns.

### Observability — bounded history, durable log, `/readyz`

Each run's summary is kept in a bounded in-memory ring buffer (last 20
runs by default) and appended, one JSON line per run, to a **durable,
service-owned** log:

```
<DS_GATE_STORE_DIR>/<service_id>/maintenance.jsonl
```

Note this lives under the **session store** (`DS_GATE_STORE_DIR`), NOT
the recalibration store (`DS_GATE_BASELINE_HISTORY_DIR`) — the write-split
doctrine again: this module owns nothing under
`runs/baseline-history/<service_id>/`, so its own durable record of what
it did lives entirely on its own side of that boundary, append-only, the
same `fs.appendFileSync('a')`-per-line convention
`service/session/jsonl-lifecycle-emitter.ts` already uses.

`GET /readyz` additively surfaces the scheduler's enabled flags and last
run (never gates readiness itself — a stalled or erroring maintenance run
never touches the served tick path, so it's diagnostic-only):

```json
{
  "...": "...",
  "maintenance": {
    "enabled": true,
    "auto_refresh": false,
    "interval_seconds": 3600,
    "last_run": {
      "started_at": "2026-07-17T00:00:00.000Z",
      "finished_at": "2026-07-17T00:00:01.000Z",
      "check": { "exit_code": 0, "stdout_tail": "...", "stderr_tail": "", "timed_out": false },
      "auto_refresh_triggered": false
    },
    "history_count": 5
  }
}
```

**Before enabling the scheduler in production (checklist):** the default bin
resolution spawns the *compiled* `tools/recalibrate.js`, which is a
gitignored build artifact — a fresh checkout does not have it. Either run
`tsc -p tsconfig.test.json` as part of the deploy, or set
`DS_GATE_RECALIBRATE_BIN` to a real file. A missing binary does not fail
startup; it surfaces as `bin_found: false` in `/readyz`'s maintenance block
and as per-tick ENOENT entries in `maintenance.jsonl` — check `/readyz`
after enabling.
