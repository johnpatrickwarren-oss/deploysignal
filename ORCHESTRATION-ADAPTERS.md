# Orchestration Adapters — Architecture Spec

_Architect output. Drafted 2026-04-17._
_Addition #9 to `NORTH-STAR-ARCHITECTURE.md` (will land as a new section in the next architecture update, end of Week 1)._
_Companion: the platform-mapping doc (deleted) (service-specific), the PM-critique response (deleted) (earlier architecture additions)._

## Premise

The engine emits a `FusedVerdict` per deploy per tick: `proceed` | `extend` | `rollback`, plus provenance. That verdict has to land somewhere that can _act_ on it — pause a canary step, trigger a rollback, promote to the next rollout phase, or just log advisory. The engine should not know what orchestrator it's acting through. An **orchestration adapter layer** translates between our verdict shape and whatever the orchestrator expects.

First concrete adapter: **Argo Rollouts**, because it's Kubernetes-native, open-source, well-documented, and is what production scale is understood to run. Same adapter shape works for Flagger (the Kubernetes progressive-delivery competitor), Spinnaker (older but still widely deployed), and custom internal tooling.

This is symmetric to how L0 handles metric-source diversity (Prometheus, Datadog, OpenTelemetry, custom): one abstract contract, multiple adapters at the edge.

## Where it sits in the architecture

```
  L5 Learning ─┐
               │
  L4 Audit ─┐  │
            ▼  ▼
  L3 Fusion ──► O0 Orchestration Adapter Layer ──► External orchestrator (Argo, Flagger, Spinnaker, …)
                   │                    ▲
                   ▼                    │
                context ingestion  ◄────┘
                (rollout state, canary weight, reversibility, author, …)
```

- **O0 emits verdicts outward.** Takes `FusedVerdict` from L3, translates to the target orchestrator's expected signal shape, handles retry/backoff, emits provenance to L4 audit.
- **O0 ingests context inward.** Reads orchestrator state (canary weight, current step, rollout strategy, reversibility annotation, deploy author) as input to G1 policy gate's decision context.

## Contract surfaces

Two typed interfaces that every adapter implements:

```ts
interface OrchestrationAdapter {
  // Push: translate our verdict to the orchestrator's action
  emitVerdict(verdict: FusedVerdict, deploy: DeployRef): Promise<EmitResult>

  // Pull: fetch orchestrator context that feeds G1 policy
  fetchDeployContext(deploy: DeployRef): Promise<DeployContext>
}

interface DeployContext {
  deploy_id: string
  deploy_ref: string           // orchestrator-specific (Argo Rollout UID, Spinnaker pipelineId)
  strategy: 'canary' | 'blue_green' | 'rolling' | 'custom'
  current_step?: number
  total_steps?: number
  canary_weight?: number       // maps to our traffic_pct covariate
  reversibility: 'reversible' | 'forward_only' | 'conditional'
  change_type: ChangeType      // existing enum
  risk_level: RiskLevel         // existing enum
  author: Author
  labels: Record<string, string>
  annotations: Record<string, string>
}
```

These are the boundaries; adapter implementations are free to do anything behind them.

## Argo Rollouts — concrete mapping

Brief orientation for anyone reading this without K8s/Argo background: Argo Rollouts is a Kubernetes controller that replaces the standard `Deployment` resource with a `Rollout` resource supporting progressive delivery strategies (canary, blue-green). Analysis steps interleave with traffic shifts; each step can invoke an `AnalysisTemplate` that queries metrics and decides pass/fail/inconclusive. Today, `AnalysisTemplates` typically reference metric providers (Prometheus, Datadog, Wavefront, Kayenta, and several others) with expressed-as-code thresholds. Our gate would sit where one of those templates references a metric provider — specifically, it replaces the provider-plus-threshold combination with a single call that returns an authoritative verdict.

### Four integration levels

