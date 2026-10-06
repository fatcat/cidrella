#!/usr/bin/env node
'use strict';
/**
 * Guard: only the backend layer reaches into a DNS/DHCP backend adapter.
 *
 * Everything outside server/src/backends/ talks to dnsmasq through
 * server/src/backends/index.js (the registry) or
 * server/src/services/backend-apply.js, so a second adapter can replace it
 * without its callers changing. ESLint's no-restricted-imports enforces that
 * for static imports in server/src; this covers what ESLint cannot see: a
 * dynamic import(), and the vi.mock() and import() strings in tests. A route
 * test that mocks the adapter instead of the registry tests the wrong seam.
 *
 * Allowed: server/src/backends/**, and the tests of the adapters themselves
 * (server/tests/unit/backends/**, server/tests/integration/backends/**,
 * server/tests/contract/**). Any other quoted module path naming
 * backends/<adapter>/ fails. Comments are ignored.
 *
 * BASELINE: none. A new entry is never the fix; use the registry, or
 * stubBackendApply / fakeBackendsModule from server/tests/helpers/fake-backends.js.
 *
 * Usage: node scripts/check-backend-imports.js [project-dir]
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const SCAN = ['server/src', 'server/tests'];
const ALLOWED = [
  'server/src/backends/',
  'server/tests/unit/backends/',
  'server/tests/integration/backends/',
  'server/tests/contract/',
];
// A quoted relative module path into an adapter directory under backends/.
const ADAPTER_PATH = /(['"`])[^'"`\n]*\bbackends\/(?!index\.js|contract\.js)[\w-]+\/[^'"`\n]*\1/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Blank out comments, keeping line numbers.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const violations = [];
for (const base of SCAN) {
  for (const file of walk(path.join(root, base))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (ALLOWED.some((prefix) => rel.startsWith(prefix))) continue;
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(ADAPTER_PATH)) {
        violations.push(`${rel}:${index + 1}: ${match[0]}`);
      }
    });
  }
}

if (violations.length) {
  console.error('Backend adapter referenced outside the backend layer:');
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    'Use server/src/backends/index.js or services/backend-apply.js; in tests, ' +
      'fakeBackendsModule or stubBackendApply from tests/helpers/fake-backends.js.',
  );
  process.exit(1);
}
console.log('  Backend-import check OK (no adapter references outside backends/)');
