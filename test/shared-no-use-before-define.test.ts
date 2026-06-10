// test/shared-no-use-before-define.test.ts — Remediation M1 lint guard.
//
// shared.js is machine-appended by the self-improving tuning loop, and that
// process has repeatedly emitted guards that READ a hoisted `var` before its
// assignment (gpu_eff's `tm` — H1; `_hbmRp99`/`tr` in p99; `p99R`/`_tp99Tok`/
// `tickEstTok` in tokens; `tHbm` in collective — M1). Hoisting makes those
// reads `undefined`, so the guards silently never apply (or throw, masked by
// the old empty catch). This test is a standing `no-use-before-define` lint
// over shared.js implemented with the TypeScript parser (already a
// devDependency), so the class of bug fails CI instead of silently
// disabling tuned suppressions.
//
// Scope rules (deliberately conservative to avoid false positives):
//   - `var` declarations are function-scoped; each function body is analyzed
//     as one scope, including vars declared inside nested blocks/for-loops.
//   - Identifier uses inside NESTED functions are checked against the nested
//     function's own scope only (closures may legitimately reference outer
//     vars declared later in source order).
//   - Pure assignment targets (`x = ...`) are writes, not reads, and are
//     not flagged.
//   - Parameters and function declarations shadow; shadowed names are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const SHARED = path.resolve(__dirname, '..', 'shared.js');

interface Violation { name: string; line: number; declLine: number }

function lintUseBeforeVarDefine(filePath: string): Violation[] {
  const src = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  const violations: Violation[] = [];

  function isFunctionLike(node: ts.Node): boolean {
    return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
           ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
           ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
  }

  // Collect `var`-declared names (with the position of their declarator)
  // within one function scope, not descending into nested functions.
  function collectVars(body: ts.Node, out: Map<string, number>): void {
    body.forEachChild((child) => {
      if (isFunctionLike(child)) return;
      if (ts.isVariableDeclarationList(child) && !(child.flags & ts.NodeFlags.BlockScoped)) {
        for (const decl of child.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const pos = decl.name.getStart(sf);
            const prev = out.get(decl.name.text);
            if (prev === undefined || pos < prev) out.set(decl.name.text, pos);
          }
        }
      }
      collectVars(child, out);
    });
  }

  // Collect parameter / shadowing names for a function scope.
  function scopeShadows(fn: ts.Node): Set<string> {
    const names = new Set<string>();
    const fnLike = fn as ts.FunctionLikeDeclaration;
    if (fnLike.parameters) {
      for (const p of fnLike.parameters) {
        if (ts.isIdentifier(p.name)) names.add(p.name.text);
      }
    }
    if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) {
      names.add(fn.name.text);
    }
    return names;
  }

  function isWriteOnlyUse(id: ts.Identifier): boolean {
    const parent = id.parent;
    // Declaration site itself
    if (ts.isVariableDeclaration(parent) && parent.name === id) return true;
    // Simple assignment target: x = ...
    if (ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === id) return true;
    // Property names (a.x — the `x`), object literal keys, labels
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === id) return true;
    if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === id) return true;
    return false;
  }

  function checkScope(fn: ts.Node, body: ts.Node): void {
    const vars = new Map<string, number>();
    collectVars(body, vars);
    const shadows = scopeShadows(fn);

    function walkUses(node: ts.Node): void {
      if (isFunctionLike(node)) {
        const nestedBody = (node as ts.FunctionLikeDeclaration).body;
        if (nestedBody) checkScope(node, nestedBody);
        return;
      }
      if (ts.isIdentifier(node) && !isWriteOnlyUse(node)) {
        const name = node.text;
        if (vars.has(name) && !shadows.has(name)) {
          const usePos = node.getStart(sf);
          const declPos = vars.get(name)!;
          if (usePos < declPos) {
            violations.push({
              name,
              line: sf.getLineAndCharacterOfPosition(usePos).line + 1,
              declLine: sf.getLineAndCharacterOfPosition(declPos).line + 1,
            });
          }
        }
      }
      node.forEachChild(walkUses);
    }
    walkUses(body);
  }

  checkScope(sf, sf);
  return violations;
}

test('shared.js has no hoisted-var use-before-define (dead tuned guards)', () => {
  const violations = lintUseBeforeVarDefine(SHARED);
  const summary = violations
    .map((v) => `  ${v.name} read at shared.js:${v.line} before its var declaration at :${v.declLine}`)
    .join('\n');
  assert.equal(
    violations.length, 0,
    `use-before-define in shared.js — these guards evaluate against undefined ` +
    `and silently never apply (or throw into evaluateSignals):\n${summary}`,
  );
});
