# Security Policy

## Reporting a vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

Two private reporting channels:

1. **GitHub private vulnerability reporting** (preferred):
   <https://github.com/johnpatrickwarren-oss/deploysignal/security/advisories/new>

2. **Email**: john.patrick.warren+deploysignal-security@gmail.com

What to include:

- Description of the vulnerability
- Steps to reproduce
- Affected commit SHAs / version range
- Potential impact (what can an attacker do?)
- Suggested fix (optional)

## Scope

DeploySignal is a reference implementation of a statistical deploy-gate decision engine. Vulnerability scope:

**In scope:**

- Code execution / injection vulnerabilities in engine, tools, or audit code
- Supply chain risks (dependency vulnerabilities surfaced by `npm audit`)
- Cryptographic weaknesses (most of the engine is statistical, not cryptographic, but applicable if found)
- Audit-trail integrity issues (verdict provenance tampering; replay-clean reconstruction failures)
- CI / build pipeline vulnerabilities

**Out of scope:**

- Production deployment hardening (authentication, SSO, multi-tenancy, secret management, network isolation) — that's the integrator's responsibility; DeploySignal is the analysis engine layer
- LLM prompt-injection attacks against generated content — DeploySignal doesn't process LLM outputs; use Vectara, Fiddler, Arize, or Lakera for that
- Statistical-correctness disagreements — file an issue, not a vulnerability report
- Issues in transitive dependencies that don't affect DeploySignal's actual usage path
- Theoretical attacks requiring physical access to the deployer's machine

## Response

- **Acknowledgment**: within 1 week of receipt
- **Triage + initial assessment**: within 2 weeks
- **Fix or mitigation**: timeline depends on severity (critical: days; high: weeks; medium/low: best-effort)

## Versions supported

Only the **latest commit on `main`** is considered "supported" for security purposes. Forks and integrators should pull updates from main when security advisories are published.

## Disclosure policy

Coordinated disclosure preferred:

1. You report privately
2. Maintainer acknowledges + investigates
3. Fix is developed (in private branch if severity warrants)
4. Fix is merged to main
5. Security advisory is published with credit (anonymous if requested)

Suggested embargo: 90 days from acknowledgment, or earlier if a fix lands sooner. Negotiable case-by-case for critical vulnerabilities affecting downstream users.

## Past advisories

(Empty — no security advisories published as of this writing.)

## Known security caveats

By design + scope:

- DeploySignal stores compiled baselines (`runs/baselines/`) and verdicts (`audit/`) as files; integrators are responsible for filesystem permissions, encryption-at-rest, and access controls
- The browser demo (`demos/demo.html`) is a self-contained client-side artifact; no network calls; no credentials. Safe to load locally
- CI runs `npm audit --audit-level=high` on every push as a continuous check (`.github/workflows/security.yml`)
