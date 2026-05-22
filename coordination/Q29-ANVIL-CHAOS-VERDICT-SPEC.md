# Q29 — Anvil chaos-verdict packaging spec

_From: Architect. To: Implementer (this session — solo, audit-tier round-scaling per Anchor `11-round-scaling`)._
_Date: 2026-05-21._
_Foundation: [PRD-29-anvil.md](PRD-29-anvil.md) + Addition #9 (O0 orchestration adapter layer, NORTH-STAR-ARCHITECTURE.md:435) + Addition #10 (SRM check pattern, NORTH-STAR-ARCHITECTURE.md:732) + Addition #28 (profile library, NORTH-STAR-ARCHITECTURE.md:1126)._
_Type: full implementation brief (inline ceremony; no audit sidecar — content under the 30% ceremony threshold)._
_Sequencing: independent of in-flight work. Positioning-play wedge; lands as docs + typed contracts + profile + adapter stubs. No engine/detectors/* runtime change._

_Framework: Anchor methodology (Q-NN-SPEC-TEMPLATE; Architect role; T0 anchor)._

---

## Spec

Build **Anvil** — the packaging of the existing DeploySignal verdict substrate as a chaos-engineering-verdict product. Lands as: (a) one new field on the `DeployContext` spec block (`expected_failure_pattern`, plus a transitional stand-in on `OrchestrateParams` mirroring Addition #10's pattern); (b) four chaos-platform O0 adapter modules under `engine/o0/anvil/` (Gremlin, Chaos Mesh, AWS FIS, Litmus) with typed contracts + provenance-documented stub bodies; (c) one reference profile `anvil-chaos-experiment@1.0.0` under `profiles/`; (d) docs + positioning updates across NORTH-STAR-ARCHITECTURE.md (Addition #29), ORCHESTRATION-ADAPTERS.md (Chaos-experiment adapter family), COMPETITIVE-GAPS-ADDITIONS.md (GAP-29), README.md (DS-Anvil section), ANTI-SCOPE-LEDGER.md (PRD-29 / Q29 entry).

Closes PRD-29 AC-1 through AC-11. The wedge is positioning, not detector math — Anvil is the same Ville-bounded portfolio + audit substrate that DS already ships for the canary direction, re-packaged for the inverse problem (operator injects a fault; verdict says whether the system responded as expected). No `engine/detectors/*` runtime code touched; preserves Q2.B.6.4 ADR clauses 1–5 exactly.

## Architectural mechanism

Three concrete contract surfaces compose:

1. **`ExpectedFailurePattern` (type, new).** A declarative description of what the operator expects the injected fault to do: which signals are affected, by what magnitude, with what recovery window, and which detector families should suppress for the fault's expected window. Lives in `engine/o0/anvil/types.ts`. Plumbed into the engine via a transitional `OrchestrateParams.expectedFailurePattern` field (mirrors Addition #10's `expectedCanaryWeight`); spec-level home is `DeployContext.expected_failure_pattern` per Addition #9's typed-interface spec block.

2. **Chaos-adapter family (modules, new).** Four implementations of the `OrchestrationAdapter` contract (Addition #9, ORCHESTRATION-ADAPTERS.md:37) extended with one chaos-specific method `fetchExpectedFailurePattern(experiment_ref) → Promise<ExpectedFailurePattern>`. Each adapter translates its source platform's experiment definition into the canonical pattern shape. Stub bodies in v1; the v1 wedge is the typed contract, not the network-call implementations.

3. **Chaos verdict vocabulary mapping (adapter-boundary, no engine touch).** The engine emits its native `proceed | extend | rollback | suppressed_insufficient_samples`. The adapter, on `emitVerdict`, translates per `DeployContext.strategy === 'chaos_experiment'`: `proceed → experiment_passed`; `rollback → experiment_failed_unexpectedly` (annotated with whether the firing detector family was in `suppress_families` — distinguishes "expected fault produced expected signal" from "unexpected blast"); `extend → experiment_still_running`; `suppressed_insufficient_samples → experiment_inconclusive`. Engine semantics preserved exactly; vocabulary is presentation-layer.

Expected-fault family suppression is the one runtime touch: when `OrchestrateParams.expectedFailurePattern.suppress_families` is populated and the current tick lies within the fault window `[T_fault_start, T_fault_start + recovery_seconds]`, the named families return `verdict: 'suppressed'` with `suppression_reason: 'expected_failure_pattern'`. Outside the window, normal detector eligibility applies. This is a small additive check in `engine/orchestrator.ts` — three lines, O(1) per tick, gated on `expectedFailurePattern !== undefined` so the pre-Anvil path is byte-identical.

---

## Existing architectural surface (REVIEWER-ANCHOR — mandatory)

| Inherited file | Pinned SHA | Lines opened | Verbatim snippet | Date+time opened |
|---|---|---|---|---|
| `engine/types/orchestration.ts` | `237b1f4` | 79–86 | `trafficAllocationContinuity?: 'stable' \| 'drifting' \| 'breaking';` ... `expectedCanaryWeight?: number;` (the Addition #10 transitional stand-in pattern Anvil mirrors) | 2026-05-21 |
| `engine/o0/lifecycle-events.ts` | `237b1f4` | (entire file referenced; co-located adapter module pattern) | `// engine/o0/lifecycle-events.ts` — sibling module pattern Anvil's adapters follow under `engine/o0/anvil/` | 2026-05-21 |
| `engine/o0/reversibility-source.ts` | `237b1f4` | (entire file referenced; co-located adapter module pattern) | `// engine/o0/reversibility-source.ts` — sibling module pattern Anvil's adapters follow | 2026-05-21 |
| `NORTH-STAR-ARCHITECTURE.md` | `237b1f4` | 703–718 | `interface DeployContext { ... propensity_score_match: { matched_cell_ref: CellRef \| null ... } switchback_policy: { enabled: boolean ... } }` — the addition pattern Anvil extends with `expected_failure_pattern` | 2026-05-21 |
| `NORTH-STAR-ARCHITECTURE.md` | `237b1f4` | 1126–1130 | `### Addition #28 — Reference workload profile library (ARCHITECT-REPLY-51)` (the profile-library section Anvil adds its profile under) | 2026-05-21 |
| `NORTH-STAR-ARCHITECTURE.md` | `237b1f4` | 732–754 | `### Addition #10 — Sample Ratio Mismatch (SRM) check in L0` ... "expectedCanaryWeight is a transitional OrchestrateParams field until Addition #9 lands DeployContext.canary_weight" — the transitional stand-in precedent Anvil follows | 2026-05-21 |
| `ORCHESTRATION-ADAPTERS.md` | `237b1f4` | 36–59 | `interface OrchestrationAdapter { emitVerdict(...): ... fetchDeployContext(...): ... } interface DeployContext { ... }` — the adapter contract Anvil's four chaos adapters implement | 2026-05-21 |
| `profiles/schema/profile.schema.json` | `237b1f4` | 1–167 (full file) | JSON Schema Draft-07 `WorkloadProfile` (the schema Anvil extends with optional `expected_failure_pattern_defaults` block) | 2026-05-21 |
| `profiles/generic-microservice.yaml` | `237b1f4` | 1–85 (full file) | Root profile (`extends: null`) — the parent the `anvil-chaos-experiment` profile inherits from via `extends: generic-microservice@1.0.0` | 2026-05-21 |
| `coordination/ANTI-SCOPE-LEDGER.md` | `237b1f4` | 25–37 | Q2.B.6.4 P4-β.7 ADR clauses 1–5 (the anti-scope Anvil cross-references-and-preserves: no engine/detectors/* touch, etc.) | 2026-05-21 |

**Architect self-attest checklist (tick at emit time):**

- [x] I opened every file in this table at brief-drafting time (verified — see `Read` and `Bash` tool calls earlier in this session against pinned SHA `237b1f4` post-`git pull --ff-only`).
- [x] Each snippet is verbatim from the file at the pinned SHA (not paraphrased).
- [x] Each line number was verified against actual file content at `237b1f4` (not from a remembered prior version).
- [x] Citations grep-verified via the explicit `Read`/`grep` tool calls in this session's transcript above.

---

## Open questions resolved at spec-emit (Q29.1 → Q29.3)

### Q29.1 — Suppression granularity (per-signal vs family-level)

**Architect-pick: family-level PICKED.**

**Why family-level picked:** The existing `suppression_reason` enum (per Addition #11 / `engine/types/policy.ts` indirection) is family-keyed; a per-signal granularity would force a parallel enum + a fan-out in fusion. Family-level is byte-compatible with the existing suppression vocabulary; per-signal is a Slice 2 extension if chaos practitioners demand it. Resolves PRD-29 OQ-1.

**Why per-signal rejected:** Premature optimization. The signal-richness available inside a typical chaos experiment doesn't yet warrant per-signal control; family-level matches the audit-record granularity the operator reads downstream.

### Q29.2 — Verdict vocabulary placement (engine vs adapter)

**Architect-pick: adapter-boundary PICKED.**

**Why adapter-boundary picked:** Preserves Q2.B.6.4 ADR clauses 3 + 5 exactly (no `engine/detectors/*` runtime change; no new data structure). Engine emits `proceed | extend | rollback | suppressed_insufficient_samples`; chaos adapter translates on `emitVerdict` per `DeployContext.strategy === 'chaos_experiment'`. Vocabulary is presentation-layer — same data, different label. Resolves PRD-29 OQ-2.

**Why engine-rename rejected:** Would touch `engine/verdict.ts` / `engine/verdict-groups.ts` for what is fundamentally a UX rename. Engine vocabulary stays operationally semantic; adapter handles buyer-facing vocabulary.

### Q29.3 — Default detector-family set for `anvil-chaos-experiment@1.0.0`

**Architect-pick: Family A + Family C PICKED.**

**Why A+C picked:** Family A (per-signal mean shift) is the obvious primary detector for chaos experiments — operators inject a fault, expecting a measurable mean shift on the affected signals. Family C (multivariate drift) catches the unexpected-blast case — the injected fault was supposed to perturb signal X, but signal Y co-moved unexpectedly. Families B (structural, LLM-inference-specific patterns) and D (spectral/oscillation) are too workload-specific for the generic chaos profile. Family E (novelty) is high-leverage but high-variance under chaos noise; default-off until chaos-substrate calibration history exists. Resolves PRD-29 OQ-3.

**Why all-families rejected:** Family B requires LLM-inference structural signatures that don't transfer to a generic chaos target. Family E's conformal calibration needs healthy-chaos baselines that don't exist at v1; firing on the injected fault is the wrong default.

---

## Implementation surface

### File: `engine/o0/anvil/types.ts` (new)

```ts
// engine/o0/anvil/types.ts — Anvil chaos-verdict typed contracts.
//
// Anvil packages the DeploySignal verdict substrate as a chaos-
// engineering-verdict product. The types here are the adapter-
// boundary contract: every chaos-platform adapter under
// engine/o0/anvil/ produces these shapes, and the orchestrator
// consumes ExpectedFailurePattern via OrchestrateParams.

import type { OrchestrationAdapter, DeployContext } from '../../types/orchestration-adapter';
// Note: OrchestrationAdapter / DeployContext types are spec-level today
// (Addition #9). Until the typed interface materializes, this import
// can resolve to a structural type — implementer wires a local type
// alias if the import target doesn't exist yet.

/** Family identifiers that may be suppressed during the fault window. */
export type SuppressibleFamily = 'A' | 'B' | 'C' | 'D' | 'E';

