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
// One shared definition of the release-header format. This guard used to carry
// its own looser regex, which accepted headings the manifest generator then
// silently skipped. See REVIEW.md, duplicate-logic audit #29.
const { parseHeadersFile } = require('./lib/release-notes.js');

const projectDir = path.resolve(process.argv[2] || '.');
const pkgPath = path.join(projectDir, 'package.json');
const notesPath = path.join(projectDir, 'RELEASE-NOTES.md');

const pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;

const { headers, errors } = parseHeadersFile(notesPath);

// A heading that announces a release and does not parse is fatal here too.
// Reporting "version OK" off a well-formed heading while an unreadable one sits
// above it is how a release goes missing from the signed manifest.
if (errors.length > 0) {
  console.error(`  ERROR: ${notesPath} has malformed release heading(s):`);
  for (const e of errors) console.error(`    line ${e.line}: ${e.message}`);
  process.exit(1);
}

if (headers.length === 0) {
  console.error(`  ERROR: no '## vX.Y.Z' heading found in ${notesPath}.`);
  console.error('  Every release needs a RELEASE-NOTES.md section before it can be built.');
  process.exit(1);
}

const heading = headers[0].raw;
const notesVersion = headers[0].version;

if (notesVersion !== pkgVersion) {
  console.error(`  ERROR: version mismatch between package.json and RELEASE-NOTES.md:`);
  console.error(`    package.json version:        ${pkgVersion}`);
  console.error(`    newest RELEASE-NOTES heading: v${notesVersion} ("${heading.trim()}")`);
  console.error('  Either bump the root package.json version or add the missing');
  console.error(`  '## v${pkgVersion} — <date>' section to RELEASE-NOTES.md, then rerun.`);
  process.exit(1);
}

console.log(`  Release version OK (package.json ${pkgVersion} == RELEASE-NOTES v${notesVersion})`);
