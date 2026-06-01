# 10-Minute Demo Script

_Architect output. Drafted 2026-04-19 for dress rehearsal._
_Companion: the pitch draft (deleted), the elevator pitch (deleted), the pitch one-pager (deleted)._
_Voice: first-person authorship. "I designed / I ruled / I shipped." Not "the engine does."_

## Before you start

- Laptop open to `demos/demo.html` in a browser; dropdown at "Demo 1: Clean deploy."
- Have the pitch one-pager (deleted) open in a second tab for pre-conversation hand-off if requested.
- Know your audience: technical-peer (principal engineer), engineering director, or SRE lead. Default spine below is technical-peer; SRE-lead and director substitutions noted per beat.
- Pre-emptively surface the fidelity caveat for Demo 4 (Anthropic reconstruction) to own the framing before someone asks.

## Default spine (technical-peer audience)

Demo 1 → Demo 4 → Demo 2 → Demo 5 → close. Four demos in the spine; Demo 3 (GitHub 2020) is follow-up ammunition if the audience wants more examples.

**Alternate spine (SRE-lead audience):** Demo 1 → Demo 3 (GitHub 2020) → Demo 2 → Demo 5 → close. Substitutes the incident that platform SREs will recognize for the one Anthropic's engineering org will recognize.

**Alternate spine (engineering-director audience):** Demo 1 → Demo 4 (Anthropic 2025) → Demo 5 (cost regression with dollar math) → Demo 6 (baseline drift + maturity dashboard) → close. Swaps Demo 2 for Demo 6 to surface the platform-maturity-dashboard reframe — directors care about the "strategic insight source for engineering leadership" framing more than the "unknown unknowns" architectural detail. Demo 5 moves ahead of Demo 6 so the concrete dollar math primes the platform-investment framing before the maturity dashboard closes the case.

---

## Minute 0:00 – 1:00 — Framing (evidence-first opener)

**Click:** nothing yet; demo sits at "Demo 1: Clean deploy." Speak while audience sees the UI.

**Say:**

> "What you're looking at is a deployment decision engine I designed and shipped over the last six weeks. Five detector families running in parallel, formal false-alarm control via Ville's inequality, build-time compiled thresholds, conformal novelty channel. It runs on this laptop against realistic synthetic traffic for an AI inference service shaped like a large-scale inference platform. I'm going to show you four scenarios in ten minutes — a clean deploy, a reconstruction of a public incident Anthropic disclosed last September, an unknown-unknown novelty case, and a slow cost regression with worked dollar math. Each scenario exercises a different architectural beat."

**Pause beat (1 second).** Let the framing settle. Then:

> "I built this partly as demonstration evidence for conversations like this one. The engine matters; the engineering process behind it matters more. I'll surface both as we go."

**Handoff cue:** click "Demo 1: Clean deploy" if not already selected; click "Start."

---

## Minute 1:00 – 3:00 — Demo 1: Clean deploy (trust-establishment)

**Click:** Start Demo 1.

**Let it run through ticks 0–10 while you talk** (about 5 seconds per tick at demo pace).

**Say:**

> "Demo 1 is the happy path. A clean deploy, 32 ticks, all signals at healthy baseline with noise. Five detector families evaluating in parallel. Watch the provenance panel — every family reports status every tick, whether it fires or not. This is the 'self-explaining verdicts' claim with evidence. Every verdict carries its own receipt."

**Click:** the provenance panel to expand it if not already.

**Point at:** the α-budget meter.

> "Here's the α-budget meter — stacked bar, one segment per family. Total allocation is 10⁻³ per deploy, split 40/20/20/10/10 across Families A through E. I chose that split in architect REPLY-11 based on expected firing-value distributions. Notice how little we're spending — on a clean deploy, α_spent stays near zero throughout. Under Ville's inequality, run-level false-alarm probability is bounded by α_total regardless of how many ticks we look at. That's the always-valid peeking guarantee; Kayenta's classical tests don't have it."