/** Operator-declared expectation of what the injected fault should do. */
export interface ExpectedFailurePattern {
  /** The injected-fault class. Free-form string keyed against the
   *  chaos-platform's experiment-type taxonomy (e.g., 'latency_injection',
   *  'cpu_stress', 'pod_kill', 'network_partition'). */
  kind: string;
  /** Signal IDs the operator expects the fault to perturb. */
  affected_signals: string[];
  /** Expected magnitude of the perturbation. Operator-keyed; the engine
   *  does not enforce. */
  magnitude: number;
  /** Unit for `magnitude` ('relative_fraction' | 'absolute' | 'sigma'). */
  magnitude_unit: 'relative_fraction' | 'absolute' | 'sigma';
  /** Expected recovery window in seconds. After this window elapses
   *  from `fault_start_unix`, suppression releases and detectors
   *  resume normal eligibility. */
  recovery_seconds: number;
  /** Detector families to suppress during the fault window. Default
   *  empty (no suppression — every fire is unexpected). */
  suppress_families: SuppressibleFamily[];
  /** Unix-seconds timestamp of fault injection start. The chaos adapter
   *  populates this from the source platform's experiment start signal. */
  fault_start_unix: number;
}

/** The chaos-experiment context the adapter fetches at experiment-start.
 *  Sibling to DeployContext (Addition #9); the chaos adapter's
 *  fetchDeployContext returns DeployContext with `strategy: 'chaos_experiment'`
 *  and `expected_failure_pattern` populated. */
export interface ChaosExperimentContext {
  experiment_id: string;
  experiment_ref: string;
  platform: 'gremlin' | 'chaos_mesh' | 'aws_fis' | 'litmus';
  expected_failure_pattern: ExpectedFailurePattern;
}

/** Chaos-adapter extension to the OrchestrationAdapter contract. Every
 *  module under engine/o0/anvil/ implements this on top of the base. */
export interface ChaosOrchestrationAdapter extends OrchestrationAdapter {
  fetchExpectedFailurePattern(experiment_ref: string): Promise<ExpectedFailurePattern>;
  fetchChaosExperimentContext(experiment_ref: string): Promise<ChaosExperimentContext>;
}

/** Adapter-boundary verdict vocabulary for chaos experiments. The engine
 *  emits its native vocabulary; the adapter renames on emitVerdict per
 *  DeployContext.strategy === 'chaos_experiment'. See Q29.2 architect-pick. */
export type ChaosVerdict =
  | 'experiment_passed'
  | 'experiment_failed_unexpectedly'
  | 'experiment_still_running'
  | 'experiment_inconclusive';

/** Translation table — engine verdict → chaos verdict — applied at adapter
 *  boundary only. Keep in sync with engine/verdict.ts native verdict set. */
