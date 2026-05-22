// engine/o0/anvil/chaos-mesh-translate.ts — Q29 SLICE 2 (proof-of-life).
//
// Pure translation from a Chaos Mesh CRD object (the YAML shape that
// `kubectl apply -f` consumes, parsed via js-yaml or similar) to the
// canonical ExpectedFailurePattern. Split out from chaos-mesh.ts so the
// translation is testable independently of the K8s API client.
//
// The K8s API client itself (fetching the CRD via `kubectl get` semantic)
// stays as a stub in chaos-mesh.ts at v1 — pluggable when the integrator
// wires in @kubernetes/client-node or equivalent.
//
// Reference: https://chaos-mesh.org/docs/define-chaos-experiment-scope/
// CRD kinds supported at SLICE 2: NetworkChaos, PodChaos, StressChaos,
// IOChaos, TimeChaos. Other kinds (HTTPChaos, DNSChaos, KernelChaos,
// JVMChaos, AzureChaos, AWSChaos, GCPChaos, BlockChaos) fall through to
// a generic-fault translation; integrators may extend.

import type { ExpectedFailurePattern, SuppressibleFamily } from './types';

/** Minimal subset of a Chaos Mesh CRD's YAML shape that the translator
 *  consumes. Integrators may pass a fuller object — the translator
 *  reads only the fields named here. */
export interface ChaosMeshCRD {
  apiVersion: string;     // e.g. 'chaos-mesh.org/v1alpha1'
  kind: string;           // 'NetworkChaos' | 'PodChaos' | …
  metadata?: { name?: string; namespace?: string };
  spec: {
    action?: string;      // NetworkChaos: 'delay' | 'loss' | 'duplicate' | …
                          // PodChaos: 'pod-kill' | 'pod-failure' | 'container-kill'
                          // IOChaos: 'delay' | 'errno' | 'attrOverride' | …
    duration?: string;    // Go duration: '60s' | '5m' | '1h30m'
    stressors?: {
      cpu?: { workers: number; load?: number };
      memory?: { workers: number; size?: string };
    };
    delay?: { latency?: string };
    selector?: unknown;   // Pod selector; opaque to the translator
  };
}

/** Parse a Go duration string (e.g. '60s', '5m', '1h30m') into seconds.
 *  Implementation supports the subset Chaos Mesh's API uses; full Go
 *  duration parsing (with negative durations, sub-second units) is out
 *  of scope at v1 — chaos experiments are seconds-to-minutes scale. */
export function parseGoDurationSeconds(s: string): number {
  // Matches sequences like 1h, 30m, 45s, 500ms; sums them. `ms` must
  // precede `m` and `s` in the alternation so "500ms" doesn't match
  // as 500m + leftover s.
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const n = parseFloat(m[1]);
    switch (m[2]) {
      case 'h': total += n * 3600; break;
      case 'm': total += n * 60; break;
      case 's': total += n; break;
      case 'ms': total += n / 1000; break;
    }
  }
  if (total === 0) {
    throw new Error(`unparseable Chaos Mesh duration: "${s}"`);
  }
  return total;
}

/** Map a Chaos Mesh CRD's kind+action to (kind, affected_signals,
 *  suppress_families). The mapping reflects which DS detector family
 *  the operator expects to fire because of the injected fault — the
 *  family that should suppress during the fault window. Non-suppressed
 *  families remain the unexpected-blast catchers. */
function classifyByKindAndAction(
  kind: string,
  action: string | undefined,
): {
  kind: string;
  affected_signals: string[];
  suppress_families: SuppressibleFamily[];
} {
  switch (kind) {
    case 'NetworkChaos':
      // Network delay / loss / duplicate / corrupt / partition → expect
      // p99_latency or downstream_err to shift; Family A is the targeted
      // suppression family. Multivariate Family C catches if unrelated
      // signals (e.g., eval_score) co-move unexpectedly.
      return {
        kind: action ? `network_${action}` : 'network_fault',
        affected_signals: ['p99_latency', 'downstream_err'],
        suppress_families: ['A'],
      };
    case 'PodChaos':
      // Pod kill / failure / container kill → expect downstream_err
      // and traffic_pct to shift. SRM check is separately gated by
      // DeployContext.strategy.
      return {
        kind: action ? `pod_${action}` : 'pod_fault',
        affected_signals: ['downstream_err', 'p99_latency'],
        suppress_families: ['A'],
      };
    case 'StressChaos':
      // CPU / memory stress → expect mfu, p99_latency, cost_req to
      // shift. Both Family A and Family C reasonable to suppress —
      // operator chooses; SLICE 2 default to A.
      return {
        kind: 'cpu_or_memory_stress',
        affected_signals: ['p99_latency', 'cost_req'],
        suppress_families: ['A'],
      };
    case 'IOChaos':
      return {
        kind: action ? `io_${action}` : 'io_fault',
        affected_signals: ['p99_latency'],
        suppress_families: ['A'],
      };
    case 'TimeChaos':
      // Time-skew chaos → can cascade unpredictably. Suppress nothing
      // by default; let everything fire and let the operator interpret.
      return {
        kind: 'time_skew',
        affected_signals: [],
        suppress_families: [],
      };
    default:
      // Generic fallback for kinds we don't model explicitly (HTTPChaos,
      // DNSChaos, KernelChaos, JVMChaos, *Chaos cloud-vendor kinds).
      return {
        kind: `chaos_${kind.toLowerCase()}`,
        affected_signals: [],
        suppress_families: [],
      };
  }
}

/** Translate a parsed Chaos Mesh CRD object into the canonical
 *  ExpectedFailurePattern that the orchestrator consumes via
 *  OrchestrateParams.expectedFailurePattern. `nowUnixSeconds` is the
 *  fault-start timestamp; pass `Date.now() / 1000` for live runs or
 *  a fixed value for replay determinism. */
export function translateChaosMeshSpec(
  crd: ChaosMeshCRD,
  nowUnixSeconds: number,
): ExpectedFailurePattern {
  if (!crd.spec.duration) {
    throw new Error(
      `Chaos Mesh CRD ${crd.kind}/${crd.metadata?.name ?? '?'} ` +
      `missing spec.duration; Anvil requires a bounded fault window`,
    );
  }
  const recovery_seconds = parseGoDurationSeconds(crd.spec.duration);
  const { kind, affected_signals, suppress_families } = classifyByKindAndAction(
    crd.kind,
    crd.spec.action,
  );
  return {
    kind,
    affected_signals,
    // Magnitude is operator-keyed; the CRD doesn't carry a numeric
    // perturbation target (chaos platforms describe action, not
    // magnitude). v1 default is 1σ — operator overrides via the chaos
    // adapter's `magnitude` argument if a tighter expectation is held.
    magnitude: 1.0,
    magnitude_unit: 'sigma',
    recovery_seconds,
    suppress_families,
    fault_start_unix: nowUnixSeconds,
  };
}