**Let it finish.** Verdict lands on `proceed` at tick 31.

**Say:**

> "Clean proceed. All five families return clean; final-tick indeterminate collapses to clean per the Q1 Option 1 ruling I wrote in REPLY-19 — observation window is a bounded contract. Window closes without fires, we proceed."

**Pause beat (2 seconds).** Transition.

> "Let's go to a more interesting case."

**Click:** dropdown to "Demo 4: Anthropic August 2025 quality regression (stylized)."

---

## Minute 3:00 – 5:30 — Demo 4: Anthropic reconstruction (headline beat)

**Before clicking Start**, surface the fidelity caveat proactively.

**Say:**

> "A quick note on this one. This is a stylized reconstruction of the regression class Anthropic described in their September 2025 postmortem — the one where three simultaneous quality regressions got past their own evaluation suite for days to weeks. Anthropic didn't publish actual signal traces, so this isn't a replay of their production telemetry. What the demo shows is the regression class being catchable on live traffic by the multivariate and conformal families. Notice the fidelity caveat renders in the sidebar — that's honest-broker framing I require on reconstructed incidents."

**Point at:** the fidelity caveat sidebar.

**Click:** Start Demo 4.

**Let it run through ticks 0–12 while you talk.**

**Say:**

> "The trajectory stylizes Anthropic's regression class: three infrastructure-layer signals — corpus_delta, collective_ops, mfu — drifting together in a coordinated direction. Each individual drift stays under its per-signal cascade threshold. No single detector fires on any one signal alone."

**Click:** shadow-compare panel (if not already visible).

> "Watch the shadow-compare panel. Cascade column on the left — staying clean. No thresholds crossed. Portfolio column on the right."

**Ticks advance.** Around tick 10, Family C and Family E fire.

**Point at:** the provenance panel.

> "There it goes. Tick 10 — Family C, Hotelling T² on the joint infrastructure vector, crosses Wilson-Hilferty χ² quantile. Same tick — Family E, conformal Mahalanobis against the held-out healthy baseline, crosses the calibrated quantile at α_E = 10⁻⁴. Two orthogonal statistical tests agreeing on the same onset. The cascade column is still clean — threshold detectors miss the joint shift entirely."

**Verdict lands on `rollback` at tick 10.**

**Say:**

> "This is the architectural beat the Anthropic postmortem headlines. Their own evaluation suite missed these regressions for days to weeks because they evaluate output quality in batches, and individual batch runs looked clean. On live production traffic, the joint-distribution shift is catchable by multivariate and conformal tests running per-tick — which is what Families C and E do. I'm not claiming my engine would have caught all three of their specific bugs exactly; I'm claiming this regression class is catchable by the architecture."

**Pause beat (3 seconds).** This is the pitch's strongest single moment; let it sit.

> "One more thing about this demo. I originally specified it around four quality signals — eval_score, downstream_err, refusal_rate, tool_success_rate. My first implementation pass surfaced that three of those four aren't in Family C's current watch vector. Rather than smuggle in a per-scenario override to make the original spec work, I flipped my ruling to redesign the trajectory around infrastructure signals that Family C actually watches — and flagged post-phase extension of the watch vector to include quality signals. That's architect REPLY-21 if you want the decision trail."

**Handoff cue:** click dropdown to "Demo 2: Novelty (unknown-unknowns)."

---

## Minute 5:30 – 7:30 — Demo 2: Novelty catch (architectural differentiator)

**Click:** Start Demo 2.

**Let it run through ticks 0–10.**

**Say:**

> "Demo 2 is the unknown-unknowns case. A joint-distribution shift specifically designed to escape cascade's threshold detectors — individual signals stay within their bands, but the joint pattern shifts in a direction the native covariance doesn't capture. This is the pattern class no existing deploy-gate tool catches: Kayenta, Flagger, Argo Rollouts, Datadog Watchdog, LaunchDarkly — none have a novelty channel."