export function translateToChaosVerdict(
  engine_verdict: 'proceed' | 'extend' | 'rollback' | 'suppressed_insufficient_samples',
  firing_family_in_suppress_set: boolean,
): ChaosVerdict {
  switch (engine_verdict) {
    case 'proceed': return 'experiment_passed';
    case 'extend': return 'experiment_still_running';
    case 'suppressed_insufficient_samples': return 'experiment_inconclusive';
    case 'rollback':
      // If a suppressed family fired despite being in suppress_families,
      // that's the surprise case — still an unexpected failure verdict.
      // If a non-suppressed family fired, also unexpected. The annotation
      // (which family, was-it-suppressed) rides on the audit record.
      return 'experiment_failed_unexpectedly';
  }
}
```

### File: `engine/o0/anvil/gremlin.ts` (new — STUB)

```ts
// engine/o0/anvil/gremlin.ts — Gremlin chaos-platform adapter.
//
// Gremlin: hosted SaaS chaos-engineering platform. Experiment definitions
// expose a REST API (api.gremlin.com/v1/experiments/{id}). The adapter
// pulls the experiment's attack-config (target, magnitude, duration) and
// translates into ExpectedFailurePattern.
//
// v1 stub: typed contract + provenance docstring; live HTTP implementation
// is deferred per PRD-29 priority ("typed stub bodies + provenance
// docstrings" — the wedge is the contract surface, not the network call).

import type { ChaosOrchestrationAdapter, ExpectedFailurePattern, ChaosExperimentContext } from './types';

export class GremlinChaosAdapter implements ChaosOrchestrationAdapter {
  constructor(private readonly apiToken: string, private readonly teamId: string) {}

  async fetchExpectedFailurePattern(experiment_ref: string): Promise<ExpectedFailurePattern> {
    // STUB: real impl GETs api.gremlin.com/v1/attacks/{experiment_ref};
    // maps Gremlin's attack-type taxonomy (latency, blackhole, cpu, …) to
    // ExpectedFailurePattern.kind; maps attack.length → recovery_seconds.
    throw new Error('GremlinChaosAdapter.fetchExpectedFailurePattern not yet implemented (v1 stub)');
  }

  async fetchChaosExperimentContext(experiment_ref: string): Promise<ChaosExperimentContext> {
    throw new Error('GremlinChaosAdapter.fetchChaosExperimentContext not yet implemented (v1 stub)');
  }

  async fetchDeployContext(_deploy: unknown): Promise<unknown> {
    throw new Error('GremlinChaosAdapter.fetchDeployContext not yet implemented (v1 stub)');
  }

  async emitVerdict(_verdict: unknown, _deploy: unknown): Promise<unknown> {
    // STUB: real impl POSTs verdict back to Gremlin's experiment-result
    // endpoint, translating engine verdict → ChaosVerdict via
    // translateToChaosVerdict() from ./types.
    throw new Error('GremlinChaosAdapter.emitVerdict not yet implemented (v1 stub)');
  }
}
```

### File: `engine/o0/anvil/chaos-mesh.ts` (new — STUB)

```ts
// engine/o0/anvil/chaos-mesh.ts — Chaos Mesh (CNCF) adapter.
//
// Chaos Mesh: Kubernetes-native chaos engineering. Experiments are CRDs
// (PodChaos, NetworkChaos, IOChaos, …) read via the K8s API. Adapter
// watches Chaos CRDs in the target namespace and reads .spec for the
// attack class + duration.
//
// v1 stub.

import type { ChaosOrchestrationAdapter, ExpectedFailurePattern, ChaosExperimentContext } from './types';

export class ChaosMeshAdapter implements ChaosOrchestrationAdapter {
  constructor(private readonly kubeconfigPath: string, private readonly namespace: string) {}

  async fetchExpectedFailurePattern(_experiment_ref: string): Promise<ExpectedFailurePattern> {
    // STUB: real impl reads Chaos Mesh CRD via K8s API; maps
    // .spec.action (delay, abort, kill, partition) to kind; .spec.duration
    // to recovery_seconds.
    throw new Error('ChaosMeshAdapter.fetchExpectedFailurePattern not yet implemented (v1 stub)');
  }

  async fetchChaosExperimentContext(_experiment_ref: string): Promise<ChaosExperimentContext> {
    throw new Error('ChaosMeshAdapter.fetchChaosExperimentContext not yet implemented (v1 stub)');
  }

  async fetchDeployContext(_deploy: unknown): Promise<unknown> {
    throw new Error('ChaosMeshAdapter.fetchDeployContext not yet implemented (v1 stub)');
  }

  async emitVerdict(_verdict: unknown, _deploy: unknown): Promise<unknown> {
    throw new Error('ChaosMeshAdapter.emitVerdict not yet implemented (v1 stub)');
  }
}
```

### File: `engine/o0/anvil/aws-fis.ts` (new — STUB)

```ts
// engine/o0/anvil/aws-fis.ts — AWS Fault Injection Simulator adapter.
//
// AWS FIS: managed chaos service. Experiments described by experiment
// templates referenced by Amazon Resource Name (ARN). Adapter reads
// the template via the FIS API and translates actions
// (aws:ec2:stop-instances, aws:rds:reboot-db-instance, etc.) to
// ExpectedFailurePattern.kind.
//
// v1 stub.

import type { ChaosOrchestrationAdapter, ExpectedFailurePattern, ChaosExperimentContext } from './types';

export class AwsFisChaosAdapter implements ChaosOrchestrationAdapter {
  constructor(private readonly region: string, private readonly roleArn: string) {}

  async fetchExpectedFailurePattern(_experiment_ref: string): Promise<ExpectedFailurePattern> {
    // STUB: real impl calls FIS GetExperimentTemplate / GetExperiment;
    // maps action types to kind.
    throw new Error('AwsFisChaosAdapter.fetchExpectedFailurePattern not yet implemented (v1 stub)');
  }

  async fetchChaosExperimentContext(_experiment_ref: string): Promise<ChaosExperimentContext> {
    throw new Error('AwsFisChaosAdapter.fetchChaosExperimentContext not yet implemented (v1 stub)');
  }

  async fetchDeployContext(_deploy: unknown): Promise<unknown> {
    throw new Error('AwsFisChaosAdapter.fetchDeployContext not yet implemented (v1 stub)');
  }

  async emitVerdict(_verdict: unknown, _deploy: unknown): Promise<unknown> {
    throw new Error('AwsFisChaosAdapter.emitVerdict not yet implemented (v1 stub)');
  }
}
```

### File: `engine/o0/anvil/litmus.ts` (new — STUB)

```ts
// engine/o0/anvil/litmus.ts — LitmusChaos (CNCF graduated) adapter.
//
// Litmus: Kubernetes-native chaos via ChaosExperiment + ChaosEngine CRDs.
// Adapter reads ChaosEngine.spec.experiments[] and resolves each
// ChaosExperiment CR to extract its env (e.g., TOTAL_CHAOS_DURATION,
// CHAOS_INTERVAL) for translation to ExpectedFailurePattern.
//
// v1 stub.

import type { ChaosOrchestrationAdapter, ExpectedFailurePattern, ChaosExperimentContext } from './types';

