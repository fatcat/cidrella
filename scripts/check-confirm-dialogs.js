#!/usr/bin/env node
'use strict';
/**
 * Guard: a confirmation must not be hand-built as its own <Dialog>.
 *
 * A confirmation is a Dialog whose footer's primary action is a danger or
 * warn Button. Twenty-nine of them existed when this was written (22 danger,
 * 7 warn), in seventeen files, each with its own Cancel button, copy, busy
 * flag and, twice, a type-the-word field. A wording fix had to be made that
 * many times, and a feature added to one (the deallocation impact list)
 * reached only the dialogs someone remembered. They now all go through
 * client/src/components/ConfirmDialog.vue, and this guard keeps it that way.
 *
 * A `text` danger button is not counted: that is a trigger (Delete beside
 * Save in an editor, Revoke on a table row) that opens a confirmation or
 * acts on one row, not the confirmation itself.
 *
 * Detection is textual on purpose: the shape is regular (a <Dialog ...>
 * ... </Dialog> block with a <template #footer>) and ast-grep does not
 * parse Vue templates without a grammar mapping, so a parser would add a
 * dependency for no extra precision.
 *
 * BASELINE: files that still carry hand-built confirmations, with the count
 * in each. Empty since the conversion; a new entry is never the fix.
 *
 * Usage: node scripts/check-confirm-dialogs.js [project-dir]
 */
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const SCAN_ROOT = path.join(PROJECT_DIR, 'client/src');
// The one place a danger or warn button inside a Dialog footer is the point.
const SHARED = new Set(['components/ConfirmDialog.vue']);

// file (relative to client/src) -> number of hand-built confirmations today.
const BASELINE = {};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

// Count <Dialog ...>...</Dialog> blocks whose footer holds a non-text danger
// or warn Button. Dialogs are not nested in this codebase, so a non-greedy
// match per opening tag is exact.
function countConfirmations(src) {
  const template = /<template>([\s\S]*)<\/template>\s*(?:<script|$)/.exec(src)?.[1] || '';
  let count = 0;
  const re = /<Dialog\b[\s\S]*?<\/Dialog>/g;
  let m;
  while ((m = re.exec(template))) {
    const footer = /<template #footer>([\s\S]*?)<\/template>/.exec(m[0])?.[1] || '';
    const primary = [...footer.matchAll(/<Button\b[^>]*>/g)].some(
      ([tag]) => /severity="(danger|warn)"/.test(tag) && !/\stext\b/.test(tag),
    );
    if (primary) count += 1;
  }
  return count;
}

const failures = [];
let total = 0;
for (const file of walk(SCAN_ROOT)) {
  const rel = path.relative(SCAN_ROOT, file).split(path.sep).join('/');
  if (SHARED.has(rel)) continue;
  const n = countConfirmations(fs.readFileSync(file, 'utf8'));
  if (!n) continue;
  total += n;
  const allowed = BASELINE[rel] || 0;
  if (n > allowed) failures.push({ rel, n, allowed });
}

if (failures.length) {
  console.error('Hand-built confirmation dialog(s) beyond the baseline:');
  for (const f of failures) {
    console.error(`  ${f.rel}: ${f.n} found, baseline ${f.allowed}`);
  }
  console.error(
    '\nUse the shared ConfirmDialog (client/src/components/ConfirmDialog.vue) instead of a Dialog with its own danger or warn Button in the footer.',
  );
  process.exit(1);
}
const baselined = Object.values(BASELINE).reduce((s, n) => s + n, 0);
console.log(`  Confirm-dialog check OK (${total} hand-built, ${baselined} baselined, 0 new)`);