**Point at:** the cascade column in shadow-compare.

> "Cascade — clean throughout. Threshold detectors not firing. And watch Family E's panel as we approach tick 10."

**Ticks advance.** Around tick 10, Family C and Family E fire together.

**Point at:** the provenance panel.

> "Tick 10. Family C fires — Hotelling T² on the joint vector. Family E fires the same tick — conformal Mahalanobis. Both orthogonal statistical mechanisms crossing threshold simultaneously. Independent tests agreeing on the same onset — the corroboration pattern the architecture was designed for."

**Verdict lands on `rollback` at tick 10.**

**Say:**

> "I made a specific calibration decision here worth naming. Family E's conformal calibration source — I originally specified per-cell calibration, but cell sample sizes at project scale are around 95 samples. The conformal resolution floor is 1/(N+1), so per-cell calibration couldn't achieve α = 10⁻⁴. The aggregate-fallback calibration has ~16,000 samples, which does achieve α = 10⁻⁴ natively. Reviewer surfaced this in their W5 audit; I flipped my earlier ruling in architect REPLY-16. Family E now calibrates against aggregate fallback for the project; switches to per-cell for follow-on at production scale where per-cell samples cross the threshold."

**Pause beat (2 seconds).**

> "That flip matters for the pitch. My first architect ruling was wrong — I missed that aggregate fallback was available. Reviewer's independent architectural analysis caught it. I flipped the ruling rather than defend the first answer. That's the kind of process quality the three-role coordination model was designed for."

**Handoff cue:** click dropdown to "Demo 5: Slow cost regression."

---

## Minute 7:30 – 9:00 — Demo 5: Cost regression + dollar math

**Click:** Start Demo 5.

**Let it run through ticks 0–16 while you talk.**

**Say:**

> "Last demo. Cost regression pattern — cost-per-request drifts slowly upward simulating a prompt-template change or retrieval-layer regression. By tick 31 the cumulative drift is about 9%, still below cascade's 1.20 ratio threshold on cost_req. Cascade never fires. This is the class of failure that threshold-based gates miss and shows up in the monthly bill instead."

**Tick 16 — Family A fires.**

**Point at:** Family A's panel.

> "Tick 16. Family A's Page-CUSUM on cost_req fires. Under Page-CUSUM with mixture prior, the accumulator resets when the signal is below zero, so pre-drift stable ticks don't dilute the statistic. Once drift starts, the cumulative log-likelihood ratio grows roughly linearly and crosses the rejection threshold at -log(α_per_signal) ≈ 9.6. Here, tick 16."

**Say:**

> "Dollar framing. A 10% cost regression on 1 billion requests per month at $0.005 per request is about $500,000 per month of additional spend. Caught at week 1 by Page-CUSUM, exposure is roughly one-quarter of a month — about $125K. Detected only when the monthly bill arrives one to three months later, exposure scales to $500K–$1.5M per regression. Order-of-magnitude numbers, not production-specific — the load-bearing variable is the time-to-detection delta, which scales with your per-request cost and request volume. Multiple regressions per year compound."

**Pause beat (3 seconds).**

> "This is the only demo in the five that carries explicit economic framing. The others pitch on different beats — transparency, multi-family corroboration, unknown-unknowns coverage. But for a platform-level investment conversation, the dollar framing is concrete enough to defend under pushback."

**Handoff cue:** click dropdown back to Demo 1 or close the demo view.

---

## Minute 9:00 – 10:00 — Close (hand back the floor)

**Say:**

> "So those four demos: clean proceed with provenance; multi-family corroboration on the Anthropic regression class; unknown-unknowns novelty catch; slow cost regression with dollar math. Each exercises a different beat the architecture was designed for. The fifth demo — GitHub's 2020 Redis cascade reconstruction — I'll show if you want more examples after."

**Pause beat (1 second).**

