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
