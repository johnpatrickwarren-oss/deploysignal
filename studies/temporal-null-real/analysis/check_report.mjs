// analysis/check_report.mjs — pins REPORT.md to results/run-20261003T053942Z and the engine's Family D signal list. Exit 1 on drift.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..'); const ROOT = join(STUDY, '..', '..');
const RUN = 'run-20261003T053942Z';
const require = createRequire(import.meta.url);
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
const E = JSON.parse(readFileSync(join(STUDY, 'results', RUN, 'endpoints.json'), 'utf8'));
const M = JSON.parse(readFileSync(join(STUDY, 'results', RUN, 'manifest.json'), 'utf8'));
const S = JSON.parse(readFileSync(join(STUDY, 'results', RUN, 'sessions.json'), 'utf8'));
let failed = 0; const check = (n, ok) => { if (!ok) { console.error(`FAIL ${n}`); failed++; } };
check('run pinned', report.includes(RUN) && M.repo_sha.startsWith('89cf866') && M.engine_version === '0.13.0-pre' && M.compiled_sha256.startsWith('12b4729944e2') && report.includes('`12b4729944e2'));
check('100 sessions, all executable, no voids or failures', E.sessions === 100 && E.executable === 100 && E.void.length === 0 && E.harness_failures === 0 && E.not_executable === false && S.length === 100 && S.every((s) => s.executable && s.failures === 0));
check('E1 0/100 PASS, upper 0.030', E.E1.rollback_sessions === 0 && E.E1.N === 100 && E.E1.verdict === 'PASS' && Math.abs(E.E1.upper95 - 0.0295) < 1e-3 && report.includes('upper bound 0.030'));
check('E2 A 0 PASS', E.E2.A.sessions_with_rollback_fire === 0 && E.E2.A.verdict === 'PASS' && E.E2.A.alpha_share === 0.0004);
check('no rollback-class fire from any family', Object.keys(E.E3.fire_ids).length === 0 && S.every((s) => Object.keys(s.rollback_ids).length === 0) && E.E3.concordance_two_or_more_families === 0);
check('regimes 19/63/18, restart 4, all 0', E.E3.by_regime.full.sessions === 19 && E.E3.by_regime.half.sessions === 63 && E.E3.by_regime.mixed.sessions === 18 && [E.E3.by_regime.full, E.E3.by_regime.half, E.E3.by_regime.mixed].every((g) => g.rollbacks === 0 && g.any_rollback_fire === 0) && E.E3.restart_sessions.sessions === 4 && E.E3.restart_sessions.rollbacks === 0 && report.includes('full 0/19, half 0/63, mixed 0/18'));
check('E4 low_traffic 81, all proceed', E.E4.extend_sessions === 0 && E.E4.proceed_sessions === 100 && E.E4.hold_ids.low_traffic === 81 && Object.keys(E.E4.hold_ids).length === 1 && E.E2.B_holds === 81 && report.includes('`low_traffic` in 81 sessions'));
check('compiled: A two signals, C/E none, D attached', E.compiled.family_A_signals.join() === 'p99_latency,downstream_err' && E.compiled.family_C === false && E.compiled.family_E === false && E.compiled.family_D === true && E.compiled.confidence.strict === 68 && E.compiled.confidence.pooled === 2 && E.compiled.confidence.none === 770 && report.includes('68 strict cells, 2 pooled, 770 none'));
// Family D not exercised: the runtime signal list is kv_cache only
let dsig = null; try { dsig = require('@johnpatrickwarren-oss/deploysignal-engine/detectors/spectral').FAMILY_D_SIGNALS; } catch (e) { try { dsig = require(join(ROOT, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'dist', 'detectors', 'spectral.js')).FAMILY_D_SIGNALS; } catch (e2) { dsig = null; } }
check('FAMILY_D_SIGNALS is [kv_cache] at the pin', Array.isArray(dsig) && dsig.length === 1 && dsig[0] === 'kv_cache' && report.includes("`['kv_cache']`"));
check('raw series present, no account id', [0, 1, 2, 3].every((l) => existsSync(join(STUDY, 'results', 'raw', `lane${l}.json`)) && !readFileSync(join(STUDY, 'results', 'raw', `lane${l}.json`), 'utf8').includes('556890483612')));
for (const q of ['That was wrong when written.', '40 of 44', '13 of 87', 'a third substrate, not the first', '0 rollbacks and 0 rollback-class fires', 'P1 said E1 FAILS with 3–15 rollbacks', '**Wrong.** 0.', 'Family D was not exercised', 'p99 ×1.05 (3.8 ms, one δ_min) at tick 17', 'cannot confirm one as small as the 0.0004 budget']) check(`quotes ${q}`, report.includes(q));
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('check_report: all checks passed');