> "What I want to leave you with is three things. First: the engine in the browser is evidence, not a product claim. Real-data validation at production scale is the first 90 days of work for follow-on — shadow mode on platform inference, then advisory, then first real deploy decisions. Second: the architectural innovation that matters is the calibration compiler — moving statistics from detect-time to build-time. Nobody else in this space does that; it's the thing that makes formal FP control tractable at scale. Third: everything I just showed you is traceable. Twenty-three architect replies in the coordination trail; six reviewer reports; dated commits; every decision has receipts. That's how I'd run platform engineering at production scale — and I'd like to talk about what that looks like concretely for your first year."

**Pause.** Hand the floor back.

> "Questions?"

---

## Bank of follow-up questions + responses

Pre-prepared answers for predictable follow-ups. Use only if asked.

**"How does this compare to Kayenta?"** (Most likely question; answer in ~60 seconds.)

> "Kayenta is first-generation: per-deploy, per-metric two-sample tests, fixed-sample statistics, operator-set thresholds. Good at what it does; production-proven at Netflix scale. What this architecture adds is second-generation capability: anytime-valid inference via Page-CUSUM so we can peek every tick without FP inflation; multivariate drift via Hotelling T² that Kayenta doesn't do; conformal novelty channel that Kayenta doesn't do; AI-inference-specific structural detectors shipped as a library rather than rebuilt per-workload as analysis templates; and compiled thresholds with explicit α budget for reproducibility. If the operator runs Kayenta, this plugs in as an AnalysisTemplate provider — Level 1 web metric — where a specific template would otherwise live. Migration is incremental, service by service, with shadow-mode comparison."

**"Dollar savings — what do you actually save?"**

Walk through the Demo 5 worked example: "1 billion requests per month, 10% regression, $500K/month additional spend, time-to-detection delta is the load-bearing variable, multiple regressions per year compound, order-of-magnitude numbers scale with customer specifics."

**"Does your product include fully automated baselining?"**

> "Honest answer: detection yes, full automation no. The drift detector is shipped runtime code — Mahalanobis distance between the current baseline's cell-mean vector and a rolling window of recent samples, SEM-scaled, fires on χ² quantile. You can watch it fire live in Demo 6 at tick 18. The baseline-version archive schema is shipped too — `runs/baseline-history/<service>/<version>.json` with recalibration-reason enum and drift-detection-result block. And the service-maturity-dashboard UI renders against that archive. What's NOT shipped as runtime code is the workflow that takes a drift detection, runs the compiler on recent healthy traffic, runs shadow-mode comparison, and promotes the new baseline. That workflow is architecturally specified in the coordination trail (ARCHITECT-REPLY-24) but is first-90-days for follow-on production work — it needs real telemetry to wire to, which requires production telemetry integration. The substrate is the hard part; the loop is straightforward once production data is wired. Demo 6 demonstrates the substrate end-to-end on a synthesized v1→v5 history."

**"What about non-stationary baselines / diurnal patterns?"**

> "I added a segmented baseline cell matrix as architecture addition #2 — cells indexed by hour-of-day × day-of-week, hierarchical pooling for sparse cells, Ledoit-Wolf shrinkage on covariance. Runway ships 2-D cells (168 cells); for follow-on extends to workload-class and tenant-slice dimensions once cardinality supports it."

**"What about multi-hypothesis correction?"**

> "Bonferroni within Family A across the 6 primary SLIs — α_per_signal = α_family_A / 6. Family-level α allocation is effectively Bonferroni at the family level. Benjamini-Hochberg FDR is the next step for follow-on for higher-dimensional metric sets; runway ships Bonferroni."

**"How do you handle the canary vs baseline population comparability problem?"**

> "CUPAC-style covariate adjustment handles predictable bias. For adversarial assignment — canary population systematically different from baseline — I specified propensity-score matching plus switchback rotation as architecture addition #7. Runway ships docs-only; implementation is deferred once real tenant routing shapes are visible."

