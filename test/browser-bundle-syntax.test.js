'use strict';
// test/browser-bundle-syntax.test.js — Regression guard for module-scope
// identifier collisions in engine/index.browser.js.
//
// Background: the bundler concatenates many TS modules into one inline
// <script> in demos/demo.html. Without per-module scope isolation, a
// `let _state` (engine/gates/state.ts) collides with the demo template's
// own `var _state` and the page fails to load with:
//   "SyntaxError: Cannot declare a var variable that shadows a
//    let/const/class variable: '_state'."
//
// Bundle-level Node `import()` masks this — the bundle as an ES module
// is fine in isolation. The bug only surfaces when the bundle is inlined
// alongside consumer-scope vars, which is exactly what build-demo.js does.
//
// This test parses the *generated* demos/demo.html inline script with
// V8's parser (vm.Script does parse-only, no execution). That catches
// the exact failure mode users see in Chrome/Safari, without needing a
// headless-browser dep (the project thesis is "no new runtime deps").
//
// Probe set: identifiers known to live in the demo template's outer
// scope. Any future engine-side top-level declaration that shadows one
// of these names will trip this test.
//
// Usage: node test/browser-bundle-syntax.test.js

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT       = path.join(__dirname, '..');
const BUNDLE     = path.join(ROOT, 'engine', 'index.browser.js');
const DEMO_HTML  = path.join(ROOT, 'demos', 'demo.html');

let failures = 0;
let passed   = 0;

function check(name, fn) {
  process.stdout.write(name.padEnd(60));
  try {
    fn();
    console.log('PASS');
    passed++;
  } catch (e) {
    console.log('FAIL\n    ' + (e.message || e));
    failures++;
  }
}

// ── 1. Bundle alone parses cleanly ───────────────────────────────────
check('bundle: engine/index.browser.js parses', function () {
  const src = fs.readFileSync(BUNDLE, 'utf8');
  // Drop the trailing `export {...}` block — vm.Script doesn't accept
  // top-level `export` (that's an ES-module-only keyword). Mirrors
  // build-demo.js's strip step so we test the same body that gets
  // inlined into the page.
  const exportIdx = src.indexOf('\nexport {');
  if (exportIdx === -1) throw new Error('bundle missing "export {" block');
  const inlinable = src.slice(0, exportIdx);
  new vm.Script(inlinable, { filename: 'engine/index.browser.js' });
});

// ── 2. Bundle + demo-template-style consumer vars must not collide ───
// Identifiers below are real top-level declarations in
// demos/demo.template.html. If the bundler reintroduces a top-level
// `let/const/class` for any of these names, V8 will throw a SyntaxError
// the moment the page loads.
const CONSUMER_GLOBALS = [
  '_state', 'ALPHA_FAMILY_WEIGHTS', 'DEMO_SCENARIOS',
];

check('bundle: no top-level shadow of consumer-page vars', function () {
  const src = fs.readFileSync(BUNDLE, 'utf8');
  const exportIdx = src.indexOf('\nexport {');
  const inlinable = src.slice(0, exportIdx);
  const probe = CONSUMER_GLOBALS.map(n => `var ${n} = null;`).join('\n');
  // Concatenate just like build-demo.js does, then parse-check.
  new vm.Script(inlinable + '\n' + probe, { filename: 'bundle+consumer-probe.js' });
});

// ── 3. The actual rendered demo.html parses ──────────────────────────
// This is the closest we can get to "Chrome would not error on load"
// without a headless browser. V8 is the same parser Chrome uses.
check('demo.html: inline <script> body parses with V8', function () {
  const html = fs.readFileSync(DEMO_HTML, 'utf8');
  // demos/demo.template.html has exactly one inline <script> block that
  // wraps the engine + demo logic.
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('demos/demo.html has no <script> block');
  new vm.Script(m[1], { filename: 'demos/demo.html#inline' });
});

// ── 4. Defense-in-depth: cheap grep for top-level _<word> shadows ────
// IIFE wrapping should mean every `_<ident>` declaration sits inside a
// module IIFE. A column-0 declaration in the post-shim region (where
// every line is either a module IIFE wrapper or its body) is the bug
// class we just fixed. We anchor the scan at the `const __NS__ = {};`
// line the bundler emits right after SHIM_PREAMBLE so the multi-line
// crypto IIFE in the shim doesn't throw off depth tracking.
check('bundle: no unwrapped top-level (let|var|const) _<ident>', function () {
  const src = fs.readFileSync(BUNDLE, 'utf8');
  const lines = src.split('\n');
  const anchor = lines.findIndex(l => /^const __NS__\s*=/.test(l));
  if (anchor === -1) throw new Error('bundle missing `const __NS__` anchor');
  let depth = 0;
  const offenders = [];
  for (let i = anchor + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\(function\s*\(\s*\)\s*\{/.test(line)) { depth++; continue; }
    if (/^\}\)\(\);?\s*$/.test(line))            { depth--; continue; }
    if (depth !== 0) continue;
    if (/^(let|var|const)\s+_\w+\b/.test(line)) {
      offenders.push((i + 1) + ': ' + line);
    }
  }
  if (offenders.length > 0) {
    throw new Error('top-level _<ident> declarations found:\n  ' + offenders.join('\n  '));
  }
});

// ── Summary ──────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
if (failures === 0) {
  console.log('ALL PASSED (' + passed + '/' + (passed + failures) + ')');
  process.exit(0);
} else {
  console.log('FAILED (' + failures + '/' + (passed + failures) + ')');
  process.exit(1);
}
