"use strict";
// tools/_build-report-card-io.js — CLI parsing, deterministic RNG,
// baseline loading, and compiled-config resolution for the report-card
// builder. Split VERBATIM out of build-report-card.js (no behavior change).
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("node:fs");
const path = require("node:path");
const node_child_process_1 = require("node:child_process");

function parseArgs(argv) {
    const out = {
        baseline: 'runs/baselines/synthetic-v1',
        profiles: 'regression-profiles/',
        compiled: 'runs/compiled-configs/v5-sequential-e-process.json',
        out: 'runs/validation-reports/report-card-v1.json',
        canaryTicks: 100,
        injectionTick: 30,
        healthyWindows: 131,
        seed: 42,
        bakeHours: 6,
        // Q3 (REPLY-52gf §38-99): healthy-window resampling mode.
        // 'iid_bootstrap' (default; backward-compatible) — resample
        // rows from cell-empirical distribution. 'parametric_gaussian'
        // — draw N(μ_calibration, σ²_calibration) per signal per tick;
        // tests whether the betting-e-process is Ville-clean given a
        // genuinely-symmetric null (architect Q3 hypothesis).
        resampler: 'iid_bootstrap',
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const v = argv[i + 1];
        switch (k) {
            case '--baseline':
                out.baseline = v;
                i++;
                break;
            case '--profiles':
                out.profiles = v;
                i++;
                break;
            case '--compiled':
                out.compiled = v;
                i++;
                break;
            case '--out':
                out.out = v;
                i++;
                break;
            case '--canary-ticks':
                out.canaryTicks = parseInt(v, 10);
                i++;
                break;
            case '--injection-tick':
                out.injectionTick = parseInt(v, 10);
                i++;
                break;
            case '--healthy-windows':
                out.healthyWindows = parseInt(v, 10);
                i++;
                break;
            case '--seed':
                out.seed = parseInt(v, 10);
                i++;
                break;
            case '--bake-hours':
                out.bakeHours = parseFloat(v);
                i++;
                break;
            case '--resampler':
                if (v !== 'iid_bootstrap' && v !== 'parametric_gaussian') {
                    throw new Error(`--resampler must be 'iid_bootstrap' or 'parametric_gaussian'; got ${v}`);
                }
                out.resampler = v;
                i++;
                break;
        }
    }
    return out;
}
// ── Deterministic RNG ──────────────────────────────────────────────
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function loadBaseline(dir) {
    const manifestPath = path.join(dir, 'manifest.json');
    const bundlePath = path.join(dir, 'bundle.jsonl');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`baseline manifest missing: ${manifestPath}`);
    }
    if (!fs.existsSync(bundlePath)) {
        throw new Error(`baseline bundle missing: ${bundlePath}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const runs = fs
        .readFileSync(bundlePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    // Per-signal mean across all runs × ticks. Used as the Scenario.baseline
    // reference so the gate's absolute-threshold legs see the expected scale.
    const signalMeans = {};
    for (const s of manifest.signals) {
        let sum = 0, n = 0;
        for (const run of runs) {
            const series = run.signal_series[s];
            if (!series)
                continue;
            for (const v of series) {
                sum += v;
                n++;
            }
        }
        signalMeans[s] = n > 0 ? sum / n : 0;
    }
    return { manifest, runs, signalMeans };
}
// ── Compiled-config resolution ─────────────────────────────────────
function ensureCompiledConfig(baselineDir, compiledPath, repoRoot) {
    let resolvedPath = compiledPath;
    if (!resolvedPath)
        resolvedPath = path.join(repoRoot, 'runs', 'compiled-configs', 'v5-sequential-e-process.json');
    if (!fs.existsSync(resolvedPath)) {
        console.log(`[build-report-card] compiled config missing at ${resolvedPath}; regenerating...`);
        (0, node_child_process_1.execSync)(`node tools/calibrate.ts --baseline ${baselineDir} --alpha 1e-3 --families A,B,C,D,E --out ${resolvedPath}`, { cwd: repoRoot, stdio: 'inherit' });
    }
    const cfg = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    return { cfg, path: resolvedPath };
}

module.exports = {
    parseArgs,
    mulberry32,
    loadBaseline,
    ensureCompiledConfig,
};
