# Contributing to DeploySignal

Thanks for your interest. DeploySignal is a reference implementation of a statistical deploy-gate decision engine — a portfolio artifact demonstrating architectural depth + coordination methodology, not a heavily-maintained product. Contributions welcome but expect slower response times than active OSS projects.

## What this is

A worked example showing:

- Five statistical detector families composed against a shared α budget
- Calibration-as-compile-step (versioned `CompiledConfig` artifact)
- Per-cell stratification (5 dimensions: hour × day × workload × tenant × region)
- Anytime-valid Ville-bounded supermartingale constructions:
  - Mixture-supermartingale Page-CUSUM (Howard-Ramdas-McAuliffe-Sekhon 2021)
  - Betting e-process for Sequential MMD with RFF (Shekhar-Ramdas 2023; Rahimi-Recht 2007)

## What this is NOT

To be clear about scope:

- **Not a hallucination detector** — use Vectara, Fiddler, Arize, WhyLabs, Patronus for per-request output verification
- **Not a content guardrail** — use Lakera, Fiddler for toxicity/prompt-injection detection
- **Not a pre-deploy evaluation battery** — use W&B, HF Evals, OpenAI Evals as upstream gate
- **Not an in-pipeline CD UX** — use Argo Rollouts, Flagger, Harness, Spinnaker; DeploySignal is the analysis engine inside those rollout controllers
- **Not production-ready as-is** — wrap with deployment platform integration (orchestration adapter pattern; see `ORCHESTRATION-ADAPTERS.md`)

## Development setup

```bash
git clone https://github.com/johnpatrickwarren-oss/deploysignal.git
cd deploysignal
npm ci
npm test
```

Node 24+ required (native TypeScript execution; older Node versions hit `ERR_UNKNOWN_FILE_EXTENSION` on `node --test test/*.test.ts`).

Run the demo locally:

```bash
cd demos
python3 -m http.server 8000
# open http://localhost:8000/demo.html
```

## Submitting changes

### Issues

File issues for:

- Bugs in the reference implementation
- Documentation errors / unclear sections
- Architectural questions or methodology discussion

Please include:

- Clear description
- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Environment details (Node version, OS) for runtime issues

### Pull requests

PRs welcome for:

- Bug fixes
- Documentation improvements
- Test coverage expansion
- Performance improvements that preserve statistical correctness

For larger architectural changes: file an issue first to discuss before opening a PR. The detector portfolio + α-budget structure is intentionally specific; deviations need rationale.

PR checklist:

- [ ] Tests pass (`npm test`)
- [ ] TypeScript compiles cleanly (`tsc -p tsconfig.test.json`)
- [ ] No new dependencies without rationale (this is a minimal-deps reference)
- [ ] Existing detector statistical guarantees preserved
- [ ] PR description explains the change + cites any relevant papers/specs

### Code style

Follow existing patterns. Project uses TypeScript with strict mode; no automated formatter (prose-style hand-formatted code).

## Statistical correctness

Detector families have formal false-positive rate guarantees under specific assumptions (Ville-bounded anytime-valid for the betting / supermartingale variants; classical-epoch-α with Bonferroni correction for the bootstrap-null fallback; per-family α allocations). PRs that touch detector math must:

- Cite the relevant statistical paper / proof
- Add tests that verify the formal guarantee empirically (FPR ≤ α × tolerance under H₀ on synthetic data)
- Not silently change α-budget allocations

See `DETECTOR-MATH-RESEARCH.md` for context. Methodology background: [github.com/johnpatrickwarren-oss/anchor](https://github.com/johnpatrickwarren-oss/anchor).

## Maintainer response expectations

Single-maintainer reference repo. Expect:

- Issue triage: ~1 week
- PR review: ~1-2 weeks
- Major architectural changes: longer; may require discussion before review

If a PR is urgent for a downstream user, please mention that in the PR description.

## Code of conduct

Standard expectations: be respectful; technical disagreement welcome; personal attacks aren't. Same posture as any well-run open-source project.

## License

By contributing, you agree your contributions are licensed under the Apache License 2.0 (see `LICENSE`).
