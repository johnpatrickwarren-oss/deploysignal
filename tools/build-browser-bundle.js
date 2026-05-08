'use strict';
/**
 * tools/build-browser-bundle.js — Custom tsc-output concatenator.
 *
 * Reads `dist-browser/engine/*.js` (ES2020 modules emitted by tsc -p
 * tsconfig.browser.json), walks the import graph from the public entry
 * points, topo-sorts modules, then wraps each module's body in an IIFE
 * with a shared `__NS__` namespace object so module-scope identifiers
 * (e.g. `_state`) cannot collide with each other OR with consumer-page
 * globals when the bundle is inlined into demos/demo.html.
 *
 * Why custom rather than esbuild/rollup: the runway thesis is "no new
 * runtime dependencies." The browser bundle must be drift-guarded by
 * test/browser-parity.test.js against the Node engine. Using tsc as the
 * sole build tool keeps the dep surface flat.
 *
 * Why IIFE-per-module rather than rename-on-collision: IIFE isolation
 * eliminates the entire class of module-scope collision (matches how
 * esbuild/rollup handle it) instead of patching one identifier at a
 * time. W5 surfaced this when `let _state` from engine/gates/state.ts
 * collided with `var _state` in demos/demo.template.html.
 *
 * Usage:
 *   node tools/build-browser-bundle.js          # generate bundle
 *   node tools/build-browser-bundle.js --check  # exit 1 if bundle stale
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT       = path.resolve(__dirname, '..');
const TSCONFIG   = path.join(ROOT, 'tsconfig.browser.json');
const SRC_DIR    = path.join(ROOT, 'dist-browser', 'engine');
const OUT_PATH   = path.join(ROOT, 'engine', 'index.browser.js');
const NODE_BIN   = new Set(['fs', 'path', 'crypto']);

const checkMode = process.argv.includes('--check');

// Public ES module exports the bundle should expose. Demos and the
// browser-parity test consume from this surface; types-only re-exports
// are dropped (TypeScript erases them at emit time).
const PUBLIC_EXPORTS = [
  // Orchestrator entry (callers wrap as `evaluate`/`orchestrate`)
  'evaluate',
  // Trend / threshold helpers (used by runner, demo UI)
  'TrendBuffer', 'trendStrength', 'effectiveThreshold', 'TOTAL_TICKS', 'computeVerdict',
  // Audit surface (WS3.2 provenance panel needs buildAuditRecord)
  'buildAuditRecord',
  // Verdict fusion (used by some inspection tools)
  'fuseVerdict',
  // Detector registry constant (used for label rendering)
  'DETECTOR_REGISTRY',
  // Schema-continuity helpers (used by demo's schema-break scenario)
  'shouldSuppress', 'familiesToSuppress', 'classifyContinuity',
  'hashSchema', 'makeContinuityRecord', 'MIN_REBASELINE_SAMPLES',
  // Family-A primary signals (used by demo's per-detector rendering)
  'FAMILY_A_PRIMARY_SIGNALS', 'FAMILY_C_SIGNALS', 'FAMILY_D_SIGNALS',
  // Drift detector (Demo 6 baseline-maintenance; UI renders drift state
  // and the §A6 unit test imports the math entry points).
  'evaluateBaselineDrift', 'driftDistanceSquared',
  'DRIFT_ALPHA_DEFAULT', 'DRIFT_SAMPLE_WINDOW_MAX',
];

// ── Module graph walker ─────────────────────────────────────────────

function resolveModule(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const fromDir = path.dirname(fromFile);
  let p = path.resolve(fromDir, spec);
  if (!p.endsWith('.js')) p += '.js';
  return p;
}

// Single regex covering both `import { ... } from '...'` and `import * as X from '...'`.
// Capture groups: 1 = named clause body (between {}), 2 = namespace alias, 3 = specifier.
const IMPORT_RE = /^import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;

function parseImports(source, fromFile) {
  // Returns [{ kind: 'rel'|'node', spec, resolved, names: [{imported, local}] | null, ns: string | null }]
  const out = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    const namedClause = m[1];
    const nsAlias = m[2];
    const spec = m[3];
    const kind = spec.startsWith('.') ? 'rel' : 'node';
    const resolved = kind === 'rel' ? resolveModule(fromFile, spec) : null;
    if (nsAlias) {
      out.push({ kind, spec, resolved, names: null, ns: nsAlias });
    } else {
      const names = namedClause.split(',').map(s => s.trim()).filter(Boolean).map(piece => {
        const parts = piece.split(/\s+as\s+/);
        return { imported: parts[0].trim(), local: (parts[1] || parts[0]).trim() };
      });
      out.push({ kind, spec, resolved, names, ns: null });
    }
  }
  return out;
}

function readModule(file) {
  const source = fs.readFileSync(file, 'utf8');
  const imports = parseImports(source, file);
  const relImports = imports.filter(i => i.kind === 'rel').map(i => i.resolved);
  const nodeImports = imports.filter(i => i.kind === 'node').map(i => i.spec);
  return { source, imports, relImports, nodeImports };
}

function topoSort(entries) {
  const order = [];
  const seen = new Set();
  const inProgress = new Set();
  const cache = new Map();
  function visit(file) {
    if (seen.has(file)) return;
    if (inProgress.has(file)) {
      throw new Error(`circular import detected involving ${file}`);
    }
    inProgress.add(file);
    if (!cache.has(file)) cache.set(file, readModule(file));
    const mod = cache.get(file);
    for (const dep of mod.relImports) visit(dep);
    inProgress.delete(file);
    seen.add(file);
    order.push(file);
  }
  for (const entry of entries) visit(entry);
  return { order, cache };
}

// ── Source rewriter ─────────────────────────────────────────────────

function stripImportLines(source) {
  return source.replace(IMPORT_RE, '');
}

/** Strip `export` markers from declarations and bare re-export blocks,
 *  collecting [{ local, exported }] pairs. The stripped source still
 *  declares the same identifiers (now module-private, since they live
 *  inside an IIFE); the collected pairs drive the `__NS__.X = local`
 *  publish epilogue. */