**"Doesn't your synthetic data calibration limit what you're proving?"**

> "Yes. I'm explicit about this throughout — the project evidence is synthetic; every claim about production behavior is hedged against 'real-data validation happens in the first 90 days.' What the project proves is that the architecture runs correctly on representative data and that the detector families catch the classes of failure they were designed for. The synthetic baseline is calibrated to realistic cross-signal correlations; the adversarial scenarios exercise known failure patterns; the demos are stylized on real public incidents. None of this substitutes for production; it's runway-scope evidence."

**"Did you make any architectural mistakes during the project?"**

> "Yes — three. All spec-verification failures: I specified demo trajectories without grep-verifying the signals against current engine constants. Session 10 overran its time budget by 26% as a result. I fixed the problem by adding pre-route grep discipline to architect-side hygiene and documenting the lesson in REPLY-21. The runway produced that process improvement in-stream, not retrospective-only. That's the kind of failure recognition I think distinguishes senior engineering work."

---

## Demo 7 (alt-spine) — Real-trace cross-substrate consistency (post-Phase-3 close)

Optional alt-spine variant for technical-rigor audience (research-leaning principals; SRE-skeptical-of-synthetic-validation listeners). Surfaces Q60 Slice 1 V2 + Phase-3.d.1 (A)+(D)+L3b β.1 hybrid validation against real-trace baselines, not just synthetic.

**Trajectory:** Run 5 hand-curated postmortem scenarios on:
1. `synthetic_v1` substrate (canonical production validation; v5-sequential-e-process.json).
2. Real-trace substrate of architect-pick (`v8a-real-burstgpt-v1.json` for cost_req-only signal coverage; `v8b-real-azure-llm-inference-v1.json` for tokens_turn-only; `v8c-real-mooncake-v1.json` for kv_cache + tokens_turn). Slice 2 substrates (v9a/b/c HuggingFace + AlpaServe + DeepSpeed-FastGen) TBD post-Q62 Phase 1 acquisition close.

Compare detector-firing decisions across substrates; verify cross-substrate ΔTPR within 10%, ΔFPR within 0.5 × α-budget × 1.2 bound.

**Talking points:**

- "DeploySignal validates against real-trace baselines, not just synthetic — empirical cross-substrate consistency demonstrates substrate-independence at methodology level."
- "Per-substrate × per-detector exemption mapping (per signal coverage) is honest scope disclosure: when a substrate doesn't carry a signal, the detector is exempted from FPR evaluation rather than synthesizing fake data. CAVEAT inheritance for classical-epoch-α detectors documented per Q58 H4 PERMANENT."
- "Q60 Phase 3 sweep dispatched on Mac mini personal hardware (B4 compute target) over Tailscale; ~10 min wall-clock for 160 (substrate × scenario × seed) trials with V2 incremental SweepCheckpoint emission for crash-recoverability. Operational discipline pattern reusable for future Phase-3.d Ville-bounded re-engineering scopes."
- "Investigation discipline matures via per-tick detector trace tool primitive (Q63; `tools/per-tick-detector-trace.ts`); when a detector fires unexpectedly cross-substrate, the tool localizes mechanism per architectural layer in minutes rather than hours."

## Audience-specific substitutions

**For an engineering director** (as opposed to a principal engineer):

- Use the director alternate spine: Demo 1 → Demo 4 → Demo 5 → Demo 6 → close. See the dedicated Demo 6 walkthrough block below.
- Substitute Demo 3 (GitHub) for Demo 4 if the Anthropic-specific context doesn't land for the audience — GitHub is more broadly recognized.
- In the close, emphasize engineering-process evidence more than architectural detail: "twenty-six architect replies, continuous-flow cadence observable via session throughput, three-role-plus-Reviewer coordination model" rather than "calibration compiler moves statistics from detect-time to build-time."
- Lead with the dollar framing (Demo 5) before the maturity-dashboard reframe (Demo 6) — directors absorb concrete dollar math first, then platform-investment-framing reframe second. Both value propositions get surfaced in sequence.

