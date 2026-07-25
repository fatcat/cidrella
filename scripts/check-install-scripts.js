#!/usr/bin/env node
'use strict';

// Build-time supply-chain guard for scripts/build-release.sh.
//
// The staged production install runs `npm ci --omit=dev --ignore-scripts`, which
// blocks dependency lifecycle scripts (preinstall/install/postinstall) from
// executing on the build machine. That closes the delivery vector used by the
// September 2025 npm attacks: the Shai-Hulud worm shipped its credential
// stealer in a postinstall hook, and a compromised package would otherwise run
// arbitrary code here, with the maintainer's npm/GitHub credentials in reach.
//
// The problem with --ignore-scripts alone: npm skips the scripts SILENTLY. No
// warning, no summary of what it declined to run (verified empirically). So a
// future dependency that legitimately needs a build step (a native module that
// compiles via node-gyp rather than shipping prebuilds) would install "fine"
// and then fail at runtime with a bare ERR_DLOPEN/missing-.node error, far from
// the cause.
//
// This guard closes that gap: it scans the staged production tree and fails the
// build if ANY dependency declares an install-time script. Today the tree is
// clean (better-sqlite3 13 and @duckdb/node-api ship prebuilt binaries), so the
// expected state is zero. A hit means one of two things, and both want a human:
//   1. A legitimate new native dependency -> decide consciously: allowlist it
//      below and drop --ignore-scripts for it, or pick a prebuilt alternative.
//   2. A supply-chain compromise -> you just caught it before signing.
//
// Usage: node check-install-scripts.js <staged-server-dir> [--warn-only]

const fs = require('fs');
const path = require('path');

const LIFECYCLE = ['preinstall', 'install', 'postinstall'];

// Packages knowingly permitted to declare install scripts. Keep empty unless a
// real native dependency is added, and note WHY here when you add one.
const ALLOWLIST = new Set([]);

const stagedServerDir = process.argv[2];
const warnOnly = process.argv.includes('--warn-only');

if (!stagedServerDir) {
  console.error('  ERROR: check-install-scripts.js requires the staged server dir as its first argument.');
  process.exit(2);
}

const modulesDir = path.join(stagedServerDir, 'node_modules');
if (!fs.existsSync(modulesDir)) {
  console.error(`  ERROR: no node_modules found at ${modulesDir}.`);
  console.error('  This guard must run AFTER the staging npm ci step.');
  process.exit(2);
}

// Walk node_modules including scoped (@scope/name) and nested trees.
function findPackageJsons(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === '.bin') continue;
    if (entry.name.startsWith('@')) {
      findPackageJsons(full, out);
      continue;
    }
    const pkgJson = path.join(full, 'package.json');
    if (fs.existsSync(pkgJson)) out.push(pkgJson);
    const nested = path.join(full, 'node_modules');
    if (fs.existsSync(nested)) findPackageJsons(nested, out);
  }
  return out;
}

const found = [];
for (const pkgJsonPath of findPackageJsons(modulesDir)) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    continue; // unparseable package.json is the import guard's problem, not ours
  }
  const scripts = pkg.scripts || {};
  const hits = LIFECYCLE.filter((name) => typeof scripts[name] === 'string' && scripts[name].trim());
  if (hits.length === 0) continue;
  if (ALLOWLIST.has(pkg.name)) continue;
  found.push({
    name: pkg.name || path.relative(modulesDir, path.dirname(pkgJsonPath)),
    version: pkg.version || '?',
    scripts: hits.map((h) => `${h}: ${String(scripts[h]).slice(0, 120)}`),
    location: path.relative(stagedServerDir, path.dirname(pkgJsonPath)),
  });
}

if (found.length === 0) {
  console.log('  Install-script guard OK (no dependency declares preinstall/install/postinstall)');
  process.exit(0);
}

console.error('');
console.error(`  ${warnOnly ? 'WARNING' : 'ERROR'}: ${found.length} staged dependency/dependencies declare install-time scripts:`);
for (const f of found) {
  console.error(`    ${f.name}@${f.version}  (${f.location})`);
  for (const s of f.scripts) console.error(`      ${s}`);
}
console.error('');
console.error('  The staged install uses --ignore-scripts, so these did NOT run, meaning');
console.error('  if any is a genuine build step, the package is now incomplete and will');
console.error('  fail at runtime (missing native binding), not here.');
console.error('');
console.error('  Decide which case this is:');
console.error('    * Legitimate native dependency -> add its name to ALLOWLIST in');
console.error('      scripts/check-install-scripts.js AND arrange for it to build');
console.error('      (or switch to a package shipping prebuilt binaries).');
console.error('    * Unexpected -> treat as a possible supply-chain compromise. Inspect the');
console.error('      script above and the package contents before publishing anything.');
console.error('');

process.exit(warnOnly ? 0 : 1);