function rewriteExports(source) {
  const exports = [];
  let out = source;

  // `export type X ...` — drop entirely (tsc usually erases, but defensive).
  out = out.replace(/^export\s+type\s+[^\n]*$/gm, '');

  // `export * from './x';` — Addition #17 rename shims use this to
  // forward every symbol from the canonical module. In the IIFE/__NS__
  // model the canonical module has already published its symbols into
  // __NS__, so the shim is effectively a no-op once bundled — strip the
  // line so it doesn't leak an illegal `export` into the wrapped IIFE body.
  out = out.replace(/^export\s+\*\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm, '');

  // `export { A, B as C };` — drop, register {A→A, B→C}.
  out = out.replace(/^export\s+\{([^}]*)\}\s*;?\s*$/gm, (_, inner) => {
    inner.split(',').map(s => s.trim()).filter(Boolean).forEach(piece => {
      const parts = piece.split(/\s+as\s+/);
      exports.push({ local: parts[0].trim(), exported: (parts[1] || parts[0]).trim() });
    });
    return '';
  });

  // `export <kw> Name ...` — strip `export `, register {Name→Name}.
  // Forms: function, async function, class, const, let, var.
  out = out.replace(
    /^export\s+(async\s+function\s+|function\s+|class\s+|const\s+|let\s+|var\s+)(\w+)/gm,
    (_, kw, name) => {
      exports.push({ local: name, exported: name });
      return kw + name;
    }
  );

  return { rewritten: out, exports };
}

/** Build the IIFE prelude that destructures imported names from `__NS__`.
 *  Node-builtin imports are skipped — the SHIM_PREAMBLE declares `fs`,
 *  `path`, `crypto` at outer scope and the IIFE inherits them via closure. */
function buildImportPrelude(imports) {
  const lines = [];
  for (const imp of imports) {
    if (imp.kind === 'node') continue; // shim provides via outer scope
    if (imp.ns) {
      // `import * as ns from './x'` — not used in current sources, but
      // handled for safety: bind ns to the whole namespace.
      lines.push(`  var ${imp.ns} = __NS__;`);
      continue;
    }
    if (!imp.names || imp.names.length === 0) continue;
    const destructure = imp.names
      .map(n => n.imported === n.local ? n.local : `${n.imported}: ${n.local}`)
      .join(', ');
    lines.push(`  var { ${destructure} } = __NS__;`);
  }
  return lines.join('\n');
}