### Demo 6 walkthrough (engineering-director alternate spine only)

**Position:** replaces Demo 2 in the spine for director audiences. Runs ~1 minute 30 seconds to 2 minutes, typically between Demo 5 and the close.

**Click:** dropdown to "Demo 6: Baseline Drift + Service-Maturity Dashboard."

**Before clicking Start, set up the reframe:**

> "One more demo. The first five demos have all been about the gate catching regressions — what you'd expect a deployment decision engine to do. Demo 6 is about what you get for free once the gate is running. It's an architectural reframe."

**Click:** Start Demo 6.

**Let it run through ticks 0–18 while you talk.**

**Say:**

> "Three primary SLIs — p99_latency, downstream_err, cost_req — drifting slowly downward over 32 ticks. Cumulative improvement: p99 down 6.8%, downstream errors down 5.1%, cost-per-request down 6.8%. This isn't a bad deploy. It's the service getting better over time — the kind of gradual improvement that happens as infrastructure optimizations land, retrieval layers tune, model-serving-engine versions upgrade."

**Tick 18 — drift detector fires.**

**Point at:** the drift-detection badge / baseline-history panel.

> "Tick 18. The drift detector fires. It's watching the Mahalanobis distance between the current baseline and a rolling window of recent traffic — standard-error-scaled so it has N-sample sensitivity the per-tick detectors don't have. The detector recognizes that the baseline has drifted far enough from recent reality that recalibration is warranted. Critically, no family fires rollback. The system distinguishes 'the baseline is stale' from 'this deploy is bad.'"

**Pause beat (2 seconds).** Transition into the reframe. Be explicit about what's shipped as runtime code vs what's for follow-on: **the drift detector you just watched fire is real runtime code; the baseline history you're about to see rendered is a synthesized v1→v5 archive demonstrating what the dashboard looks like. The automation workflow that takes a drift detection and produces a new baseline version in production — that's first-90-days work when real telemetry is wired.**

> "Here's the reframe. Notice what just happened. The drift detector flagged the baseline as stale. In production, the next step is automation: run the compiler on recent healthy traffic, stand up the new baseline in shadow, validate it, promote. That workflow is architecturally specified but not runtime-implemented in this project — it's the first-90-days follow-on scope. What IS shipped in this project is what you're looking at on screen right now: the drift detector's output, the baseline-version archive schema, and the dashboard UI rendering against a synthesized v1→v5 history. Think of v1 through v5 as what a year of production running would produce once the automation loop is wired. If I run this gate across a service for twelve months in production, I get a time series of baselines. That time series IS a dashboard. Watch."

**Point at:** the baseline-history panel / trend chart.

> "Service trajectory. Baseline p99 trending 600ms to 400ms over twelve months? Your service got faster. Baseline error rates trending down? Reliability improved. Baseline cost_req trending down? Efficiency improved. These aren't deploy decisions. They're platform-level insights that fall out of running the gate in production."

> "Engineering maturity. Rollback frequency across many deploys trending down? Deploys got safer. Drift-detection interval lengthening? Baselines stabilized, meaning the underlying service stopped moving as much. Traffic-gate thresholds rising? Confidence grew, and the platform let deploys reach higher traffic percentages before requiring advisory review."

**Pause beat (3 seconds).** This is Demo 6's core pitch beat; let it sit.

> "The deploy gate turns into a platform-monitoring layer. Not a new instrumentation surface — just a byproduct of the same audit trail the gate already produces. Every recalibration event becomes a data point in a higher-level dashboard for engineering leadership. That's the second value prop: the gate is operational substrate for platform-engineering decision-making."

**Handoff cue:** return to close (Minute 9:00 in default spine; analogous position in director alternate spine).

