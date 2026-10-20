#!/usr/bin/env node
'use strict';

/**
 * The ONE definition of a RELEASE-NOTES.md release header.
 *
 * Three build-time tools need to answer "which versions do the notes declare":
 * check-release-version.js (package.json must match the newest heading),
 * build-release.sh (the version being built must have a section), and
 * build-releases-manifest.js (parse every section into the signed manifest).
 * All three used to carry their own parser, and they disagreed.
 *
 * That disagreement was not theoretical. A single ASCII hyphen where the
 * em-dash belongs parsed fine for the first two and was invisible to the third,
 * so the release being cut vanished from the signed releases.json (every host
 * kept seeing the previous version as newest) and its min_from lookup returned
 * nothing (disabling the skip-upgrade gate in the signed RELEASE.json), while
 * all three guards reported success. See REVIEW.md, duplicate-logic audit #29.
 *
 * The separator is U+2014 EM DASH by design, not an ASCII hyphen. That em-dash
 * is load-bearing and is on the documented keep-list: do not let a prose sweep
 * or the em-dash hook normalize it here, in RELEASE-NOTES.md headings, or in
 * the message below.
 *
 * Build-only. Deliberately absent from scripts/release-files.txt, so it is not
 * staged into release tarballs.
 *
 * Usage as a CLI (for bash callers):
 *   node scripts/lib/release-notes.js --newest <notes-file>
 *   node scripts/lib/release-notes.js --has-version <x.y.z> <notes-file>
 *   node scripts/lib/release-notes.js --tag <x.y.z> <notes-file>   (prints the [tag], if any)
 *   node scripts/lib/release-notes.js --section <x.y.z> <notes-file>
 *     (prints that version's notes for the GitHub release page: the prose under
 *     its heading, without the heading, the YAML metadata block, or the `---`
 *     separator before the next release)
 */

const fs = require('fs');

const RELEASE_HEADER_RE =
  /^##\s+v(\d+\.\d+\.\d+)\s+—\s+(\d{4}-\d{2}-\d{2})(?:\s+\[([^\]]+)\])?\s*$/;

// Anything trying to be a release header. Used to tell "malformed header" apart
// from "an ordinary ## heading", so the former fails loudly instead of being
// skipped in silence.
const RELEASE_HEADER_HINT_RE = /^##\s+v\d/;

function malformedHeaderMessage(line) {
  return (
    `malformed release header: ${JSON.stringify(String(line).trim())}. ` +
    'Expected "## vX.Y.Z — YYYY-MM-DD" with a U+2014 em-dash separator ' +
    '(an ASCII hyphen will not parse).'
  );
}

/**
 * Parse every release header out of RELEASE-NOTES.md source text.
 * Returns headers in file order (newest first, by convention) plus a hard
 * error for every line that announced a release and failed to parse.
 */
function parseHeaders(source) {
  const headers = [];
  const errors = [];
  const lines = String(source).split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = RELEASE_HEADER_RE.exec(line);
    if (match) {
      headers.push({
        version: match[1],
        released_at: match[2],
        tag: match[3] || null,
        line: i + 1,
        raw: line,
      });
    } else if (RELEASE_HEADER_HINT_RE.test(line)) {
      errors.push({ line: i + 1, message: malformedHeaderMessage(line) });
    }
  }

  return { headers, errors };
}

function parseHeadersFile(notesPath) {
  return parseHeaders(fs.readFileSync(notesPath, 'utf8'));
}

/**
 * The notes for one version, as a release page shows them: everything from its
 * heading to the next release heading, less the heading itself, the fenced YAML
 * metadata block right under it, and the trailing `---` separator. Null when
 * the notes have no heading for that version.
 */
function sectionBody(source, version) {
  const lines = String(source).split('\n');
  const { headers } = parseHeaders(source);
  const index = headers.findIndex((h) => h.version === version);
  if (index === -1) return null;
  const start = headers[index].line; // the line after the heading (1-based)
  const end = index + 1 < headers.length ? headers[index + 1].line - 1 : lines.length;
  let body = lines.slice(start, end);

  let first = body.findIndex((line) => line.trim() !== '');
  if (first !== -1 && /^```ya?ml\s*$/.test(body[first].trim())) {
    const close = body.findIndex((line, i) => i > first && line.trim() === '```');
    if (close !== -1) body = body.slice(close + 1);
  }
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  if (body.length && body[body.length - 1].trim() === '---') body.pop();
  return body.join('\n').trim();
}

module.exports = {
  RELEASE_HEADER_RE,
  RELEASE_HEADER_HINT_RE,
  malformedHeaderMessage,
  parseHeaders,
  parseHeadersFile,
  sectionBody,
};

// ─── CLI, so build-release.sh asks this module instead of grepping ─────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const notesPath = ['--has-version', '--tag', '--section'].includes(mode) ? argv[2] : argv[1];

  if (!mode || !notesPath) {
    console.error('usage: release-notes.js --newest <notes-file>');
    console.error('       release-notes.js --has-version <x.y.z> <notes-file>');
    console.error('       release-notes.js --tag <x.y.z> <notes-file>');
    console.error('       release-notes.js --section <x.y.z> <notes-file>');
    process.exit(2);
  }

  let parsed;
  try {
    parsed = parseHeadersFile(notesPath);
  } catch (err) {
    console.error(`  ERROR: cannot read ${notesPath}: ${err.message}`);
    process.exit(2);
  }

  // A malformed header is fatal in every mode. Answering the question while
  // ignoring a header we could not read is exactly the failure this exists
  // to prevent.
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors)
      console.error(`  ERROR: ${notesPath} line ${e.line}: ${e.message}`);
    process.exit(1);
  }

  if (mode === '--newest') {
    if (parsed.headers.length === 0) {
      console.error(`  ERROR: no release headers found in ${notesPath}.`);
      process.exit(1);
    }
    process.stdout.write(parsed.headers[0].version);
    process.exit(0);
  }

  if (mode === '--has-version') {
    process.exit(parsed.headers.some((h) => h.version === argv[1]) ? 0 : 1);
  }

  if (mode === '--tag') {
    const header = parsed.headers.find((h) => h.version === argv[1]);
    if (!header) process.exit(1);
    process.stdout.write(header.tag || '');
    process.exit(0);
  }

  if (mode === '--section') {
    const body = sectionBody(fs.readFileSync(notesPath, 'utf8'), argv[1]);
    if (!body) {
      console.error(`  ERROR: ${notesPath} has no notes for v${argv[1]}.`);
      process.exit(1);
    }
    process.stdout.write(body + '\n');
    process.exit(0);
  }

  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
