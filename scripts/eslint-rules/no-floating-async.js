'use strict';
/**
 * ESLint rule: a call to an async function whose promise nobody handles.
 *
 * A bare `refresh();` statement drops the promise. If it rejects, the error
 * reaches only the global unhandledRejection handler, and whatever the call
 * had half done stays half done: SCAN-SETUP-STRANDED-01 was a scan row left
 * pending that way, which blocked every later scan of its subnet.
 *
 * Reported: a call statement to a function declared `async` in the same file,
 * or exported as `async` by the module it is imported from (a named or a
 * namespace import, relative paths and @shared). Accepted: `await f()`,
 * `return f()`, `f().catch(...)`, and `void f()`, which says the call is
 * fire-and-forget on purpose because the function handles its own errors.
 *
 * Not seen: a plain function that returns a promise, and a method on an
 * object. Those need type information this repo does not have.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SHARED = path.join(ROOT, 'server', 'src', 'utils');
const EXPORT_RE = /export\s+(?:async\s+function\s*\*?\s*(\w+)|const\s+(\w+)\s*=\s*async\b)/g;

// Async exports per module, read once per file and cached for the lint run.
const exportsCache = new Map();
function asyncExports(file) {
  if (exportsCache.has(file)) return exportsCache.get(file);
  const names = new Set();
  try {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(EXPORT_RE)) names.add(m[1] || m[2]);
  } catch {
    // Not a file we can read (a package, a missing path): nothing known.
  }
  exportsCache.set(file, names);
  return names;
}

function resolveSource(fromFile, source) {
  let base;
  if (source.startsWith('@shared/')) base = path.join(SHARED, source.slice('@shared/'.length));
  else if (source.startsWith('.')) base = path.resolve(path.dirname(fromFile), source);
  else return null;
  return path.extname(base) ? base : `${base}.js`;
}

const isAsyncFn = (node) =>
  node &&
  (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
  node.async;

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow dropping the promise of an async function call' },
    messages: {
      floating:
        "{{name}}() returns a promise nobody handles. Await it, return it, end it with .catch(), or mark it 'void' if it handles its own errors.",
    },
    schema: [],
  },
  create(context) {
    const file = context.filename;
    const localAsync = new Set();
    const named = new Map(); // local name -> resolved module, for an async export
    const namespaces = new Map(); // namespace name -> resolved module
    const calls = [];

    function calleeName(callee) {
      if (callee.type === 'Identifier') {
        if (localAsync.has(callee.name)) return callee.name;
        if (named.has(callee.name)) return callee.name;
        return null;
      }
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        namespaces.has(callee.object.name) &&
        asyncExports(namespaces.get(callee.object.name)).has(callee.property.name)
      ) {
        return `${callee.object.name}.${callee.property.name}`;
      }
      return null;
    }

    return {
      FunctionDeclaration(node) {
        if (node.async && node.id) localAsync.add(node.id.name);
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && isAsyncFn(node.init)) localAsync.add(node.id.name);
      },
      ImportDeclaration(node) {
        const resolved = resolveSource(file, node.source.value);
        if (!resolved) return;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier') namespaces.set(spec.local.name, resolved);
          else if (
            spec.type === 'ImportSpecifier' &&
            asyncExports(resolved).has(spec.imported.name)
          ) {
            named.set(spec.local.name, resolved);
          }
        }
      },
      ExpressionStatement(node) {
        if (node.expression.type === 'CallExpression') calls.push(node.expression);
      },
      // Reported at the end, once every async declaration in the file is known:
      // a function may be called above where it is declared.
      'Program:exit'() {
        for (const call of calls) {
          const name = calleeName(call.callee);
          if (name) context.report({ node: call, messageId: 'floating', data: { name } });
        }
      },
    };
  },
};