Listed in increasing depth of K8s integration. The runway ships Level 1; Level 2 is a natural for follow-on extension; Level 3 is the "full operator" version; Level 4 is probably out of scope.

#### Level 1 — Web metric provider (runway target)

The gate runs as an ordinary HTTP service (deployable on any infrastructure — a Kubernetes Deployment, a VM, a cloud-function, doesn't matter). Argo Rollouts' `AnalysisTemplate` uses the `web` provider:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: deploysignal-gate
spec:
  args:
    - name: deploy-ref
  metrics:
    - name: gate-verdict
      interval: 30s
      count: 60             # up to 60 evaluations (30 min for 30s cadence)
      successCondition: result == 0
      failureCondition: result == 1
      inconclusiveCondition: result == -1
      provider:
        web:
          url: "https://gate.internal/v1/verdict/{{args.deploy-ref}}"
          method: GET
          timeoutSeconds: 5
          jsonPath: "{$.verdict_code}"
```

Return shape from our service (minimal viable — richer provenance on a separate endpoint):

```json
{
  "verdict_code": 0,
  "verdict": "proceed",
  "tick": 12,
  "total_ticks": 32,
  "config_version": "v2026-04-28-platform",
  "alpha_consumed": 0.00041,
  "fires": []
}
```

Pros:
- Zero K8s-specific code in the engine. Works with anything that can hit HTTP.
- Runway can ship this today with the existing Node service + a thin REST layer.
- Same endpoint works for Flagger's web provider, Spinnaker custom stages, internal tooling.

Cons:
- Polling-based — Argo queries us on its interval rather than us pushing.
- Limited context transfer — Argo's request doesn't natively carry Rollout metadata, so we have to look it up ourselves via K8s API (or require the AnalysisTemplate to pass it as args).
- No bidirectional state management — we can't update the Rollout's annotations or emit Kubernetes events from this level.

#### Level 2 — Kubernetes Job adapter

Argo's `job` provider creates a short-lived Kubernetes Job per analysis tick. The Job runs a small CLI (`gate-cli verdict --deploy-ref=X`) and exits 0/1/-1 as the result. Argo reads the exit code and the Job's log output for additional signal.

Pros over Level 1:
- Runs inside the cluster with cluster-local credentials — easier to query K8s API for Rollout context, easier to fetch telemetry from in-cluster Prometheus.
- Log output gets captured by K8s logging stack automatically — cheaper observability.
- No need to publicly expose the gate HTTP endpoint.

Cons:
- Polling-based still.
- Job startup overhead (~2–5 seconds per tick) — higher latency than web provider.
- Image management — the Job image has to be versioned and deployed.

#### Level 3 — Custom analysis provider with CRDs

We become a Kubernetes operator. New CRDs:

- `DeploymentSignalConfig` — per-service gate configuration. Holds α budget, family opt-in, reversibility defaults, baseline reference, metric registry subset. Referenced by Rollout annotations.
- `DeploymentSignalRun` — ephemeral per-analysis resource. Owned by an AnalysisRun. Status fields emit tick-by-tick verdicts, per-family provenance, α consumption.

Argo AnalysisTemplates reference our provider by name:

```yaml
metrics:
  - name: gate-verdict
    provider:
      plugin:
        deploysignal:
          configRef: "inference-gate"
```

Our operator watches Rollout events, starts `DeploymentSignalRun` at the right rollout steps, runs the gate loop, updates AnalysisRun with final verdict.

Pros over Level 2:
- Deeply integrated with K8s event model — Rollout annotations, K8s events, Prometheus operator metrics all available natively.
- Rich context transfer (operator watches Rollouts, so it always has current state).
- Can emit K8s events and metrics for observability ("gate fired rollback for rollout X").
- GitOps-friendly: `DeploymentSignalConfig` is a declarative resource committable to a config repo.

Cons:
- Substantial engineering work — operator framework (operator-sdk or kubebuilder), CRD lifecycle, reconciliation loops, admission webhooks.
- Assumes customer runs K8s. Not portable to Spinnaker, internal tooling, or non-K8s environments.
- Roughly 2–3 engineer-weeks for a clean V1 operator. Follow-on work.

#### Level 4 — Service mesh / traffic-shaping integration

Integrate directly with Istio VirtualService / Linkerd TrafficSplit primitives. Gate doesn't just advise the orchestrator — it can directly modulate traffic weights in response to verdicts.

Pros:
- Tightest loop (gate can throttle canary fraction in real time instead of waiting for orchestrator's next step).
- Finest-grain control (per-route, per-header traffic splits).

Cons:
- Invasive — gate becomes part of the traffic-shaping control plane.
- Couples to specific mesh implementations.
- Conflicts with Argo's own traffic management if both try to modulate weights.

Probably architecturally wrong. The gate should advise; the orchestrator should act. Noting it for completeness.

### Shipping recommendation

**Runway (Weeks 5–6):** Level 1 + a minimal demo-scale Kubernetes stand-up. Specifically: a `kind` (Kubernetes-in-Docker) cluster with Argo Rollouts installed, our gate running as a `Deployment` with a small REST layer, one example AnalysisTemplate that references our gate via web provider. One of the three canned demos (the correlated-noise catch or the novelty catch) runs end-to-end through Argo. The demo artifact is a recording of Argo Rollouts promoting / rolling back in response to our verdicts.

**Days 1–30 at production scale:** Level 1 against real platform Rollouts in shadow mode. No CRDs yet; gate runs as a sidecar or off-cluster service.

**Days 31–90:** Level 2 (Job adapter) if operational experience suggests the polling / latency / credential-handling benefits are worth the image-management overhead. Decision gate at day 30.

**Month 4+:** Level 3 operator if shadow + advisory experience is clean and the platform team wants the deep K8s integration. Earliest ship Q2 for follow-on.

### Mapping verdict semantics

```
our verdict        → Argo analysis status
───────────────────────────────────────────
proceed            → Successful    (advance to next canary step)
rollback           → Failed        (trigger Rollout abort / rollback)
extend             → Inconclusive  (Argo retries next interval)
```

Argo Rollouts handles `Inconclusive` results by retrying the analysis after its configured `interval`. That's exactly the right semantics for our `extend` verdict — come back next tick with more data. No special handling required beyond surfacing the inconclusive condition in the AnalysisTemplate.

### Deploy metadata — what the adapter reads from Argo

The `DeployContext` interface above is filled from:

- **Rollout spec** — name, namespace, UID, strategy, step definitions.
- **Rollout status** — current step index, canary weight, pause state, health.
- **Annotations (convention)** — reversibility, change_type, author, risk_level. Platform team's responsibility to populate these; documented conventions in the service config.
- **Labels** — service name (for baseline lookup), tenant class if applicable.

For Level 1 (web provider), the AnalysisTemplate must pass the Rollout reference as an argument; the gate then calls the K8s API to fetch the Rollout and hydrate the `DeployContext`. The K8s API call is cached for the duration of the analysis run.

For Levels 2+, the context is fetched once when the Job/DeploymentSignalRun starts.

### Annotation conventions

Platform team defines these; documented so service teams know what to set. Proposed convention:

```yaml
metadata:
  annotations:
    deploysignal.io/reversibility: "reversible"           # reversible | forward-only | conditional
    deploysignal.io/change-type: "serving_code"           # model_weights | serving_code | config | infrastructure | documentation
    deploysignal.io/author-class: "human"                 # human | agent
    deploysignal.io/risk-level: "medium"                  # low | medium | high | critical
    deploysignal.io/config-ref: "inference-gate"   # points at DeploymentSignalConfig (Level 3) or config file (Levels 1-2)
```

Missing annotations: the gate uses conservative defaults (highest risk, forward-only, requires human approval) and emits a warning to the audit log. Never silently defaults to permissive.

## Context flowing the other way — how Argo shape informs policy

This is the bidirectional half that's less obvious but equally important. G1's policy context (already in the architecture) now has named inputs from the orchestrator:

- **Current canary weight** — becomes `traffic_pct` in the engine's Metrics schema; satisfies PM Q19 (variable canary fraction).
- **Rollout strategy** — different gate semantics per strategy. Canary: fire on regression signal. Blue-green: evaluate pre-traffic-shift; verdict is promote-or-abort, not rollback. Rolling: probably advisory only (too many simultaneous versions to do clean DID).
- **Current step index / total steps** — feeds the bake-time logic. Early steps (weight < 5%) get per-signal bake profiles suppressed for low-signal metrics.
- **Pause state** — if the Rollout is explicitly paused (human intervention), the gate pauses its own evaluation and resumes when the Rollout resumes.
- **Reversibility annotation** — from PM Q10 / addition #5. Forward-only deploys get verdict semantic `pause_and_alarm` instead of `rollback`.

All of this maps cleanly onto G1's existing `policyContext` structure. No new contract surfaces needed inside the engine — the adapter just populates `policyContext` from orchestrator state before each tick.

## What this means for the pitch

The Argo integration is a pitch asset because it answers two questions before they're asked:

- **"How does this actually get deployed?"** — answered: Level 1 web provider, shipped today in the demo. Nothing exotic.
- **"How does this fit into our existing Kubernetes stack?"** — answered: as an AnalysisTemplate, same slot that Kayenta plugin or custom thresholds fill today. Plug-compatible.

Also: if the target platform teams have been using Kayenta-in-Argo or hand-rolled AnalysisTemplates, our gate replaces the statistical component of those templates with something materially better. That's a concrete migration story, not a greenfield replacement.

## production-specific implications

Folding into the platform-mapping doc (deleted) as a new section (will land in the next revision):

- The platform's Argo Rollouts (assumed) become the first target orchestrator.
- Per-deploy-class Argo strategies: model-weight deploys likely use extended canary with many steps and long pauses; serving-code deploys likely use fewer-step canary with shorter analysis windows; infrastructure deploys likely use cluster-by-cluster rolling with our gate running advisory-only.
- Reversibility annotations get a platform-specific default table: model-weight deploys default `reversible` (can rotate back), schema migrations on the serving side are `forward_only`, config changes are `reversible`.
- Day-1 questions about Kayenta usage and current AnalysisTemplate patterns added to the platform mapping's "open questions" section.

## Day-1 questions for production deployment (added to platform mapping open-questions list)

- Is Argo Rollouts the canonical progressive-delivery layer, or are multiple tools in play (Argo, Spinnaker, internal)?
- Is Kayenta already integrated as an AnalysisTemplate provider? If so, what's its current usage pattern?
- How are reversibility / change-type tags set today? Platform-enforced annotations, PR-template-driven, or inferred from the pipeline?
- What's the AnalysisTemplate library look like today — per-service custom templates, or a small set of platform-provided templates service teams reference?
- Are there existing conventions around annotations for deploy metadata that our config should match?

## Out of scope

- **Non-Kubernetes orchestrators.** The web-provider level (Level 1) works for any HTTP-driven analysis step; we don't ship first-party Spinnaker/Jenkins/GitLab adapters in the project.
- **Flagger adapter.** Same contract surface, different provider syntax. Follow-on work once the Argo adapter is proven.
- **Multi-cluster orchestration.** The adapter assumes a single orchestrator instance per deploy. Federation / multi-cluster Argo deployments are a later concern.

## Chaos-experiment adapter family (Anvil, Addition #29)

The canary-direction adapter contract above also serves the inverse direction: chaos engineering. Where the canary path asks "should we proceed with this deploy given the telemetry," the chaos path asks "did the system behave acceptably under the injected fault." Same engine, same verdict portfolio, same audit substrate — different verdict vocabulary at the adapter boundary.

Four target platforms ship under `engine/o0/anvil/`:

| Platform | Module | Experiment-ref surface |
|---|---|---|
| Gremlin | `engine/o0/anvil/gremlin.ts` | REST API (`api.gremlin.com/v1/attacks/{id}`) |
| Chaos Mesh | `engine/o0/anvil/chaos-mesh.ts` | K8s CRDs (`PodChaos`, `NetworkChaos`, `IOChaos`, `StressChaos`) |
| AWS FIS | `engine/o0/anvil/aws-fis.ts` | FIS experiment-template ARN |
| Litmus | `engine/o0/anvil/litmus.ts` | K8s CRDs (`ChaosEngine` + `ChaosExperiment`) |

Each implements `ChaosOrchestrationAdapter` — the base `OrchestrationAdapter` plus `fetchExpectedFailurePattern(experiment_ref) → Promise<ExpectedFailurePattern>`. The adapter reads the source platform's experiment definition and translates it into the canonical shape declared in `engine/o0/anvil/types.ts`.

**Verdict vocabulary inversion.** Inside the engine the verdict is `proceed | extend | rollback | suppressed_insufficient_samples` — same as the canary direction. The chaos adapter renames on `emitVerdict` per `DeployContext.strategy === 'chaos_experiment'`:

| Engine verdict | Chaos verdict | Semantic |
|---|---|---|
| `proceed` | `experiment_passed` | The fault produced its expected effect (and possibly nothing else). |
| `rollback` | `experiment_failed_unexpectedly` | Something fired. Audit annotation `firing_family_in_suppress_set: bool` distinguishes "fault produced its expected signal" from "unexpected blast on signal Y." |
| `extend` | `experiment_still_running` | Bake window not yet closed; resample. |
| `suppressed_insufficient_samples` | `experiment_inconclusive` | Not enough samples in the fault window to make a defensible claim. |

**Expected-fault suppression.** The operator declares `expected_failure_pattern.suppress_families` at experiment-start (e.g., `['A']` for a latency-injection experiment that is *supposed* to perturb p99). During the fault window `[fault_start_unix, fault_start_unix + recovery_seconds]`, those families return `verdict: 'suppressed'` with `suppression_reason: 'expected_failure_pattern'`. Non-suppressed families still fire normally — that's the unexpected-blast catcher.

**Why this matters for the pitch.** The chaos-engineering market has weak verdict surfaces today: every platform injects faults well, then relies on operators eyeballing dashboards to render the pass/fail call. A principled FP-controlled verdict layer is a real gap. Anvil ships that layer on top of DS's existing Ville-bounded portfolio — and the audit substrate makes every chaos verdict replay-clean, so post-mortem review reconstructs the firing detector family, α consumption, and baseline-cell reference exactly as for the canary direction.

**Scope at v1.** Typed contracts + four adapter stubs + profile + docs (per PRD-29 priority). The adapter network-call implementations are deferred; the v1 wedge is the verdict-surface positioning + the audit substrate, not the chaos-platform integrations themselves. The stub `throw new Error('… v1 stub …')` bodies make the contract explicit and grep-friendly; an integrator landing one of the four platforms reads the stub for the canonical translation pattern and implements against it.

## Shipping plan

- **End of Week 1 (2026-04-22):** Architecture addition #9 section in `NORTH-STAR-ARCHITECTURE.md` points to this doc. No engine changes.
- **End of Week 2:** platform mapping updated with Argo integration section.
- **Week 5:** Demo-scale Argo integration. `kind` cluster + Argo Rollouts + minimal web-provider adapter against one canned demo. TPM routes the Week 5 scope implication in `ARCHITECT-REPLY-02`.
- **Week 6:** Pitch includes Argo integration as an explicit beat: "here's the the target platform deployment story, here's what plugs in where."
- **Follow-on Q1:** Level 1 in production shadow on real platform Rollouts.
- **Follow-on Q2:** Level 2 (Job adapter) or Level 3 (operator + CRDs), depending on platform-team appetite.

— Architect