function buildExportEpilogue(exports) {
  if (exports.length === 0) return '';
  return exports.map(e => `  __NS__.${e.exported} = ${e.local};`).join('\n');
}

// ── Browser shim block ──────────────────────────────────────────────

const SHIM_PREAMBLE = `// ─── Node built-in shims (browser bundle) ──────────────────────────────
// audit.ts imports fs/path/crypto for createAuditWriter (file IO) and
// for the policy_ctx_digest SHA-1. The demo never invokes
// createAuditWriter, so fs/path are inert no-ops here. crypto.createHash
// is a tiny pure-JS SHA-1 so buildAuditRecord stays usable in-browser.
const fs = {
  mkdirSync: function () {},
  appendFileSync: function () {},
  existsSync: function () { return false; },
  readFileSync: function () { return ''; },
  writeFileSync: function () {},
};
const path = {
  join: function () { return Array.prototype.slice.call(arguments).join('/'); },
  dirname: function (p) { var i = String(p).lastIndexOf('/'); return i < 0 ? '.' : p.slice(0, i); },
  resolve: function () { return Array.prototype.slice.call(arguments).join('/'); },
};
const crypto = (function () {
  // Tiny pure-JS SHA-1 (RFC 3174). ~1.5 KB minified. Not constant-time.
  // Sufficient for policy_ctx_digest "did the context change" semantics
  // since the digest is opaque to consumers (no security claim).
  function sha1(msg) {
    function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }
    var m = unescape(encodeURIComponent(msg));
    var l = m.length;
    var w = [];
    for (var i = 0; i < l; i++) {
      w[i >> 2] = (w[i >> 2] || 0) | (m.charCodeAt(i) << (24 - (i & 3) * 8));
    }
    w[l >> 2] = (w[l >> 2] || 0) | (0x80 << (24 - (l & 3) * 8));
    w[((l + 8) >> 6) * 16 + 15] = l * 8;
    var H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    for (var bi = 0; bi < w.length; bi += 16) {
      var W = w.slice(bi, bi + 16);
      for (var t = 16; t < 80; t++) W[t] = rotl(W[t - 3] ^ W[t - 8] ^ W[t - 14] ^ W[t - 16], 1);
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4];
      for (t = 0; t < 80; t++) {
        var f, k;
        if (t < 20)      { f = (b & c) | ((~b) & d);          k = 0x5A827999; }
        else if (t < 40) { f = b ^ c ^ d;                     k = 0x6ED9EBA1; }
        else if (t < 60) { f = (b & c) | (b & d) | (c & d);   k = 0x8F1BBCDC; }
        else             { f = b ^ c ^ d;                     k = 0xCA62C1D6; }
        var temp = (rotl(a, 5) + f + e + k + W[t]) | 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = temp;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0;
      H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
    }
    var hex = '';
    for (i = 0; i < 5; i++) {
      var v = H[i] >>> 0;
      hex += ('00000000' + v.toString(16)).slice(-8);
    }
    return hex;
  }
  return {
    createHash: function (algo) {
      if (algo !== 'sha1') throw new Error('browser shim: only sha1 supported');
      var buf = '';
      return {
        update: function (s) { buf += s; return this; },
        digest: function (enc) {
          if (enc !== 'hex') throw new Error('browser shim: only hex digest supported');
          return sha1(buf);
        },
      };
    },
  };
})();
`;

// ── Main ───────────────────────────────────────────────────────────

