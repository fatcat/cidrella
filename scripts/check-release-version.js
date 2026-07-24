#!/usr/bin/env node
'use strict';

// Build-time guard for scripts/build-release.sh: the ROOT package.json version
// must equal the version in the newest `## vX.Y.Z` heading of RELEASE-NOTES.md.
//
// Why: on 2026-06-08 the 0.4.16 work was committed with no package.json bump and
// no 0.4.16 release-notes section, the mismatch surfaced only at release time.
// This fails the build up front instead.
//
// Scope: ONLY the root package.json is release-tracked. server/ and client/
// package.json versions are intentionally ignored (unread by the build and the
// app, APP_VERSION reads the root). Pre-release builds splice the -pre.N
// suffix AFTER this check runs, so the comparison is always base-vs-base.
//
// Usage: node check-release-version.js [project-dir]

const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(process.argv[2] || '.');
const pkgPath = path.join(projectDir, 'package.json');
const notesPath = path.join(projectDir, 'RELEASE-NOTES.md');

const pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;

const notes = fs.readFileSync(notesPath, 'utf8');
const heading = notes.split('\n').find((l) => /^## v\d/.test(l));
if (!heading) {
  console.error(`  ERROR: no '## vX.Y.Z' heading found in ${notesPath}.`);
  console.error('  Every release needs a RELEASE-NOTES.md section before it can be built.');
  process.exit(1);
}
const m = heading.match(/^## v(\S+)/);
const notesVersion = m && m[1];

if (notesVersion !== pkgVersion) {
  console.error(`  ERROR: version mismatch between package.json and RELEASE-NOTES.md:`);
  console.error(`    package.json version:        ${pkgVersion}`);
  console.error(`    newest RELEASE-NOTES heading: v${notesVersion} ("${heading.trim()}")`);
  console.error('  Either bump the root package.json version or add the missing');
  console.error(`  '## v${pkgVersion} — <date>' section to RELEASE-NOTES.md, then rerun.`);
  process.exit(1);
}

console.log(`  Release version OK (package.json ${pkgVersion} == RELEASE-NOTES v${notesVersion})`);