**Architectural caveat if asked:** "The demo compresses service-improvement-over-months into 32 ticks for pacing. In production, drift detection runs at per-recalibration-interval cadence, not per-tick. The Mahalanobis math and chi-squared threshold derivation are architecturally representative; the time compression is pitch-pacing only. **Also explicit: the project ships the drift detector, the baseline-version archive schema, and the dashboard UI as runtime-exercised code; the automation workflow that turns a drift detection into a new baseline version is architecturally specified but not runtime-implemented — it's the first-90-days-at-the-target-platform scope. Demo 6 ships substrate; automation loop closes for follow-on.** Follow-on at production scale, the baseline archive becomes lifecycle-tracked; the maturity dashboard becomes governance-layer-governed."

**Divergence-from-spec honest-broker note (if a reviewer with access to the coordination trail asks):** "The drift detector first-fire calibrated to tick 18 rather than the spec target tick 12. My original spec in architect REPLY-24 specified drift magnitudes (p99 −0.3%/tick, downstream_err −1.5%/tick) that, at the project's v4 Ledoit-Wolf cell covariance, produced Mahalanobis distance squared ≈ 4 at tick 12 — well under the χ² threshold of 31.26. Hitting tick 12 would have required drift magnitudes that tripped Family A's mSPRT first. Mac Claude followed my own instruction (REPLY-24 lines 153–155: 'reduce drift magnitudes if family fires; do not touch family thresholds') and calibrated to tick 18 instead. The architectural priority was preserved — all five detector families stay clean throughout; drift detector fires at tick 18 with d² ≈ 35.7 against threshold 31.26. This is in the JSON's `divergence_from_spec` field. Classic case of architect spec ordering surviving implementation-time calibration pressure."

**For an SRE lead**:

- Lead with Demo 3 (GitHub 2020) in the spine — the incident they'll remember most vividly.
- Emphasize operational beats: fail-open gate reliability, incident-state integration (Addition #6), audit provenance for postmortems, shadow-mode rollout plan.
- Lean harder on PM-critique resolutions: multi-hypothesis correction, non-stationary baselines, assignment bias, rollback correctness, gate's own blast radius.

---

## Pacing notes

- Each demo runs ~10 seconds in the browser at demo pace (500ms/tick × 20 visible ticks before rollback verdict). Narration has to fit alongside.
- Pause beats are explicit in the script. They're not filler; they're for audience absorption at architecturally significant moments.
- If you run over, drop Demo 5's narration to one sentence ("tick 16, Family A fires, cascade misses, dollar framing is order-of-magnitude $500K-$1.5M delta per regression") and spend the recovered time on close.
- If you run short, the follow-up questions bank above covers 15 minutes easily.

## Post-demo ready states

After the 10 minutes, three possible next states:

- **Audience wants more demos:** show Demo 3 (GitHub 2020, multi-family corroboration beat) or Demo 6 (baseline drift + maturity dashboard reframe) depending on what the audience responded to. Demo 6 walkthrough in the audience-specific substitutions section above.
- **Audience has technical questions:** follow-up question bank above. Route into the pitch draft (deleted) sections if they want depth.
- **Audience wants to talk careers:** shift to the pitch draft (deleted) Part 7 (first 90 days) and Part 8 (questions I'd want to explore). Those are the job-conversation surfaces.

## What I need to rehearse specifically

Three things most likely to break under pressure:

1. **Demo 4 fidelity caveat timing.** The caveat has to precede the demo run, not follow. Rehearse the opening two sentences until they flow — "A quick note on this one. This is a stylized reconstruction..."
2. **Dollar math on Demo 5.** The numbers are exact; you need to cite them correctly. Practice: "1 billion requests per month at $0.005 per request is $500K per month additional spend; week-1 catch = $125K; month-3 catch = $1.5M."
3. **The close's three-things structure.** "Engine is evidence not a product claim; calibration compiler is the innovation; everything traceable." Memorize the one-sentence framing of each; improvise the rest.

Everything else can be improvised off the script.
