# DeploySignal — Code Review Remediation Plan

**Date:** 2026-06-10
**Commit reviewed:** `707a500` (default branch, fresh clone of `johnpatrickwarren-oss/deploysignal`)
**Reviewer:** Claude Code (automated thorough review)

## Summary

The repository is in strong overall health: it compiles cleanly (`tsc` engine + test configs), and the full test suite passes — **988 tests, 980 pass, 0 hard failures, 2 skipped, 6 todo** (2 of the todo tests fail by design pending an architect-scope `cell_patch` fix; they are annotated and do not break the run). The engine source (`engine/`, `tools/`, `advisory/`) is carefully written and well-tested. The real defects cluster in the **legacy loop-tunable surface `shared.js`**, which contains machine-appended rule code with several use-before-declaration bugs — including one that makes an entire rollback detector permanently dead, masked by an empty `catch` — plus a likely formula slip in `engine/core.ts`'s `effectiveThreshold`, broken/stale packaging and doc references, and a handful of low-severity CI/config/hardening items. No committed secrets, no unsafe YAML loading, no injection or path-traversal issues were found.

---

## Findings

### Critical

*None found.*

### High

#### H1. `shared.js` `gpu_eff` rollback detector throws on every invocation and is silently swallowed — detector permanently dead

- **File:** `shared.js:285-286` (definition), `shared.js:702-703` (the masking catch)
- **Problem:** The warmup-guard line reads `tm.slopeNorm` *before* `var tm = tb ? tb.get('mfu') : null;` is assigned on the next line. Due to `var` hoisting, `tm` is `undefined` at line 285, so the check throws `TypeError: Cannot read properties of undefined (reading 'slopeNorm')` whenever `ctx.changeType === 'model_weights'` — the **only** changeType under which this detector can fire (line 283 returns `false` otherwise).
- **Evidence (verified empirically):**
  ```
  $ node -e "require('./shared.js').ROLLBACK_DEFS.find(d=>d.id==='gpu_eff').check(...model_weights ctx...)"
  gpu_eff check THREW: TypeError - Cannot read properties of undefined (reading 'slopeNorm')
  ```
  `evaluateSignals` wraps every check in `try { ... } catch(e) {}` (shared.js:702-703), so the throw is invisible and `gpu_eff` simply never fires on the legacy/cascade demo path. The engine port (`engine/gates/_health-defs.ts:156-177`) is a clean rewrite and is NOT affected.
- **Remediation:** Move the `var tm = tb ? tb.get('mfu') : null; if (!tm || tm.n < 4 || tm.insufficient) return false;` lines (shared.js:286-287) *above* the warmup-guard at line 285. Add a regression test that invokes each `ROLLBACK_DEFS`/`EXTEND_DEFS` `check` directly (no try/catch) against a representative input and asserts no exception is thrown.

### Medium

#### M1. Additional use-before-declaration dead guards in `shared.js` (var-hoisting)

- **Files / lines:**
  - `shared.js:132` (`p99` check): `... && tr > 1.10) return false;` — `tr` is declared at line 137 inside the later `if (tt ...)` block. At line 132 `tr` is `undefined`, so `undefined > 1.10` is always false → this noise-suppression guard (CV > 0.25, low latency ratio) **never applies**.
  - `shared.js:210` (`tokens` check): `p99R` is compared (`p99R < 1.0`) before `var p99R = ...` later in the same statement sequence; `_tp99Tok` is read into `_tp99SlopeNorm` before `var _tp99Tok = ...`; `tickEstTok` is compared (`tickEstTok < 6`) before `var tickEstTok = ...`. All evaluate against `undefined` → those FP-suppression guards are dead.
  - `shared.js:260` (`collective` check): `tHbm` is referenced in the final clauses of line 260 (`... t.cv > 0.04 && tHbm && !tHbm.insufficient ...`) before `var tHbm = tb ? tb.get('hbm_spill') : null;` at line 262 → guard dead (short-circuits on `undefined`).
- **Problem:** These guards were appended by the self-improving tuning loop and reference hoisted-but-unassigned `var`s. They don't throw (short-circuit on falsy), but the tuned false-positive suppressions they encode silently never run, so the detectors fire more aggressively than the tuned intent.
- **Remediation:** Hoist the variable definitions above first use in each check (or de-duplicate the repeated ratio computations at the top of each function). Add `'use strict'`-compatible lint (e.g. `no-use-before-define`) over `shared.js` to catch this class going forward; the empty-catch (M2) currently hides any future instance.