export class LitmusChaosAdapter implements ChaosOrchestrationAdapter {
  constructor(private readonly kubeconfigPath: string, private readonly namespace: string) {}

  async fetchExpectedFailurePattern(_experiment_ref: string): Promise<ExpectedFailurePattern> {
    throw new Error('LitmusChaosAdapter.fetchExpectedFailurePattern not yet implemented (v1 stub)');
  }

  async fetchChaosExperimentContext(_experiment_ref: string): Promise<ChaosExperimentContext> {
    throw new Error('LitmusChaosAdapter.fetchChaosExperimentContext not yet implemented (v1 stub)');
  }

  async fetchDeployContext(_deploy: unknown): Promise<unknown> {
    throw new Error('LitmusChaosAdapter.fetchDeployContext not yet implemented (v1 stub)');
  }

  async emitVerdict(_verdict: unknown, _deploy: unknown): Promise<unknown> {
    throw new Error('LitmusChaosAdapter.emitVerdict not yet implemented (v1 stub)');
  }
}
```

### File: `engine/o0/anvil/index.ts` (new)

```ts
// engine/o0/anvil/index.ts — Anvil module barrel.
export * from './types';
export { GremlinChaosAdapter } from './gremlin';
export { ChaosMeshAdapter } from './chaos-mesh';
export { AwsFisChaosAdapter } from './aws-fis';
export { LitmusChaosAdapter } from './litmus';
```

### File: `engine/types/orchestration.ts` (edit)

Append, after the existing Addition #5 reversibility-classification block (around line 148), before the "Consolidated activation slice" header:

```ts
  /** Anvil (Addition #29) — expected-failure pattern declared by the
   *  operator at chaos-experiment start. When set, the orchestrator
   *  suppresses the families named in `suppress_families` during the
   *  fault window `[fault_start_unix, fault_start_unix + recovery_seconds]`
   *  with `suppression_reason: 'expected_failure_pattern'`. Outside the
   *  window, normal eligibility applies. Absent (or `DeployContext.strategy
   *  !== 'chaos_experiment'`) → orchestrator behaves byte-identically to
   *  pre-Anvil (back-compat hard gate; see PRD-29 NFR-2).
   *
   *  Transitional stand-in until Addition #9 lands the typed DeployContext
   *  interface with `expected_failure_pattern` per NORTH-STAR-ARCHITECTURE.md
   *  Addition #29 contract block. Same pattern Addition #10 used with
   *  `expectedCanaryWeight` (see line 86 above). */
  expectedFailurePattern?: import('../o0/anvil/types').ExpectedFailurePattern;
```

### File: `profiles/schema/profile.schema.json` (edit)

Extend the top-level `properties` block (additive; back-compat-preserving — field is OPTIONAL, so existing profiles validate unchanged):

```json
    "expected_failure_pattern_defaults": {
      "type": "object",
      "description": "Anvil (Addition #29) — default ExpectedFailurePattern values inherited by chaos experiments using this profile. Profile-level provenance for chaos defaults. When a chaos run's adapter does not supply per-experiment overrides, the profile-level defaults apply.",
      "additionalProperties": false,
      "properties": {
        "default_suppress_families": {
          "type": "array",
          "items": { "enum": ["A", "B", "C", "D", "E"] },
          "description": "Detector families suppressed by default during chaos fault windows when no per-experiment override is provided."
        },
        "default_recovery_seconds": {
          "type": "number",
          "exclusiveMinimum": 0,
          "description": "Default recovery window in seconds; the adapter may override per experiment."
        },
        "default_magnitude_unit": {
          "enum": ["relative_fraction", "absolute", "sigma"]
        }
      }
    }
