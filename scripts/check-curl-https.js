#!/usr/bin/env node
'use strict';
/**
 * Guard: a curl that follows redirects in a shell script stays on HTTPS.
 *
 * `curl -L` follows a redirect to any protocol, so an https:// URL can end on
 * plain http:// if something in the path answers with a redirect.
 * Every download the install, update and build scripts make is checked
 * afterwards (minisign, a key fingerprint, SHA-256), but the checksum file is
 * fetched the same way, so the transport should not be the weak link.
 * scripts/lib/rotation.sh set the rule: `--proto '=https' --proto-redir '=https'`.
 *
 * Checked: every curl in scripts/**\/*.sh given -L or --location (a backslash
 * continuation is joined first). A curl that does not follow redirects, such
 * as a health probe of 127.0.0.1, is left alone. CURL-PROTO-01.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const CURL_RE = /(?:^|[\s;&|(`])curl\s/;
const FOLLOWS_RE = /\s(?:-[a-zA-Z]*L[a-zA-Z]*|--location)(?=\s|$)/;
const REQUIRED = ["--proto '=https'", "--proto-redir '=https'"];

function shellFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : shellFiles(full);
    return entry.name.endsWith('.sh') ? [full] : [];
  });
}

// One logical command per entry, with the line it starts on.
function commands(text) {
  const out = [];
  let start = 0;
  let buffer = '';
  text.split('\n').forEach((line, i) => {
    if (!buffer) start = i + 1;
    if (/^\s*#/.test(line)) return;
    if (line.endsWith('\\')) {
      buffer += line.slice(0, -1) + ' ';
      return;
    }
    out.push({ line: start, text: buffer + line });
    buffer = '';
  });
  return out;
}

/** The problems in one script's text, as `line: message`. */
function curlProblems(text) {
  const problems = [];
  for (const { line, text: command } of commands(text)) {
    if (!CURL_RE.test(command) || !FOLLOWS_RE.test(command)) continue;
    const missing = REQUIRED.filter((flag) => !command.includes(flag));
    if (missing.length) problems.push(`${line}: curl -L without ${missing.join(' ')}`);
  }
  return problems;
}

function main() {
  const problems = shellFiles(SCRIPTS).flatMap((file) =>
    curlProblems(fs.readFileSync(file, 'utf8')).map((p) => `${path.relative(ROOT, file)}:${p}`),
  );
  if (problems.length) {
    console.error(
      'A curl that follows redirects must stay on HTTPS (see scripts/lib/rotation.sh):',
    );
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('  Curl HTTPS check OK (every redirect-following curl is HTTPS-only)');
}

if (require.main === module) main();

module.exports = { curlProblems };