#### M2. Empty `catch(e) {}` in `shared.js` `evaluateSignals` masks all detector errors

- **File:** `shared.js:702-703`, `707-708`
- **Problem:** Every rollback/extend check runs inside `try { ... } catch(e) {}`. This is what allowed H1 to go unnoticed: any TypeError in a detector silently converts to "did not fire". For a deploy-gating engine, a crashed detector being indistinguishable from a clean signal is a fail-open behavior.
- **Remediation:** At minimum log the error (`console.error`) with detector id; better, surface a `detector_error` entry in the health result/audit record so replay can distinguish "clean" from "errored". The engine path (`engine/gates/health.ts:89-106`) deliberately runs without try/catch — aligning shared.js with that posture (fail loud) is also acceptable.

#### M3. `effectiveThreshold` applies the trend discount as `trendDiscount × strength²` (likely refactor slip)

- **File:** `engine/core.ts:171-172` (mirrored in committed bundle `engine/index.browser.js:522-523`)
- **Problem:**
  ```ts
  const discount = trendDiscount * strength;
  return baseThreshold - discount * strength;
  ```
  `discount` already includes `strength`; multiplying by `strength` again means the effective discount is `trendDiscount × strength²`. The doc comment ("Applies trend discount to base threshold") and the variable naming suggest the intended formula is `baseThreshold - trendDiscount * strength`. With `strength ∈ [0,1]`, squaring systematically weakens the trend discount (e.g. at strength 0.5 the discount is half the apparently-intended value), making every ratio detector that uses `effectiveThreshold` (p99, ttft, compound_lat, tok_econ, tokens, cost, downstream, behavioral — both in `shared.js` and `engine/gates/_health-defs.ts`) slightly less sensitive to trending regressions.
- **Caveat:** Behavior is long-standing (present since the initial import commit) and the current threshold tunings were calibrated against it, so a "fix" changes fire behavior and will require re-validating the adversarial sweeps.
- **Remediation:** Confirm intent with the architect notes; either change to `baseThreshold - discount` and re-run the adversarial/parity suites, or keep the math and fix the variable naming + comment (`discount` → `discountPerStrength`, document the quadratic ramp as intentional).

#### M4. `npm run loop` references a script that does not exist

- **File:** `package.json:16` — `"loop": "bash run_loop.sh"` → `run_loop.sh` is absent from the repo (verified: `ls run_loop.sh` → No such file). `ARCHITECTURE.md:99` likewise documents "The tuning harness (`loop.js`)" and `scenario_results.json` (ARCHITECTURE.md:138), neither of which exists in the repo.
- **Problem:** `npm run loop` fails immediately; ARCHITECTURE.md describes a tuning-harness surface that was not imported into the public repo (the import commit is a "curated reference subset").
- **Remediation:** Remove the `loop` script from `package.json`, and update ARCHITECTURE.md §"The tuning harness" to state the loop harness is not included in the public subset (or import it).

#### M5. npm packaging is broken: `files` omits `dist/`, which `shared.js` requires at runtime

- **File:** `package.json:18-25` (`files: ["engine/", "tools/", "shared.js", ...]`), `shared.js:18-21` (`require('./dist/engine/core')` etc.)
- **Problem:** If this package were installed (it is `"private": false` with a `files` allow-list and no `prepare` script), `shared.js` would throw `MODULE_NOT_FOUND` because `dist/` is excluded and never built on install. There is also no `main`/`exports` entry point.
- **Remediation:** Either mark the package `"private": true` (it is a reference repo; README says "not packaged for production deployment"), or add `dist/` + a `prepare: tsc` script and a `main` field.

#### M6. `engines: ">=20"` is inconsistent with the test suite's actual Node requirement (≥ 23.6)

- **Files:** `package.json:7-9`; `.github/workflows/test.yml` (comment: "need 23.6+ for native .ts execution"); e.g. `test/cell-matrix-2d.test.ts:29` and 4+ other tests `execSync('node tools/gen-synthetic-baseline.ts ...')`.
- **Problem:** Several tests spawn `.ts` files directly as Node subprocesses, which throws `ERR_UNKNOWN_FILE_EXTENSION` on Node 20/22. A contributor on Node 20 (satisfying `engines`) gets opaque test failures. CI pins Node 24 and documents this, but `package.json` does not.
- **Remediation:** Bump `engines.node` to `>=23.6` (or `>=24`), or change the spawning tests to invoke the compiled `tools/gen-synthetic-baseline.js`.