function build() {
  // Step 1: emit ES2020 modules
  execSync('npx tsc -p ' + JSON.stringify(TSCONFIG), { cwd: ROOT, stdio: 'inherit' });

  // Step 2: pick entry points — public-surface modules that consumers reach.
  const entries = [
    path.join(SRC_DIR, 'orchestrator.js'),
    path.join(SRC_DIR, 'audit.js'),
    path.join(SRC_DIR, 'verdict.js'),
    path.join(SRC_DIR, 'l0', 'schema-continuity.js'),
    path.join(SRC_DIR, 'detectors', 'mSPRT.js'),
    path.join(SRC_DIR, 'detectors', 'hotelling.js'),
    path.join(SRC_DIR, 'detectors', 'spectral.js'),
    path.join(SRC_DIR, 'detectors', 'conformal.js'),
    path.join(SRC_DIR, 'drift', 'baseline-drift-detector.js'),
  ];

  // Step 3: walk + topo-sort.
  const { order, cache } = topoSort(entries);

  // Step 4: validate node-builtin imports against the shim allowlist.
  for (const file of order) {
    const mod = cache.get(file);
    for (const ni of mod.nodeImports) {
      if (!NODE_BIN.has(ni)) {
        throw new Error(`unsupported node-builtin import '${ni}' in ${file}`);
      }
    }
  }

  // Step 5: render bundle.
  let body = '// engine/index.browser.js — GENERATED by tools/build-browser-bundle.js\n';
  body += '// Source of truth: engine/**/*.ts. DO NOT hand-edit — re-run the generator.\n';
  body += '// Build cmd:  node tools/build-browser-bundle.js\n';
  body += '// Drift gate: test/browser-parity.test.js (Node engine ↔ browser module).\n';
  body += '// Module isolation: each engine/*.ts module is wrapped in an IIFE so its\n';
  body += '// internal `let/var/const` cannot collide with sibling modules or with\n';
  body += '// consumer-page globals (demos/demo.html). Cross-module imports flow\n';
  body += '// through the shared `__NS__` namespace, populated in topo order.\n\n';
  body += SHIM_PREAMBLE + '\n';
  body += '// Shared namespace populated by each module IIFE. Cross-module imports\n';
  body += '// destructure from this object at the top of their IIFE.\n';
  body += 'const __NS__ = {};\n\n';

  for (const file of order) {
    const mod = cache.get(file);
    const rel = path.relative(SRC_DIR, file);
    const stripped = stripImportLines(mod.source);
    const { rewritten, exports } = rewriteExports(stripped);
    const prelude = buildImportPrelude(mod.imports);
    const epilogue = buildExportEpilogue(exports);

    body += '// ══════════════════════════════════════════════════════════════════════\n';
    body += '// From: engine/' + rel.replace(/\\/g, '/') + '\n';
    body += '// ══════════════════════════════════════════════════════════════════════\n';
    body += '(function () {\n';
    if (prelude) body += prelude + '\n';
    body += rewritten.trim() + '\n';
    if (epilogue) body += epilogue + '\n';
    body += '})();\n\n';
  }

  // Step 6: rebind public exports at top level + emit ES module export block.
  body += '// ══════════════════════════════════════════════════════════════════════\n';
  body += '// Public ES module exports — rebound from the shared namespace so\n';
  body += '// `import { evaluate } from "./engine/index.browser.js"` works.\n';
  body += '// ══════════════════════════════════════════════════════════════════════\n';
  body += 'const {\n';
  for (const name of PUBLIC_EXPORTS) body += '  ' + name + ',\n';
  body += '} = __NS__;\n\n';
  body += 'export {\n';
  for (const name of PUBLIC_EXPORTS) body += '  ' + name + ',\n';
  body += '};\n';

  return body;
}

function main() {
  const out = build();
  if (checkMode) {
    let existing = '';
    try { existing = fs.readFileSync(OUT_PATH, 'utf8'); } catch (_) { /* ok */ }
    if (existing === out) {
      console.log('OK: engine/index.browser.js is up to date with engine/**/*.ts');
      process.exit(0);
    } else {
      console.error('FAIL: engine/index.browser.js is stale. Run: node tools/build-browser-bundle.js');
      process.exit(1);
    }
  } else {
    fs.writeFileSync(OUT_PATH, out, 'utf8');
    console.log('Generated engine/index.browser.js (' + out.split('\n').length + ' lines)');
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message || e); process.exit(1); }
}

module.exports = { build };
