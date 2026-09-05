// check_report.mjs — pins REPORT.md to the run JSON by re-rendering and diffing (exit 1 on drift), then
// checks any `--expect <file>` of `selector = value` lines. Selectors: E1.field (dotted into
// endpoints.json), cells[arm,variant,alpha].field, manifest.field.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { render } from './report.mjs';
const runDir = resolve(process.argv[2]);
const committed = readFileSync(join(runDir, 'REPORT.md'), 'utf8');
const fresh = render(runDir);
let failures = 0;
if (committed !== fresh) { failures++; const a = committed.split('\n'), b = fresh.split('\n'); for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { console.error(`REPORT.md drift at line ${i + 1}:\n  committed: ${a[i]}\n  fresh:     ${b[i]}`); break; } }
const J = (n) => JSON.parse(readFileSync(join(runDir, n), 'utf8'));
const manifest = J('manifest.json');
if (manifest.exceptions !== 0) { console.error(`manifest records ${manifest.exceptions} exceptions`); failures++; }
const ei = process.argv.indexOf('--expect');
if (ei > 0) {
  const D = { ...J('endpoints.json'), cells: J('cells.json'), manifest };
  for (const raw of readFileSync(process.argv[ei + 1], 'utf8').split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); const lhs = line.slice(0, eq).trim(), expected = line.slice(eq + 1).trim();
    let got;
    const sel = /^cells\[([^\]]+)\]\.(\w+)$/.exec(lhs);
    if (sel) {
      const k = sel[1].split(',').map((s) => s.trim());
      const hit = D.cells.filter((c) => c.arm === k[0] && c.variant === k[1] && String(c.alpha) === k[2]);
      if (hit.length !== 1) { console.error(`selector ${lhs} matched ${hit.length}`); failures++; continue; }
      got = hit[0][sel[2]];
    } else got = lhs.split('.').reduce((o, kk) => (o == null ? undefined : o[kk]), D);
    const ok = typeof got === 'number' && !Number.isNaN(Number(expected)) ? Math.abs(got - Number(expected)) <= 0.5 * 10 ** -(expected.split('.')[1]?.length ?? 0) : String(got) === expected;
    if (!ok) { console.error(`expect ${lhs} = ${expected}, got ${got}`); failures++; }
  }
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('check_report: REPORT.md matches the run JSON' + (ei > 0 ? '; all expectations hold' : ''));
