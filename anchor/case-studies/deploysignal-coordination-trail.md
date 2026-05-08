# Case Study — DeploySignal Coordination Trail

_The empirical record from which this anchor pack was distilled._

## Project context

[DeploySignal](https://github.com/johnpatrickwarren-oss/deploysignal) is a statistically-rigorous deployment safety system for AI inference workloads. Built over 14 weeks as a 4-role multi-agent project (Architect / TPM / Implementer / Reviewer). Reference implementation runs on a laptop in 10 minutes; passes 800+ tests; reviewer-verified right-reasons audit on 6 canned demos including reconstruction of a publicly-disclosed AI inference regression.

This case study summarizes the empirical evidence supporting the anchor pack's claims.

## Trail size

- 250 coordination files (architect replies, TPM replies, reviewer reports, diagnostic memos, post-mortems, Q-specs)
- 95 architect replies
- 90 TPM replies
- 14 reviewer reports
- 13 diagnostic memos
- 7 postmortem / investigation documents
- 16 Q-spec docs (each one a topic with multi-round investigation)
- 217 test files
- 50 files with explicit failure-class language ("falsified", "wrong premise", "engine-incorrect", "miscalibration", "incoherence")

## Empirical findings on autonomous execution

Of the 99 TPM artifacts, only 6 (~6%) reference the human user's explicit input. The other 94% of TPM coordination work was generated autonomously by the TPM agent. The human's role pattern:

- Strategic disposition on TPM-prepared option sets
- Catalytic prompts ("are any of SRG's strong suits adaptable?")
- Pattern-recognition triggers for deep-dive investigations (when "churn" was sensed)

This is the empirical basis for the anchor pack's claim that the disciplines are largely encodable for autonomous agent execution, with human intervention as a rare, pattern-detectable escalation rather than continuous oversight.

## Empirical findings on catches

Bugs caught during the project that single-agent baselines would plausibly have missed (per independent post-build audit, with single-agent miss probability estimated at 60-90% per finding):

1. **σ² compile-time underflow on bounded-probability signals** (60/66 cells affected). Caught via per-signal cell-level audit during a different investigation. Would have caused Hotelling T² blow-ups on tool_success_rate / refusal_rate signals in production.

2. **Diagonal-covariance parametric resampler bug.** Generator produced each signal independently; joint covariance was diagonal. Family C/E calibrated against non-diagonal Σ; mis-distributed samples. Caught via wrapper-bypass log diff (T2 anchor's multi-read-paths discipline).

3. **Calibration-source incoherence.** 168/336 cells used Σ_C from cross-cell aggregate while Σ_A used per-cell empirical; they disagreed by ~15%. Caught downstream of resampler fix.

4. **Family D kv_cache miscalibration.** 24/131 fires localized to kv_cache cells. Caught by reviewer's empirical audit.

5. **Documentation engine-incorrectness** (`demo-tokens-creep.json` `divergence_from_spec` text). Caught by reviewer's programmatic re-run; would have shipped wrong narrative.

6. **Pitch-claim unsubstantiated** (an unsubstantiated cost-impact comparison citing a specific external platform). Caught by reviewer ahead of external pitch; would have failed under skeptical SRE questioning.

## Empirical findings on cost

The methodology produced one well-documented expensive-failure mode: the Topic 52 phantom investigation chain.

- 7 architect artifacts (REPLY-52gb through REPLY-52gh) chasing a misattribution
- 6 implementer commits on the phantom
- ~2-3 days of wall-clock cost
- Misattribution born from a single attribution-string compression in a diagnostic file

Caught when wrapper-bypass log diff (V/Q framework Step 5 — escalate after 3+ ruled-out Vs) forced re-enumeration. Phantom resolved.

The phantom failure produced a NEW discipline (P3 axis 10: firing-attribution-discipline), memorialized as the canonical worked example for [`02-memorial-accretion.md`](../skills/02-memorial-accretion.md). The discipline has since prevented multiple recurrences in subsequent investigations.

**Cost/benefit on this sample: favorable.** Each catch (especially σ² underflow + resampler bug) would have been multi-day production incidents if missed. The 2-3 day phantom cost is bounded and produced a permanent discipline upgrade.

## Empirical findings on ceremony vs substance

Initial classification of methodology rituals against the trail (per audit):

| Ritual | Classification |
|---|---|
| Round numbering convention | SUBSTANCE — cross-role correlation; low overhead, real coordination value |
| Anti-scope ledger | SUBSTANCE — caught scope creep at compile-time-grilling |
| V/Q framework | SUBSTANCE — bounded the Topic 52 phantom chain at 7 artifacts vs unbounded recursion |
| 10 P3 axes | SUBSTANCE — each axis born from a specific real-world failure |
| 4-anchor pre-merge defense (T0-T3) | SUBSTANCE — each anchor caught what others missed |
| Memorial D 4-factor weighting | UNCLEAR — heavy formal apparatus; benefit harder to attribute |
| Memorial F sub-rule grep-discipline | SUBSTANCE — caught real consumer-side breakage |
| Three-layer architect framework | UNCLEAR — sample didn't show specific catches attributable to it |
| Continuous-flow cadence | SUBSTANCE — freed development capacity |
| Compute server routing | SUBSTANCE — preserved laptop responsiveness for coordination |

**Approximately 80% substance, 20% unclear.** Almost no rituals look like pure overhead.

## Independent audit summary

A post-build independent audit (May 2026) verified:

- **Math:** correct line-by-line vs statistical literature. One README framing imprecision flagged (Ville-bounded claim is delivered by betting e-process and Family C/E components, not by Page-CUSUM alone).
- **Methodology:** effective. ~94% autonomous; ~80% of rituals are substance. Six concrete catches with high single-agent miss probability.
- **Market:** real but narrow gap vs existing opinionated methodology frameworks (Superpowers, BMAD, Spec Kit). DeploySignal's specific differentiators (Memorial accretion, TPM-as-coordinator, audit-trail file discipline) are real but fast-followable.

The audit itself ([linked in DeploySignal repo](https://github.com/johnpatrickwarren-oss/deploysignal/tree/main/audit/independent-review-2026-05-04)) is part of the case study evidence — it demonstrates the methodology's discipline pattern (commission an independent audit of your own work before declaring it done) applied to itself.

## Honest limits of this case study

- **N=1 project.** Generalization to other domains is hypothesis, not validated. The anchor pack's claims should be applied with appropriate skepticism until additional case studies accumulate.
- **Specific to high-stakes correctness-critical domain.** AI inference reliability has unusual constraints (formal statistical guarantees, irreversible deploy decisions). Methodology may over-engineer for lower-stakes domains.
- **Single human operator.** Multi-human-operator dynamics not tested.
- **Single agent platform.** Built on Claude Code + Cowork chats with Anthropic's Claude. Generalization to other agent platforms (CrewAI, LangGraph, Devin, etc.) is hypothesis.

If you adopt the anchor pack for a different domain or platform and find it useful (or find it doesn't generalize), please open an issue in the [anchor repo](https://github.com/[link]) describing the experience. Case studies from other contexts are the most valuable contribution to the pack.