### Low

#### L1. `tools/claude-proxy.js` binds all interfaces with wildcard CORS while holding an API key

- **File:** `tools/claude-proxy.js:150` (`server.listen(PORT)` → binds `0.0.0.0`), `:65-70` (CORS `access-control-allow-origin: *`).
- **Problem:** Anyone on the local network can POST to `:8787/situation` and relay arbitrary prompts through your `ANTHROPIC_API_KEY` (key itself is not exposed, but its spend is). It is a dev-only demo tool, but the header comment says "any localhost origin".
- **Remediation:** `server.listen(PORT, '127.0.0.1', ...)`.

#### L2. Audit writer: flush timer keeps the process alive; midnight-spanning records land in the wrong day-file

- **File:** `engine/_audit-writer.ts:44` (`setInterval(flush, 500)` — never `unref()`d), `:54-66` (records buffered before a UTC date change are appended to the *new* date's file).
- **Problem:** A CLI/tool that creates a writer and forgets `close()` will hang at exit. Daily-rotation attribution is off by up to one flush interval at midnight (cosmetic for a 500 ms buffer, but the record's `ts` and its file can disagree).
- **Remediation:** `flushTimer.unref?.()` after creation; in `flush()`, write to the file matching the previous `currentDate` before switching.

#### L3. CI: tests run only on `pull_request`; no test run on push to `main`

- **File:** `.github/workflows/test.yml:8-9` (`on: pull_request` only); `.github/workflows/security.yml` pushes only on `ws*` branches.
- **Problem:** Direct pushes / merge commits to the default branch get no test run; a broken merge would go undetected until the next PR.
- **Remediation:** Add `push: branches: [main]` to `test.yml` `on:`.

#### L4. `package-lock.json` hygiene: stale extraneous local-path entry + `git+ssh` resolved URL

- **File:** `package-lock.json` — `"../tessera/engine"` entry marked `"extraneous": true` (residue of a local `file:` link to the sibling Tessera workspace), and the engine dep resolved as `git+ssh://git@github.com/...`.
- **Problem:** The extraneous entry is dead weight and leaks local workspace layout; the `git+ssh` resolution can break `npm ci` in environments where npm falls back to a real ssh clone without GitHub credentials (works today via the codeload tarball fallback — `npm ci` succeeded in this review).
- **Remediation:** Regenerate the lockfile from a clean clone (`rm -rf node_modules package-lock.json && npm install`) so the entry disappears and resolution records the https tarball.

#### L5. Stale internal references in shipped docs

- **Files:** `CHEAT-SHEET.md:135` → `coordination/DIAGNOSTIC-V1-H1-GREP-2026-04-26.md` (no `coordination/` dir in the repo; `NORTH-STAR-ARCHITECTURE.md` references `coordination/` 5 more times); `CHEAT-SHEET.md:78` → `runs/validation-reports/report-card-v1.json` (path is gitignored and absent).
- **Problem:** Public-repo readers hit dead references; these survived the PR #28 "internal-doc cleanup".
- **Remediation:** Remove or footnote the coordination-doc citations as internal-only; note that `report-card-v1.json` is a generated artifact (`node tools/build-report-card.js`).

#### L6. Known-failing TODO tests (documented, included for completeness)

- **File:** `test/canned-demo-right-reasons.test.ts:651,660` — §C1 (`adv_slowbleed` fires via Family A, expected B) and §C2 (`adv_mfu_drop_no_lat_corr` fires via Family A, expected C) fail under `todo` annotation ("architect-scope: inline scenarios lack cell_patch").
- **Problem:** Portfolio-mode rollback on the inline adversarials is driven by the cell-mismatch CUSUM rather than the intended detector family. Not a regression — tracked and annotated — but it is a live right-reasons gap.
- **Remediation:** Land the architect-scope `cell_patch` fix for inline scenarios; §C3's lock test (`:702`) is already in place to flag when it lands.

#### L7. `TopologyEnricher` minor contract gaps

- **File:** `engine/topology-overlay.ts:213` — `this.source.fetchSnapshot()` is called without a `FetchContext`, so abort signals can never propagate despite the interface supporting them; `:327-340` — the docstring says events outside `[window_start - corrWindow, window_end + corrWindow]` return 0, but interval events use pure IoU with no corrWindow buffer (only point events get the buffer).
- **Remediation:** Thread an optional `AbortSignal` through `enrich()`; align the docstring (or the math) for interval events.

### Found during remediation (2026-06-10)

#### R1. Browser bundle was unregenerable: builder mishandled named re-export barrels

- **File:** `tools/build-browser-bundle.js` (no handling for `export { A } from './x'`), `engine/index.browser.js`, `demos/demo.html`.
- **Problem:** The PR #31 god-file decomposition split modules into `_`-prefixed implementation files re-exported via `export { X } from './_x'` barrels. The bundler handled `export * from` and bare `export { }` but not named re-exports: it neither recorded the dependency edge nor stripped the line, so regenerating produced a syntactically invalid bundle (raw `export` inside an IIFE → "Unexpected token 'export'"). The committed bundle had been stale since #31; `node tools/build-browser-bundle.js --check` failed on a pristine clone.
- **Fix:** Named re-exports now contribute a topo-sort dependency edge and are stripped + re-published via `__NS__.<exported> = __NS__.<source>` in the module epilogue. Bundle and demos/demo.html regenerated; browser-parity, bundle-syntax, and Q74 tests pass.

---

## Prioritized remediation checklist

- [x] **H1** Fix `shared.js` `gpu_eff` use-before-declaration (move `var tm` above the warmup guard); add a no-throw regression test over all `ROLLBACK_DEFS`/`EXTEND_DEFS` checks. (`shared.js:285-286`)
- [x] **M2** Replace empty `catch(e) {}` in `evaluateSignals` with logged/audited detector-error surfacing. (`shared.js:702-708`)
- [x] **M1** Fix the remaining hoisted-var dead guards (`tr` at `shared.js:132`; `p99R`/`_tp99Tok`/`tickEstTok` at `:210`; `tHbm` at `:260`); add `no-use-before-define` linting for `shared.js`. *(Also fixed `_hbmRp99` at `:132`, found by the new lint test; lint implemented as `test/shared-no-use-before-define.test.ts` using the TypeScript parser — no new dependencies.)*
- [x] **M3** Resolve `effectiveThreshold` strength² question: confirm intent, then either fix to `baseThreshold - discount` + re-run adversarial sweeps, or rename/document the quadratic ramp. (`engine/core.ts:171-172`) *(Fixed to apply strength exactly once — matches the intended fix for the same bug in the sibling deploysignal-engine repo; replay/parity/canned-demo suites re-run clean.)*
- [x] **M4** Remove the broken `npm run loop` script; correct ARCHITECTURE.md's `loop.js` / `scenario_results.json` sections. (`package.json:16`, `ARCHITECTURE.md:99,138`)
- [x] **M5** Mark package `private: true` or ship `dist/` (+ `prepare` build, `main` field). (`package.json`) *(Marked `private: true` — README states it is a reference implementation, not packaged for production.)*
- [x] **M6** Raise `engines.node` to match the real test requirement (≥23.6 / 24), or spawn compiled `.js` in tests. (`package.json:7-9`) *(engines.node → `>=23.6`, matching the CI comment and native-.ts test subprocesses.)*
- [x] **L1** Bind `claude-proxy.js` to `127.0.0.1`. (`tools/claude-proxy.js:150`) *(Verified empirically: loopback connects, LAN interface refused.)*
- [x] **L2** `unref()` the audit-writer flush timer; fix midnight-rotation file attribution. (`engine/_audit-writer.ts:44,54-66`) *(Records now date-stamped at write() time and flushed grouped per day-file.)*
- [x] **L3** Add `push: branches: [main]` trigger to the test workflow. (`.github/workflows/test.yml`)
- [ ] **L4** Regenerate `package-lock.json` from a clean clone (drops the extraneous `../tessera/engine` entry and the `git+ssh` resolution).
- [ ] **L5** Clean up dead `coordination/` and `runs/validation-reports/` references in CHEAT-SHEET.md / NORTH-STAR-ARCHITECTURE.md.
- [ ] **L6** Track the §C1/§C2 right-reasons TODO tests to closure (architect-scope `cell_patch`).
- [ ] **L7** Thread abort signal through `TopologyEnricher.enrich`; align interval-event overlap docstring. (`engine/topology-overlay.ts:213,327-340`)

---

## Test-suite results (this review)

```
npm ci          → OK (Node 25.x local)
npm run build   → OK (tsc, no errors)
tsc -p tsconfig.test.json → OK
node --test test/*.test.js:
  tests 988 | pass 980 | fail 0 | skipped 2 | todo 6 | duration ~223s | exit 0
  (2 todo tests fail-as-expected: right-reasons §C1/§C2 — known architect-scope gap)
```
