// posthoc_scale.mjs — POST-HOC, no verdict. Diagnoses the ceiling the two UI arms show on the
// K1 grid (universal_inference ≈ 0.61, sequential_ui ≈ 0.50 from 2σ up while safe_t reads 1.000):
// per-signal detection on the registered trajectories (same seeds), the same arms on the
// standardized series (x − μ̂)/σ̂, and the null-cell terminal e-value means as an instrument check.
// Usage: node studies/valid-path-power/analysis/posthoc_scale.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const require_ = createRequire(import.meta.url);
const ENG = join(REPO, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'dist', 'detectors');
const safeT = require_(join(ENG, 'safe-t-e-value.js'));
const ui = require_(join(ENG, 'universal-inference-e-value.js'));
const sui = require_(join(ENG, 'sequential-ui.js'));
const ALPHA = (4e-4 / 6) * 0.5, CALIB = 500, T_TOTAL = 100, T_INJECT = 30;
const SIGNALS = { p99_latency: 0.008, ttft: 0.008, cost_req: 0.006, downstream_err: 0.03 };
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function fnv1a(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function meanSigma(v) { let sum = 0; for (const x of v) sum += x; const mean = sum / v.length; let sq = 0; for (const x of v) { const d = x - mean; sq += d * d; } return { mean, sigma: Math.sqrt(sq / v.length) }; }
const scenarios = JSON.parse(readFileSync(join(REPO, 'runs', 'adversarial-scenarios.json')));
const cal = { start: 0, len: CALIB }, test = { start: CALIB, len: T_TOTAL };
const thr = Math.log(1 / ALPHA);
const seqFire = (series) => { const r = sui.sequentialUiMeanShiftEProcess(series, { changeFrom: CALIB }); for (let t = 0; t < T_TOTAL; t++) if (r.logE[CALIB + t - 1] >= thr) return true; return false; };

const scales = {}; for (const sig of Object.keys(SIGNALS)) scales[sig] = [];
const out = {};
const nullE = { safe_t: [], universal_inference: [] };
for (const sev of ['none', '3sigma', '1.5sigma']) {
  const delta = sev === 'none' ? 0 : parseFloat(sev);
  const cls = sev === 'none' ? 'null' : 'K1';
  for (const sc of scenarios) for (const [sig, c] of Object.entries(SIGNALS)) {
    const base = sc.baseline?.[sig]; if (typeof base !== 'number' || base <= 0) continue;
    const rng = mulberry32(fnv1a(`${sc.id}|${sig}|${cls}|${sev}`));
    const healthy = () => base * (1 + c * rng());
    const calib = Array.from({ length: CALIB }, healthy);
    const { mean: mu, sigma } = meanSigma(calib);
    if (sev === 'none') scales[sig].push(sigma);
    const traj = Array.from({ length: T_TOTAL }, healthy).map((v, t) => (t >= T_INJECT ? v + delta * sigma : v));
    const raw = calib.concat(traj);
    const std = raw.map((x) => (x - mu) / sigma);
    const k = (arm, kind) => `${sev}|${sig}|${arm}|${kind}`;
    const add = (key, fired) => { out[key] = out[key] || { n: 0, d: 0 }; out[key].n++; if (fired) out[key].d++; };
    const eUiRaw = ui.universalInferenceMeanShiftEValue(raw, cal, test);
    const eUiStd = ui.universalInferenceMeanShiftEValue(std, cal, test);
    const eSt = safeT.safeTwoSampleTEValue(raw, cal, test, { ar1Phi: 0 });
    add(k('universal_inference', 'raw'), eUiRaw >= 1 / ALPHA);
    add(k('universal_inference', 'std'), eUiStd >= 1 / ALPHA);
    add(k('sequential_ui', 'raw'), seqFire(raw));
    add(k('sequential_ui', 'std'), seqFire(std));
    add(k('safe_t', 'raw'), eSt >= 1 / ALPHA);
    if (sev === 'none') { nullE.safe_t.push(eSt); nullE.universal_inference.push(eUiRaw); }
  }
}
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log('calibration σ̂ per signal (median, min, max):');
for (const [sig, xs] of Object.entries(scales)) console.log(`  ${sig.padEnd(15)} ${q(xs, 0.5).toExponential(2)} ${Math.min(...xs).toExponential(2)} ${Math.max(...xs).toExponential(2)}`);
console.log('per-signal detection (raw vs standardized input):');
for (const sev of ['3sigma', '1.5sigma']) for (const arm of ['safe_t', 'universal_inference', 'sequential_ui']) for (const sig of Object.keys(SIGNALS)) {
  const r = out[`${sev}|${sig}|${arm}|raw`], s = out[`${sev}|${sig}|${arm}|std`];
  console.log(`  ${sev.padEnd(9)} ${arm.padEnd(20)} ${sig.padEnd(15)} raw=${(r.d / r.n).toFixed(3)}` + (s ? ` std=${(s.d / s.n).toFixed(3)}` : '') + ` n=${r.n}`);
}
console.log('null-cell terminal e (instrument check; E[e|H0] ≤ 1 expected):');
for (const [arm, xs] of Object.entries(nullE)) { const m = xs.reduce((a, b) => a + b, 0) / xs.length; console.log(`  ${arm.padEnd(20)} n=${xs.length} mean=${m.toFixed(4)} median=${q(xs, 0.5).toFixed(4)} p99=${q(xs, 0.99).toFixed(3)} max=${Math.max(...xs).toFixed(3)}`); }
