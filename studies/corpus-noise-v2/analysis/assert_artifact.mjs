// assert_artifact.mjs — named, single-claim assertions over the shipped artifact.
//
// Exists so the wiki's `checks:` entries can each verify one claim without nested
// shell quoting (knowledge/tools/check-pages.py strips outer quotes only and does
// not process YAML escapes, so `node -e "..."` inside a check cannot survive).
//
//   node studies/corpus-noise-v2/analysis/assert_artifact.mjs <name>
//
// Exit 0 = the claim holds. Exit 1 = it does not, with what changed on stderr.
// Exit 2 = unknown assertion name.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const A = JSON.parse(readFileSync(join(ROOT, 'engine/scenarios/corpus-noise-model.json'), 'utf8'));
const slowBurn = () => readFileSync(join(ROOT, 'engine/scenarios/slow_burn.ts'), 'utf8');
const loader = () => readFileSync(join(ROOT, 'engine/scenarios/corpus-noise-model.ts'), 'utf8');

const ASSERTIONS = {
  'one-sourced-marginal': () => {
    const n = Object.values(A.signals).filter((s) => s.marginal.status === 'sourced').length;
    return n === 1 || `expected exactly 1 signal with a sourced marginal, found ${n}`;
  },
  'sourced-signal-is-cost-req': () => {
    const s = A.signals.cost_req?.marginal?.status;
    return s === 'sourced' || `cost_req.marginal.status is '${s}', not 'sourced'`;
  },
  'no-phi-published': () => {
    const s = A.signals.cost_req?.serial;
    if (s?.status === 'sourced') return 'cost_req.serial is now sourced — a phi is being published';
    if (s?.phi !== undefined) return `cost_req.serial carries a phi field (${s.phi})`;
    return true;
  },
  'ar1-rejected': () => {
    const s = A.signals.cost_req?.serial;
    return s?.status === 'ar1_inadequate' || `cost_req.serial.status is '${s?.status}', not 'ar1_inadequate'`;
  },
  'six-family-a-signals': () => {
    const n = Object.keys(A.signals).length;
    return n === 6 || `artifact carries ${n} signals, expected 6`;
  },
  'incumbent-untouched': () => {
    const src = slowBurn();
    const hits = ['p99_latency: 1 + 0.008 * Math.random()', 'ttft:        1 + 0.008 * Math.random()']
      .filter((h) => !src.includes(h));
    return hits.length === 0 || `slow_burn.ts no longer contains: ${hits.join(' | ')}`;
  },
  'incumbent-constants-recorded': () => {
    const c = A.incumbent_model?.c;
    return (c && c.cost_req === 0.006 && c.p99_latency === 0.008 && c.downstream_err === 0.03)
      || `artifact's record of the incumbent constants changed: ${JSON.stringify(c)}`;
  },
  'loader-refuses-defaults': () => {
    const src = loader();
    return src.includes('Do not substitute a default')
      || 'the loader no longer refuses to supply a default for an unsourced signal';
  },
  'eval-score-unsourceable': () => {
    const m = A.signals.eval_score?.marginal;
    return m?.criterion === 'A2' || `eval_score.marginal criterion is '${m?.criterion}', not 'A2'`;
  },
  'four-signals-have-no-source': () => {
    const a1 = ['p99_latency', 'ttft', 'downstream_err', 'tool_success_rate']
      .filter((s) => A.signals[s]?.marginal?.criterion === 'A1');
    return a1.length === 4 || `expected 4 A1 signals, found ${a1.length}: ${a1.join(',')}`;
  },
  'cv-ratio-439': () => {
    const m = A.signals.cost_req.marginal;
    const ratio = Math.round(m.cv / m.incumbent_cv);
    return ratio === 439 || `cv ratio is ${ratio}, not 439`;
  },
};

const name = process.argv[2];
if (!name || !(name in ASSERTIONS)) {
  console.error(`unknown assertion '${name}'. Known: ${Object.keys(ASSERTIONS).join(', ')}`);
  process.exit(2);
}
const result = ASSERTIONS[name]();
if (result === true) process.exit(0);
console.error(`FAIL ${name}: ${result}`);
process.exit(1);
