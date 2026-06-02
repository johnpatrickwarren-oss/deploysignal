// engine/detectors/family-c-betting-e-process.ts — Family C canonical
// Shekhar-Ramdas-2023 betting-e-process variant (Q67 SPEC Phase-3.d.B).
//
// FACADE: this file is a behavior-preserving re-export surface. The
// implementation was split (god-file decomposition) into cohesive
// sibling modules; all public names remain importable from this path:
//
//   _family-c-betting-state.ts    — constants + freshFamilyCBettingEProcessState
//   _family-c-betting-witness.ts  — computeRffWitness / computeKernelMMDWitness
//                                    / onsUpdate (+ liveVectorFamilyC)
//   _family-c-betting-eval.ts     — evaluateFamilyCBettingEProcess (decomposed)
//
// Per Q67-PHASE-3-D-B-MMD-BETTING-E-PROCESS-SPEC.md § Q67.2 v2 (architect-
// drafted; canonical-aligned via library cross-check at
// `github.com/sshekhar17/nonparametric-testing-by-betting`):
//
//   `kernelMMD.py kernelMMDprediction` lines 57-92 — predictable witness
//      F[i] with running-max normalization at i > 10.
//   `SeqTestsUtils.py:11-38 ONSstrategy(F, lambda_max=0.5)` — ONS update
//      with c = 2/(2−log(3)) ≈ 1.6336, A_0 = 1, two-sided clamp.
//   `kernelMMD.py computeMMD` lines 14-54 — biased V-statistic MMD
//      estimator (denominators include diagonal).
//
// Wealth recursion (Shekhar-Ramdas 2023):
//
//   F_t = W_{t−1}(x_t)                        (kernel-MMD witness payoff)
//   S_t = S_{t−1} · (1 + λ_{t−1} · F_t)       (multiplicative wealth)
//   Fire when S_t ≥ 1/α                       (Ville bound; anytime-valid)
//
// ONS update (predictable; A_t F_{t-1}-measurable):
//
//   z_t = −F_t / (1 + λ_{t−1}·F_t)             (gradient; canonical sign)
//   A_t = A_{t−1} + z_t²                       (accumulated Hessian)
//   λ_t = clamp(λ_{t−1} − c·z_t/A_t, ±λ_max)   (Cutkosky-Orabona 2018 step)
//
// Distinct from existing #20 evaluateEMmd in sequential-mmd.ts —
// evaluateEMmd implements the Option-B simplification (kernel-distance
// scalar fed through GRAPA/ONS-fallback `pickBet`); this file implements
// the canonical Shekhar-Ramdas-2023 ONS variant with split-sample witness
// + running-max normalization + canonical hyperparameters. Both coexist
// at SLICE 1 — runtime dispatcher (sequential-mmd.ts; Step 3) picks per
// `mmd_variant` flag on the per-cell calibration.
//
// State management mirrors Q66 Phase-3.d.A SLICE 1 pattern: per-(tier,
// hour, day) cell-keyed state on the caller's state bag; persists across
// ticks within a deploy; orchestrator caller owns lifetime (not re-keyed
// across deploys — same convention as evaluateEMmd).
//
// Streaming-adapted predictable witness — DeploySignal use case has P
// fixed (per-cell baseline) + Q streaming (1 obs/tick). Q-side empirical
// distribution stored as running-sum / running-count (O(d) state); Q-side
// kernel evaluated at the empirical mean per coordinate. Predictability
// preserved because state.q_running_sum / state.q_count reflect ONLY past
// observations (mutated AFTER witness computation; mirrors architect-
// drafted pseudo-code line ordering).

export { freshFamilyCBettingEProcessState } from './_family-c-betting-state';
export {
  computeRffWitness, computeKernelMMDWitness, onsUpdate,
} from './_family-c-betting-witness';
export { evaluateFamilyCBettingEProcess } from './_family-c-betting-eval';