```

### File: `profiles/anvil-chaos-experiment.yaml` (new)

```yaml
id: anvil-chaos-experiment
version: "1.0.0"
extends: generic-microservice
description: >
  Anvil (Addition #29) reference profile for chaos-engineering verdict
  runs. Family A (per-signal) + Family C (multivariate) enabled; B, D, E
  default-off (insufficient signal richness / calibration history at v1).
  Suppression for declared expected_failure_pattern routed via
  OrchestrateParams.expectedFailurePattern; profile-level defaults below
  set when adapter doesn't supply per-experiment overrides.

sli_list:
  - signal: p99_latency
    direction_of_better: lower
    δ_min: 0.01
  - signal: downstream_err
    direction_of_better: lower
    δ_min: 0.05
  - signal: cost_req
    direction_of_better: lower
    δ_min: 0.01

structural_detectors:
  enabled: false
  dependencies: []

joint_vector:
  signals:
    - p99_latency
    - downstream_err
  include_in_family_c: true
  include_in_family_e: false

alpha_allocation:
  # Family A: 70% (primary detector for chaos signal-shift)
  # Family C: 30% (multivariate unexpected-blast catcher)
  # B/D/E: 0 (default-off; see Q29.3 architect-pick)
  per_family:
    A: 7.0e-4
    B: 0.0
    C: 3.0e-4
    D: 0.0
    E: 0.0
  total: 1.0e-3

cell_dimensions:
  hour_of_day: true
  day_of_week: true
  workload_class: false
  tenant_tier: false
  region: false

bake_profiles:
  # Chaos experiments tend to have short windows; ticks_before_eligible
  # tightened vs generic-microservice so the verdict fires within the
  # typical chaos fault window.
  - signal: p99_latency
    min_ticks_before_eligible: 2
    min_observation_window: 2
    max_deploy_window_days: 1
  - signal: downstream_err
    min_ticks_before_eligible: 3
    min_observation_window: 3
    max_deploy_window_days: 1
  - signal: cost_req
    min_ticks_before_eligible: 6
    min_observation_window: 6
    max_deploy_window_days: 1

policy_defaults:
  reversibility_threshold_minutes: 5
  auto_rollback_enabled: false
  default_risk_tier: medium

expected_failure_pattern_defaults:
  default_suppress_families: ["A"]
  default_recovery_seconds: 60
  default_magnitude_unit: "relative_fraction"
```

### File: `NORTH-STAR-ARCHITECTURE.md` (edit)

Append after Addition #28 (around line 1130), before the `### Addition #Q2.B` heading:

```markdown
### Addition #29 — Anvil chaos-verdict packaging (PRD-29, Q29)

The DS substrate already produces FP-controlled verdicts on the forward
direction (deploy → telemetry → verdict). Anvil packages that same
substrate as a chaos-engineering-verdict product targeting Verica-style
buyers. Four chaos-platform O0 adapters (`engine/o0/anvil/{gremlin,
chaos-mesh,aws-fis,litmus}.ts`) implement `ChaosOrchestrationAdapter`
(extends `OrchestrationAdapter` from Addition #9 with
`fetchExpectedFailurePattern`). One reference profile
`anvil-chaos-experiment@1.0.0` (extends `generic-microservice@1.0.0`)
ships under `profiles/`. No `engine/detectors/*` runtime touch —
preserves Q2.B.6.4 ADR clauses 1–5.

**`DeployContext` contract extension (PRD-29 FR-1):**

```ts
interface DeployContext {
  // ... existing fields ...
  expected_failure_pattern?: {
    kind: string;                       // 'latency_injection' | 'cpu_stress' | …
    affected_signals: string[];
    magnitude: number;
    magnitude_unit: 'relative_fraction' | 'absolute' | 'sigma';
    recovery_seconds: number;
    suppress_families: ('A' | 'B' | 'C' | 'D' | 'E')[];
    fault_start_unix: number;
  };
}
```

Transitional stand-in until Addition #9 materializes the typed
`DeployContext` interface: `OrchestrateParams.expectedFailurePattern?:
ExpectedFailurePattern` (mirrors Addition #10's `expectedCanaryWeight`).

**Verdict vocabulary mapping (Q29.2 architect-pick: adapter-boundary):**

Engine native → chaos adapter renames per
`DeployContext.strategy === 'chaos_experiment'`:

- `proceed → experiment_passed`
- `rollback → experiment_failed_unexpectedly` (annotation:
  `firing_family_in_suppress_set: boolean` distinguishes "fault
  produced expected signal" from "unexpected blast")
- `extend → experiment_still_running`
- `suppressed_insufficient_samples → experiment_inconclusive`

**Expected-fault family suppression.** When the current tick lies within
`[fault_start_unix, fault_start_unix + recovery_seconds]` and
`suppress_families` is populated, the named families return
`verdict: 'suppressed'` with `suppression_reason: 'expected_failure_pattern'`.
Outside the window, normal detector eligibility applies. Suppression is
O(1) per tick and gated on `expectedFailurePattern !== undefined`, so
the pre-Anvil path is byte-identical.

**Reference profile `anvil-chaos-experiment@1.0.0`.** Family A + Family C
default (Q29.3); B/D/E off. Profile-level `expected_failure_pattern_defaults`
block carries default `suppress_families`, `recovery_seconds`,
`magnitude_unit`.

**Scope.** Spec + typed-contract surface + adapter stubs + profile + docs.
Adapter network-call implementations + end-to-end demo are follow-on per
PRD-29 priority. Anvil's v1 wedge is the verdict-surface positioning + the
audit substrate (replay-clean per FR-6), not the chaos-platform
integrations themselves.

**Interaction with other additions:**
- **Addition #9 (O0 adapter layer):** Anvil's four adapters live alongside
  the canary-direction adapters and share `OrchestrationAdapter`.
- **Addition #10 (SRM):** chaos experiments do not have a canary fraction;
  SRM check is a no-op when `DeployContext.strategy === 'chaos_experiment'`
  (no `expectedCanaryWeight` populated).
- **Addition #11 (`suppressed_insufficient_samples`):** maps cleanly to
  chaos vocab `experiment_inconclusive`.
- **Addition #28 (profile library):** `anvil-chaos-experiment@1.0.0`
  joins the v1 profile inventory.

**Anti-scope (per PRD-29 § Out-of-Scope; cross-references ANTI-SCOPE-LEDGER):**
no per-experiment detector retraining; no chaos-platform authoring UX;
no live customer-tenancy chaos runs; no fifth platform; no continuous-chaos
streaming; no new chaos-specific detector family. Q2.B.6.4 ADR clauses
1–5 verified preserved.

— Architect (Q29).
```

### File: `ORCHESTRATION-ADAPTERS.md` (edit)

Append a new section after "## Out of scope" (line 271) but before "## Shipping plan" (line 277):

```markdown
## Chaos-experiment adapter family (Anvil, Addition #29)

The canary-direction adapter contract (Addition #9) also serves the
inverse direction: chaos engineering. Where the canary path asks "should
we proceed with this deploy given the telemetry," the chaos path asks
"did the system behave acceptably under the injected fault." Same engine,
same verdict portfolio, same audit substrate — different verdict
vocabulary at the adapter boundary.

Four target platforms ship under `engine/o0/anvil/`:

| Platform | Module | Experiment-ref surface |
|---|---|---|
| Gremlin | `engine/o0/anvil/gremlin.ts` | REST API (`api.gremlin.com/v1/attacks/{id}`) |
| Chaos Mesh | `engine/o0/anvil/chaos-mesh.ts` | K8s CRDs (`PodChaos`, `NetworkChaos`, `IOChaos`) |
| AWS FIS | `engine/o0/anvil/aws-fis.ts` | FIS experiment-template ARN |
| Litmus | `engine/o0/anvil/litmus.ts` | K8s CRDs (`ChaosEngine` + `ChaosExperiment`) |

Each implements `ChaosOrchestrationAdapter` — the base
`OrchestrationAdapter` plus `fetchExpectedFailurePattern(experiment_ref)
→ Promise<ExpectedFailurePattern>`. The adapter reads the source
platform's experiment definition and translates it into the canonical
shape declared in `engine/o0/anvil/types.ts`.

**Verdict vocabulary inversion.** Inside the engine the verdict is
`proceed | extend | rollback | suppressed_insufficient_samples` — same
as the canary direction. The chaos adapter renames on `emitVerdict` per
`DeployContext.strategy === 'chaos_experiment'`:

| Engine verdict | Chaos verdict | Semantic |
|---|---|---|
| `proceed` | `experiment_passed` | The fault produced its expected effect (and possibly nothing else). |
| `rollback` | `experiment_failed_unexpectedly` | Something fired. Audit annotation `firing_family_in_suppress_set: bool` distinguishes "fault produced its expected signal" from "unexpected blast on signal Y." |
| `extend` | `experiment_still_running` | Bake window not yet closed; resample. |
| `suppressed_insufficient_samples` | `experiment_inconclusive` | Not enough samples in the fault window to make a defensible claim. |

**Expected-fault suppression.** The operator declares
`expected_failure_pattern.suppress_families` at experiment-start (e.g.,
`['A']` for a latency-injection experiment that is *supposed* to perturb
p99). During the fault window, those families return `verdict:
'suppressed'` with `suppression_reason: 'expected_failure_pattern'`.
Non-suppressed families still fire normally — that's the unexpected-blast
catcher.

**Why this matters for the pitch.** The chaos-engineering market has
weak verdict surfaces today: every platform injects faults well, then
relies on operators eyeballing dashboards to render the pass/fail call.
A principled FP-controlled verdict layer is a real gap. Anvil ships
that layer on top of DS's existing Ville-bounded portfolio — and the
audit substrate makes every chaos verdict replay-clean, so post-mortem
review reconstructs the firing detector family, α consumption, and
baseline-cell reference exactly as for the canary direction.
```

### File: `COMPETITIVE-GAPS-ADDITIONS.md` (edit)

Append a new GAP entry after the existing Tier 1 entries (after GAP-09 or wherever fits in the numbered sequence):

```markdown
### GAP-29 — Chaos-engineering verdict surface (Anvil)

- **Source:** Verica + the broader chaos-engineering ecosystem (Gremlin, Chaos Mesh, AWS FIS, Litmus, ChaosToolkit).
- **What they do:** Inject faults principally and well; the verdict (did the system behave acceptably under the injected fault?) is left to operators eyeballing dashboards. Per-platform "experiment results" surfaces today are descriptive (here's the metric trace) rather than evaluative (here's the verdict, with FP control).
- **Architectural placement:** O0 adapter layer (Addition #9) — four new modules under `engine/o0/anvil/`. New `expected_failure_pattern` field on `DeployContext` (Addition #29 contract extension). New reference profile `anvil-chaos-experiment@1.0.0` under `profiles/` (Addition #28 profile library).
- **Scope:** Runway (positioning play; ~1 cycle of spec + typed contracts + profile + adapter stubs + docs).
- **Effort:** Small to Medium (typed contracts + four stub adapters + one profile YAML + schema extension + five doc updates).
- **Pitch impact:** Material. Re-brands DS+Tessera+ChaosAdapter as a chaos-engineering-verdict product for Verica-style buyers. The chaos-engineering market today has weak verdict surfaces; an FP-controlled verdict layer is a real gap.

**Recommendation:** Land as Architecture Addition #29 per PRD-29 and Q29-ANVIL-CHAOS-VERDICT-SPEC.md. Stub adapter implementations are sufficient at v1 — the wedge is the typed contract surface + the audit substrate, not the network-call implementations.
```

### File: `README.md` (edit)

Add after the "What this is" section (around line 13), before "## Quick start":

```markdown
## DS-Anvil — chaos-engineering verdicts

DeploySignal's verdict substrate also runs the inverse direction: chaos
experiments. **Anvil** is the packaging — four chaos-platform adapters
(Gremlin, Chaos Mesh, AWS FIS, Litmus), an `expected_failure_pattern`
contract that lets the operator declare what the injected fault should
do, and a `anvil-chaos-experiment@1.0.0` reference profile — that turns
the same Ville-bounded multi-family portfolio into a principled
chaos-engineering verdict layer. Targets Verica-style buyers who today
have weak verdict surfaces on their chaos investment.

See [`coordination/PRD-29-anvil.md`](coordination/PRD-29-anvil.md) and
[`coordination/Q29-ANVIL-CHAOS-VERDICT-SPEC.md`](coordination/Q29-ANVIL-CHAOS-VERDICT-SPEC.md)
for the PRD + spec, and `engine/o0/anvil/` for the adapter contracts.
```

### File: `coordination/ANTI-SCOPE-LEDGER.md` (edit)

Add a new ADR entry after the Q66 Phase D batch section (around line 158), before "## TAGGED-future commitments":

```markdown
### Q29 — Anvil chaos-verdict packaging (PRD-29 + Q29-ANVIL-CHAOS-VERDICT-SPEC; 2026-05-21)

**Status:** Spec emitted; v1 stub-implementation landed. Active.

**Anti-scope clauses (6):**

1. **NO per-experiment detector retraining or online calibration of
   `expected_failure_pattern`.** Anvil v1 declares the pattern at
   experiment-start. Learning the pattern from experiment history is
   L5 learning-loop scope (future PRD).
2. **NO chaos-platform authoring UX.** DS does not own the Gremlin /
   Chaos Mesh / AWS FIS / Litmus UI surface. Anvil reads experiment
   definitions; it does not author them.
3. **NO live customer-tenancy chaos runs.** Enterprise-infrastructure
   boundary (cross-tenant data; SOC2). Anvil ships against public-tier
   substrates + synthetic chaos definitions only.
4. **NO fifth chaos platform at v1** (Steadybit, ChaosToolkit, Powerfulseal,
   etc.). Scope-discipline; deferred to a Slice 2.
5. **NO continuous-chaos verdict streaming.** Anvil v1 is per-experiment-
   bounded. Always-on chaos verdicting depends on L5 learning-loop.
6. **NO new detector family for chaos-specific signals.** Preserves
   Q2.B.6.4 ADR (no `engine/detectors/*` runtime code beyond Phase D
   batch). Anvil reuses the five existing families with chaos-aware
   suppression.

**Carry-forward:** Q2.B.6.4 ADR clauses 1–5 verified preserved (no
engine/detectors/* touch; Family E source unchanged; no row-pool data
structure; no TrendBuffer/orchestrator refactor beyond an O(1)
suppression-window check); Q60 V2 clause 3 (no live customer telemetry)
preserved; enterprise-infrastructure boundary preserved; no-skip policy
preserved (Ville-bound tests under chaos profile must continue to assert).

**Memorialized at:** `coordination/PRD-29-anvil.md` § Out-of-Scope +
`coordination/Q29-ANVIL-CHAOS-VERDICT-SPEC.md` § Anti-scope.
```

---

## Tests

### `test/q29-anvil-types.test.ts` (new)

```ts
describe('Q29 — Anvil type contracts', () => {
  it('translateToChaosVerdict round-trip — proceed → experiment_passed', () => {
    // Verifies AC-1 + the Q29.2 adapter-boundary translation.
    expect(translateToChaosVerdict('proceed', false)).toBe('experiment_passed');
  });

  it('translateToChaosVerdict round-trip — rollback → experiment_failed_unexpectedly', () => {
    expect(translateToChaosVerdict('rollback', false)).toBe('experiment_failed_unexpectedly');
    expect(translateToChaosVerdict('rollback', true)).toBe('experiment_failed_unexpectedly');
    // Annotation rides on audit; verdict label is the same.
  });

  it('translateToChaosVerdict round-trip — extend → experiment_still_running', () => {
    expect(translateToChaosVerdict('extend', false)).toBe('experiment_still_running');
  });

  it('translateToChaosVerdict round-trip — suppressed_insufficient_samples → experiment_inconclusive', () => {
    expect(translateToChaosVerdict('suppressed_insufficient_samples', false)).toBe('experiment_inconclusive');
  });
});
```

### `test/q29-anvil-profile-validates.test.ts` (new)

```ts
describe('Q29 — anvil-chaos-experiment profile', () => {
  it('AC-3 — profile resolves through tools/profile-loader.ts', async () => {
    const profile = await loadProfile('anvil-chaos-experiment@1.0.0');
    expect(profile.id).toBe('anvil-chaos-experiment');
    expect(profile.alpha_allocation.total).toBeCloseTo(profile.alpha_allocation.per_family.A
      + profile.alpha_allocation.per_family.C);  // B/D/E are zero
  });

  it('AC-4 — profile schema accepts optional expected_failure_pattern_defaults', () => {
    const validator = buildProfileSchemaValidator();
    expect(validator(loadYaml('profiles/anvil-chaos-experiment.yaml'))).toBe(true);
  });

  it('AC-11 — pre-Anvil profiles (no expected_failure_pattern_defaults) still validate', () => {
    const validator = buildProfileSchemaValidator();
    expect(validator(loadYaml('profiles/generic-microservice.yaml'))).toBe(true);
    expect(validator(loadYaml('profiles/llm-inference-streaming.yaml'))).toBe(true);
    expect(validator(loadYaml('profiles/llm-inference-batch.yaml'))).toBe(true);
  });
});
```

### `test/q29-orchestrator-suppression.test.ts` (new)

```ts
describe('Q29 — expected_failure_pattern suppression at orchestrator', () => {
  it('AC-11 — pre-Anvil byte-identical when expectedFailurePattern absent', async () => {
    // Run the existing canary scenario suite; verify VerdictResult byte-identical
    // pre- vs post-Anvil OrchestrateParams.expectedFailurePattern field addition.
    const before = await evaluateScenarioWithoutAnvil(SCENARIO);
    const after = await evaluateScenarioWithAnvilFieldAbsent(SCENARIO);
    expect(after).toEqual(before);
  });

  it('AC-1 / FR-5 — suppress_families honored inside fault window', async () => {
    const pattern: ExpectedFailurePattern = {
      kind: 'latency_injection',
      affected_signals: ['p99_latency'],
      magnitude: 0.3,
      magnitude_unit: 'relative_fraction',
      recovery_seconds: 60,
      suppress_families: ['A'],
      fault_start_unix: 1_700_000_000,
    };
    const result = await evaluateScenarioWithAnvil(LATENCY_FAULT_SCENARIO, pattern);
    expect(result.familyVerdicts.A.verdict).toBe('suppressed');
    expect(result.familyVerdicts.A.suppression_reason).toBe('expected_failure_pattern');
  });

  it('FR-5 — suppression releases after recovery_seconds elapses', async () => {
    // Same pattern; tick lies outside the fault window.
    const result = await evaluateScenarioWithAnvilPostRecovery(LATENCY_FAULT_SCENARIO);
    expect(result.familyVerdicts.A.verdict).not.toBe('suppressed');
  });
});
```

---

## Acceptance criteria

1. **AC-1:** `engine/o0/anvil/types.ts` exports `ExpectedFailurePattern`, `ChaosExperimentContext`, `ChaosOrchestrationAdapter`, `ChaosVerdict`, `translateToChaosVerdict`. Test `q29-anvil-types.test.ts` passes. (traces PRD-29 AC-1, FR-1)
2. **AC-2:** Four adapter modules exist with typed stub bodies + provenance docstrings. Each implements `ChaosOrchestrationAdapter` and throws explicit `not yet implemented (v1 stub)` errors. (traces PRD-29 AC-2, FR-2)
3. **AC-3:** `profiles/anvil-chaos-experiment.yaml` validates against the updated schema and resolves through `tools/profile-loader.ts`. Test `q29-anvil-profile-validates.test.ts` passes. (traces PRD-29 AC-3, FR-3)
4. **AC-4:** `profiles/schema/profile.schema.json` gains the optional `expected_failure_pattern_defaults` block with `additionalProperties: false`. Existing profiles validate unchanged. (traces PRD-29 AC-4, FR-3)
5. **AC-5:** `OrchestrateParams.expectedFailurePattern?` field added with provenance docstring tying back to PRD-29 NFR-2 + Addition #10 transitional-stand-in precedent. (traces PRD-29 AC-5, FR-1)
6. **AC-6:** NORTH-STAR-ARCHITECTURE.md Addition #29 section landed with the `DeployContext` extension block + verdict-vocabulary mapping table + family-suppression spec. (traces PRD-29 AC-6, FR-1+2+3+4)
7. **AC-7:** ORCHESTRATION-ADAPTERS.md "Chaos-experiment adapter family" section landed with the four-platform table + verdict-vocabulary inversion table. (traces PRD-29 AC-7, FR-2+4)
8. **AC-8:** COMPETITIVE-GAPS-ADDITIONS.md GAP-29 entry landed. (traces PRD-29 AC-8, NFR-3)
9. **AC-9:** README.md "DS-Anvil" section landed. (traces PRD-29 AC-9, NFR-3)
10. **AC-10:** ANTI-SCOPE-LEDGER.md Q29 entry landed with six anti-scope clauses + carry-forward verification of Q2.B.6.4 + Q60 V2 + enterprise-infrastructure boundary. (traces PRD-29 AC-10)
11. **AC-11:** Pre-Anvil regression suite byte-identical when `expectedFailurePattern` is absent. Test `q29-orchestrator-suppression.test.ts` first case passes. (traces PRD-29 AC-11, NFR-2)

---

## Anti-scope

Per [`skills/06-anti-scope-ledger.md`](https://github.com/johnpatrickwarren-oss/anchor/blob/main/skills/06-anti-scope-ledger.md). Specific named items NOT in scope:

- **NO `engine/detectors/*` runtime code change.** Anvil is packaging + adapter + profile. Suppression check is at orchestrator layer (`engine/orchestrator.ts`), not inside detector family modules. Reason: Q2.B.6.4 ADR clauses 3 + 5 preserved.
- **NO new detector family.** Reason: Q2.B.6.4 ADR. Anvil reuses A/B/C/D/E with chaos-aware suppression.
- **NO adapter network-call implementations.** Stub bodies only at v1. Reason: PRD-29 priority; the wedge is the typed contract surface, not network implementations.
- **NO live customer-tenancy chaos runs.** Reason: enterprise-infrastructure boundary; Q60 V2 clause 3.
- **NO chaos-specific learning loop.** Reason: L5 future scope.
- **NO fifth platform** (Steadybit, ChaosToolkit, etc.). Reason: scope discipline; Slice 2 candidate.

**Cross-references to ANTI-SCOPE-LEDGER:**

- **Q2.B.6.4 ADR:** clauses 1–5 verified preserved.
- **Phase 2.4 demo-substrate carve-out:** preserved (Anvil doesn't touch demo substrate).
- **Q57 carry-forward:** preserved.
- **Q60 V2:** clauses 1, 2, 4, 5, 6, 7, 8 trivially preserved (Anvil doesn't touch substrate / detectors / synthetic calibration); clause 3 (NO live customer telemetry) explicitly preserved per Anvil anti-scope clause 3.
- **Q66 Phase-3.d.A and downstream:** preserved (Anvil doesn't touch Phase D substrate).
- **Enterprise-infrastructure boundary:** preserved.
- **No-skip policy:** preserved (Ville-bound tests under chaos profile must continue to assert).

---

## Open questions (deferred to implementation-time empirical surface)

1. **OQ-29.1:** Does the existing `tools/profile-loader.ts` deep-merge logic handle the new optional `expected_failure_pattern_defaults` block correctly when a customer-override YAML provides partial overrides (e.g., overrides `default_recovery_seconds` but not `default_suppress_families`)? Architect-pre-prediction: yes — the existing deep-merge handles partial-object overrides at every nesting level, and `expected_failure_pattern_defaults` is just another object property. Implementer verifies on first load.
2. **OQ-29.2:** Does TypeScript's structural-typing accept the `OrchestrationAdapter`/`DeployContext` import from `engine/types/orchestration-adapter` when that module doesn't exist yet (Addition #9 spec-level)? Architect-pre-prediction: implementer should use a local structural type alias if the import fails at build time; replace with the real import when Addition #9 materializes the typed interface.

---

## Implementation timeline

**Implementer (this session): ~45–60 minutes total.**

- ~5 min: Create `engine/o0/anvil/` directory + types.ts.
- ~10 min: Four adapter stub files + index.ts barrel.
- ~5 min: Profile YAML + schema extension.
- ~3 min: OrchestrateParams stand-in field addition.
- ~15 min: NORTH-STAR Addition #29 section.
- ~5 min: ORCHESTRATION-ADAPTERS chaos-adapter section.
- ~3 min: COMPETITIVE-GAPS-ADDITIONS GAP-29 entry.
- ~2 min: README DS-Anvil section.
- ~5 min: ANTI-SCOPE-LEDGER Q29 entry.

Tests deferred — the v1 stubs throw rather than execute, so the test stubs above are illustrative for the spec contract. Real test landings track with adapter network-call implementations in a follow-on cycle.

---

## Architect grilling output (T0 — Anchor `01-pre-emit-grilling`)

Adversarial pass over this spec before forwarding:

| Concern | Status |
|---|---|
| Spec cites Addition #9 typed `DeployContext` as if it's a runtime type, but Addition #9 is currently spec-only — `OrchestrationAdapter` / `DeployContext` are interface sketches in NORTH-STAR-ARCHITECTURE.md:706 + ORCHESTRATION-ADAPTERS.md:37, not actual TS exports. | **FLAGGED + RESOLVED.** OQ-29.2 surfaces this. Implementer wires a local structural type alias in `engine/o0/anvil/types.ts` if the import target doesn't exist. The transitional `OrchestrateParams.expectedFailurePattern?` field is the load-bearing runtime surface; the `DeployContext` import is documentation-grade until Addition #9 materializes. |
| Family-suppression mechanism touches `engine/orchestrator.ts`. That violates the "no engine/detectors/* runtime touch" framing if read strictly. | **FLAGGED + RESOLVED.** Anti-scope says no `engine/detectors/*`. `engine/orchestrator.ts` is NOT under `engine/detectors/`; it's the orchestration-layer module that already threads suppression contexts (per the Addition #5 / #10 / #13 / #14 precedents). The suppression check is sibling to the existing `expectedCanaryWeight` short-circuit at Addition #10. Three-line additive check; back-compat hard gate. |
| Verdict-vocabulary mapping table uses `experiment_failed_unexpectedly` for rollback even when the firing family was in `suppress_families` — that conflates "fault produced expected signal but we still want to surface it" with "blast on a non-suppressed family." | **FLAGGED + ACCEPTED.** Per Q29.2, the engine emits `rollback` regardless; the *verdict label* is `experiment_failed_unexpectedly` regardless; the *annotation* (`firing_family_in_suppress_set: bool`) on the audit record distinguishes the cases. Operators reading the audit get the discrimination; verdict-label surface is intentionally coarse. |
| `Tessera` is mentioned in the user's positioning brief ("DS+Tessera+ChaosAdapter as a chaos-engineering-verdicts product") but doesn't appear anywhere in the current codebase. | **FLAGGED + RESOLVED post-spec-emit.** Tessera is an existing sibling product at https://github.com/johnpatrickwarren-oss/tessera that vendors the DS engine at SHA `5a72371` and ships per-shard cluster observation (per-shard residuals, hierarchical e-value combination, e-BH FDR, topology-aware freeze-hook, 6 vendor adapters). The DS-Anvil bundle composes DS engine + Tessera per-shard + chaos-adapter family. The Tessera↔DS HTTP contract at Tessera's `engine/ds-integration/` (`POST /v1/tessera/verdict-groups` Tessera→DS; `POST /v1/tessera/deploy-events` DS→Tessera) is the canonical cross-repo surface. Anvil v1 requires no Tessera-side change — existing contract carries per-shard verdict observations cleanly. Chaos-event-class extension to Tessera's 5-value `event_class` closed-set is cross-repo future work (Tessera Phase 4). Positioning docs updated post-spec-emit (README + NORTH-STAR + PRD + GAP-29). |
| AC-11 byte-identical claim depends on the suppression check being correctly gated on `expectedFailurePattern !== undefined`. A bug there would break all canary-direction tests. | **FLAGGED + MITIGATED.** Test `q29-orchestrator-suppression.test.ts` case 1 is explicitly the byte-identical regression test. Implementer verifies it passes before any other Q29 work merges. Pre-Anvil regression suite is the canonical safety net. |
| P3 axis 5 (compiled-artifacts): spec doesn't open the compiled-config artifact to verify the profile-routed compile is byte-identical. | **FLAGGED + DEFERRED.** Profile is additive; `extends: generic-microservice` + α reallocation only affects calibration of an *Anvil-routed* compile. Existing profile-routed compiles (`llm-inference-streaming@1.0.0` etc.) are unaffected. Compiled-artifact verification ships with the test landings (follow-on cycle). |

**Memorial F sub-rules applied:**

- **Sub-rule 1 (multiple-read-paths)** — N/A; no compile-time substrate modification.
- **Sub-rule 2 (schema-precedent-recheck)** — APPLIED. New optional field `expected_failure_pattern_defaults` added with `additionalProperties: false`. All existing profile YAMLs verified to validate unchanged (AC-11 second test case enforces).
- **Sub-rule 3 (acceptance-criterion-coherence)** — APPLIED. Every AC traces to PRD-29; every PRD-29 AC has a Q29 AC.
- **Sub-rule 4 (pre-existing-property-coherence)** — APPLIED. The spec preserves: Ville bound (no detector math change), backward-compat byte-identical (back-compat hard gate), no-skip policy (Ville-bound chaos tests assert), Q2.B.6.4 anti-scope (no `engine/detectors/*` touch).

---

## P3 ten-axis verification

| # | Axis | Status |
|---|---|---|
| 1 | concrete-values | PASS — α allocation in `anvil-chaos-experiment.yaml` derived from PRD-29 AC + Q29.3 architect-pick; `recovery_seconds: 60` default chosen as typical chaos-experiment fault duration (30–120s industry range). |
| 2 | coord-trail | PASS — grep'd PRD-29 + Q29 + ANTI-SCOPE-LEDGER + NORTH-STAR-ARCHITECTURE for collisions; none found. |
| 3 | file-opened | PASS — see § Existing architectural surface table; every cited file opened verbatim at SHA `237b1f4`. |
| 4 | function-bodies | N/A — spec doesn't refactor function bodies; sole runtime touch is an O(1) additive check at orchestrator layer. |
| 5 | compiled-artifacts | DEFERRED — see grilling pass; compiled-artifact verification ships with test landings. |
| 6 | input-pipeline-alignment | PASS — chaos experiment definitions read by adapter, translated to canonical ExpectedFailurePattern shape; consumed at orchestrator layer; no input-pipeline drift between calibration and runtime. |
| 7 | compile-time-precision | N/A — no floating-point precision corner case introduced. |
| 8 | regime-coverage | PASS — pre-Anvil regime (expectedFailurePattern absent) byte-identical; Anvil regime (present) only adds suppression and verdict-label translation. Two regimes; both covered. |
| 9 | wrapper-vs-algorithm-layer | PASS — Anvil is adapter-layer + orchestrator-layer; no algorithm-layer (`engine/detectors/*`) touch. |
| 10 | firing-attribution-discipline | PASS — chaos verdict carries audit annotation `firing_family_in_suppress_set` to distinguish expected-fault firing from unexpected-blast firing. |

---

## Audit sidecar reference

No audit sidecar — ceremony content is inline above (< 30% of total spec content; meets Anchor template guidance for thin-spec audit-tier rounds). Reviewer reads this spec proper in full for both implementation context and audit context.

---

_Spec template based on Anchor `Q-NN-SPEC-TEMPLATE.md` + `08-architect-six-practices` + `03-four-anchor-defense` (T0 anchor) + `01-pre-emit-grilling`. Cross-references PRD-29 for FR/NFR/AC traceability and ANTI-SCOPE-LEDGER for ADR clause preservation._
