#!/usr/bin/env node
'use strict';

// Build-time completeness guard for scripts/build-release.sh.
//
// Every RELATIVE import/export/require in the STAGED server tree must resolve to
// a file that is actually present in staging. This catches the failure class
// behind the v0.4.16-pre.1 DOA: server/src/data/doh-providers.js was imported by
// routes/dns.js but excluded from the tarball by an unanchored `.buildignore`
// `data/` pattern, `node --check` passes (syntax is fine) and the missing module
// only surfaced in the post-publish A/B preflight (ERR_MODULE_NOT_FOUND). Running
// this against the staged tree fails the build BEFORE anything is signed/published.
//
// Scope: STATIC relative imports/re-exports only (`import … from './x'`,
// `export … from './x'`). These are load-time mandatory, so a missing target is
// always a broken release (the DOA case was a static `import {…} from
// '../data/doh-providers.js'`). Bare specifiers (node_modules) are out of scope,
// installed via `npm ci --omit=dev` and verified separately. Dynamic `import(…)`
// is deliberately NOT checked: it's conditional by nature and legitimately points
// at intentionally-unstaged modules (e.g. the dev-only routes/api-browser.js,
// loaded only when NODE_ENV !== 'production' and excluded from the tarball).
//
// Usage: node check-staging-imports.js <staged-server-dir>

const fs = require('fs');
const path = require('path');

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
  console.error('check-staging-imports: usage: check-staging-imports.js <staged-server-dir>');
  process.exit(2);
}

function walkJs(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(p, acc);
    else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

// Strip block + line comments so specifiers inside prose / commented-out code
// don't produce false positives. Naive re: string contents, but it only ever
// risks removing a real import (none live inside strings/comments), and the
// `[^:]` guard before `//` keeps `http://` intact.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Static `import ... from 'x'` / `export ... from 'x'` only. The `[^'"`;]` run
// can't cross a quote or `;`, so a dynamic `import('x')` on a prior line can't
// bridge to a later `from`. Dynamic import()/require() are intentionally excluded.
const SPEC_RE = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g;

function resolvesTo(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.json`, path.join(base, 'index.js')];
  return candidates.some((c) => {
    try { return fs.statSync(c).isFile(); } catch { return false; }
  });
}

const files = walkJs(root, []);
const missing = [];
for (const file of files) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  let m;
  while ((m = SPEC_RE.exec(src)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // bare specifier → node_modules
    if (!resolvesTo(file, spec)) {
      missing.push({ importer: path.relative(root, file), spec });
    }
  }
}

if (missing.length > 0) {
  console.error(`  ERROR: ${missing.length} relative import(s) in the staged server tree do not resolve:`);
  for (const x of missing) console.error(`    server/${x.importer}  →  ${x.spec}`);
  console.error('  A source file is missing from the tarball. Check .buildignore exclusions');
  console.error('  (anchor dev-only patterns with a leading "/") and confirm the file is');
  console.error('  committed to git. This is the v0.4.16-pre.1 DOA class — fail before publish.');
  process.exit(1);
}

console.log(`  Import completeness OK (${files.length} server JS files, all relative imports resolve)`);
