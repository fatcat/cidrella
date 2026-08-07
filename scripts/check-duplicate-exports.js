#!/usr/bin/env node
'use strict';

/**
 * Guard: a file must not define a function that a module it already imports
 * from also exports.
 *
 * This catches one specific, recurring shape. A shared helper is extracted so
 * everyone uses one implementation, and then a caller quietly grows its own
 * copy of a function that helper already provides, in a file that demonstrably
 * knows the helper exists (it imports other things from it). The copies then
 * drift on the boring edges, because the interesting logic is what gets
 * reviewed. `server/src/utils/validation.js` was created to end exactly this,
 * and two route files went on to redefine `isIntInRange` anyway.
 *
 * Note this is NOT shadowing. Importing a name and declaring it locally is a
 * SyntaxError, so the engine already catches that. The dangerous version is
 * quieter: import something else from the module, and hand-roll the rest.
 *
 * NAMESPACE IMPORTS ARE EXCLUDED. `import * as SubnetTopology from '...'` plus
 * a local `function insertSubnet()` that delegates to
 * `SubnetTopology.insertSubnet()` is a deliberate, readable wrapper pattern
 * used throughout routes/subnets.js. Only named imports count, because those
 * prove the file wanted specific things from the module and then wrote its own
 * version of another.
 *
 * BASELINE: known-open violations are listed below with their REVIEW.md finding
 * number, so this guard passes today and fails on anything NEW. Fixing one means
 * deleting its baseline entry. Do not add to the baseline to silence a new
 * finding, that is the whole thing this is here to prevent.
 *
 * Usage: node scripts/check-duplicate-exports.js [project-dir]
 */

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const SCAN_ROOTS = ['server/src', 'client/src'];

// Each entry: "<file>::<name>" plus why it is tolerated for now.
const BASELINE = {
  'server/src/routes/dns.js::isIntInRange':
    'REVIEW.md #14. Unifying makes the DNS zone route reject numeric strings, a behavior change.',
  'server/src/routes/settings.js::isIntInRange':
    'REVIEW.md #14. The settings route deliberately coerces numeric strings today.',
  'server/src/utils/ip-sync.js::fqdnForRecordName':
    'REVIEW.md #8. The local copy lowercases the zone name, so unifying changes stored hostnames.',
};

// Genuinely-not-duplicates, permanently allowed.
const ALLOWLIST = {
  'client/src/stores/subnets.js::calculateSubnets':
    'Async wrapper that POSTs to /subnets/calculate. Same name as the pure client helper, different job.',
};

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|dist|\.git/.test(full)) walk(full, acc);
    } else if (/\.(js|vue)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_][\w]*)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^\s*export\s+const\s+([A-Za-z_][\w]*)/gm)) names.add(m[1]);
  return names;
}

function localFunctionNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/gm)) names.add(m[1]);
  return names;
}

// Named imports only. `import * as X from '...'` is deliberately skipped.
function namedImportSources(source) {
  const sources = [];
  for (const m of source.matchAll(/^\s*import\s+([^;]*?)\s+from\s+'(\.[^']+)'/gm)) {
    const clause = m[1];
    if (/^\*\s+as\s+/.test(clause.trim())) continue;
    if (!clause.includes('{')) continue;
    sources.push(m[2]);
  }
  return sources;
}

const files = SCAN_ROOTS.flatMap(r => walk(path.join(PROJECT_DIR, r)));
const exportsByFile = new Map();
for (const f of files) exportsByFile.set(path.resolve(f), exportedNames(fs.readFileSync(f, 'utf8')));

const violations = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const locals = localFunctionNames(source);
  if (locals.size === 0) continue;

  for (const spec of namedImportSources(source)) {
    const target = path.resolve(path.dirname(file), spec);
    const targetExports = exportsByFile.get(target);
    if (!targetExports) continue;
    for (const name of targetExports) {
      if (!locals.has(name)) continue;
      const rel = path.relative(PROJECT_DIR, file);
      violations.push({ key: `${rel}::${name}`, file: rel, name, module: path.relative(PROJECT_DIR, target) });
    }
  }
}

const fresh = violations.filter(v => !(v.key in BASELINE) && !(v.key in ALLOWLIST));
const staleBaseline = Object.keys(BASELINE).filter(k => !violations.some(v => v.key === k));

if (fresh.length > 0) {
  console.error('');
  console.error('  ERROR: duplicate implementation of an already-imported module export.');
  console.error('');
  for (const v of fresh) {
    console.error(`    ${v.file}`);
    console.error(`      defines "${v.name}", which it imports from ${v.module}`);
  }
  console.error('');
  console.error('  That module already exports this. Import it instead of writing a second');
  console.error('  copy: the two will drift, and the drift will be somewhere boring like a');
  console.error('  null fallback or which field name is read.');
  console.error('');
  console.error('  If it genuinely is not the same thing (a store method that wraps an API');
  console.error('  call, say), add it to ALLOWLIST in this script with the reason.');
  console.error('');
  process.exit(1);
}

// A baseline entry that no longer matches means the underlying duplication was
// fixed. Say so, so the entry gets removed rather than lingering as noise.
if (staleBaseline.length > 0) {
  console.log('  NOTE: baseline entries no longer needed (the duplication is gone):');
  for (const k of staleBaseline) console.log(`    ${k}`);
  console.log('  Remove them from BASELINE in scripts/check-duplicate-exports.js.');
}

const tolerated = violations.length - fresh.length;
console.log(`  Duplicate-export check OK (${files.length} files, ${tolerated} known/allowed, 0 new)`);
