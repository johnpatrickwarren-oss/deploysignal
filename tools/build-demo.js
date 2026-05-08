'use strict';
// tools/build-demo.js — Generate demos/demo.html from template + engine module
//
// Reads engine/index.browser.js, strips the ES module export block,
// and injects it into demos/demo.template.html at the {{ENGINE_INLINE}} marker.
//
// Usage:
//   node tools/build-demo.js          # generate demos/demo.html
//   node tools/build-demo.js --check  # exit 1 if demos/demo.html is stale

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const ENGINE   = path.join(ROOT, 'engine', 'index.browser.js');
const TEMPLATE = path.join(ROOT, 'demos', 'demo.template.html');
const OUTPUT   = path.join(ROOT, 'demos', 'demo.html');
const MARKER   = '/* {{ENGINE_INLINE}} */';
const CFG_MARKER = '/* {{COMPILED_CONFIG_INLINE}} */';
const SCRIPTS_MARKER = '/* {{CANNED_DEMOS_INLINE}} */';
const BASELINE_HISTORY_MARKER = '/* {{BASELINE_HISTORY_INLINE}} */';
const CFG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');
const SCRIPTS_DIR = path.join(ROOT, 'demos', 'scripts');
const BASELINE_HISTORY_DIR = path.join(ROOT, 'runs', 'baseline-history', 'demo');

const checkMode = process.argv.includes('--check');

// Read sources
const engineSrc   = fs.readFileSync(ENGINE, 'utf8');
const templateSrc = fs.readFileSync(TEMPLATE, 'utf8');

if (!templateSrc.includes(MARKER)) {
  console.error('ERROR: template is missing the ' + MARKER + ' marker');
  process.exit(1);
}

// Strip the export block from the engine module.
// The export block starts with "export {" and runs to the closing "};".
// Everything before that is plain function/var declarations that work as globals.
const exportStart = engineSrc.indexOf('\nexport {');
if (exportStart === -1) {
  console.error('ERROR: engine/index.browser.js has no "export {" block to strip');
  process.exit(1);
}
const inlineEngine = engineSrc.slice(0, exportStart).trimEnd();

// Inject engine into template
let output = templateSrc.replace(MARKER, inlineEngine);

// Inject v4 compiled config (read-only artifact for portfolio runs).
// Embedded so demos work from file:// without a backend.
if (output.includes(CFG_MARKER)) {
  let cfgInline = 'window.COMPILED_CONFIG_V4 = null;';
  if (fs.existsSync(CFG_PATH)) {
    cfgInline = 'window.COMPILED_CONFIG_V4 = ' + fs.readFileSync(CFG_PATH, 'utf8') + ';';
  }
  output = output.replace(CFG_MARKER, cfgInline);
}

// Inject canned-demo JSON files from demos/scripts/. WS3.5 fills these in;
// WS3.2 ships the marker so the load path is wired. D-54-4 slice 2b —
// demos live as baseline_ref + overrides; the shared loader resolves
// each to the flat shape the browser runtime expects.
if (output.includes(SCRIPTS_MARKER)) {
  const cannedDemos = {};
  if (fs.existsSync(SCRIPTS_DIR)) {
    const { loadAllDemoScripts } = require(path.join(ROOT, 'demos', 'load-demo.js'));
    Object.assign(cannedDemos, loadAllDemoScripts(SCRIPTS_DIR));
  }
  output = output.replace(SCRIPTS_MARKER, 'window.CANNED_DEMOS = ' + JSON.stringify(cannedDemos) + ';');
}

// W13 (ARCHITECT-REPLY-24): inject baseline-history artifacts for the
// service-maturity dashboard drawer section. Files live at
// runs/baseline-history/<service>/. For the runway demo, only
// <service>=demo ships baseline versions (v1-v5).
if (output.includes(BASELINE_HISTORY_MARKER)) {
  const history = [];
  if (fs.existsSync(BASELINE_HISTORY_DIR)) {
    const entries = fs.readdirSync(BASELINE_HISTORY_DIR).filter(f => f.endsWith('.json')).sort();
    for (const f of entries) {
      history.push(JSON.parse(fs.readFileSync(path.join(BASELINE_HISTORY_DIR, f), 'utf8')));
    }
  }
  output = output.replace(BASELINE_HISTORY_MARKER, 'window.BASELINE_HISTORY = ' + JSON.stringify(history) + ';');
}

if (checkMode) {
  // Compare against existing output
  let existing = '';
  try { existing = fs.readFileSync(OUTPUT, 'utf8'); } catch (_) {}
  if (existing === output) {
    console.log('OK: demos/demo.html is up to date with engine/index.browser.js');
    process.exit(0);
  } else {
    console.error('FAIL: demos/demo.html is stale. Run "node tools/build-demo.js" to regenerate.');
    process.exit(1);
  }
}

// Write output
fs.writeFileSync(OUTPUT, output, 'utf8');
console.log('Generated demos/demo.html (' + output.split('\n').length + ' lines)');
