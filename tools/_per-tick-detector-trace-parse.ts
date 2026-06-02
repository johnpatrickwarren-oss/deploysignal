// tools/_per-tick-detector-trace-parse.ts — Q63 SPEC-3 implementation.
//
// Tick/detector spec parsing + scenario/config loading helpers.
// Extracted verbatim from tools/per-tick-detector-trace.ts during a
// mechanical god-file split (no behavior change).

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ALL_DETECTORS } from './_per-tick-detector-trace-types.js';
import type { DetectorFamily, DemoScenario } from './_per-tick-detector-trace-types.js';

export function parseTicks(spec: string, totalTicks: number): number[] {
  if (spec === 'all') {
    return Array.from({ length: totalTicks }, (_, i) => i);
  }
  if (spec.includes(':')) {
    const [a, b] = spec.split(':').map((x) => parseInt(x, 10));
    if (Number.isNaN(a) || Number.isNaN(b) || a < 0 || b < a) {
      throw new Error(`--ticks 'N:M' invalid range: ${spec}`);
    }
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  if (spec.includes(',')) {
    return spec.split(',').map((x) => parseInt(x.trim(), 10)).filter((x) => !Number.isNaN(x));
  }
  const n = parseInt(spec, 10);
  if (Number.isNaN(n)) throw new Error(`--ticks invalid: ${spec}`);
  return [n];
}

export function parseDetectors(spec: string): DetectorFamily[] {
  if (spec === 'all') return [...ALL_DETECTORS];
  const parts = spec.split(',').map((x) => x.trim()) as DetectorFamily[];
  for (const p of parts) {
    if (!ALL_DETECTORS.includes(p)) {
      throw new Error(`--detectors unknown family: ${p}. Valid: ${ALL_DETECTORS.join(', ')}`);
    }
  }
  return parts;
}

function resolveScenarioPath(scenario: string): string {
  if (scenario.endsWith('.json') && fs.existsSync(scenario)) return scenario;
  const demoPath = path.join('demos', 'scripts', `${scenario}.json`);
  if (fs.existsSync(demoPath)) return demoPath;
  throw new Error(`Scenario not found: ${scenario}. Looked at ${demoPath} and direct path.`);
}

export function loadDemoScenario(scenarioArg: string): DemoScenario {
  const p = resolveScenarioPath(scenarioArg);
  const demo = JSON.parse(fs.readFileSync(p, 'utf8')) as DemoScenario;
  // Resolve baseline_ref relative to demos/ if present + baseline absent.
  if (!demo.baseline && demo.baseline_ref) {
    const refPath = path.join('demos', demo.baseline_ref);
    if (fs.existsSync(refPath)) {
      const refDoc = JSON.parse(fs.readFileSync(refPath, 'utf8')) as { baseline?: Record<string, number> };
      demo.baseline = refDoc.baseline ?? {};
    }
  }
  return demo;
}

export function loadCompiledConfig(substratePath: string): unknown {
  return JSON.parse(fs.readFileSync(substratePath, 'utf8'));
}
