#!/usr/bin/env node
/**
 * build-releases-manifest.js
 *
 * Parses RELEASE-NOTES.md into a structured releases.json manifest.
 *
 * The manifest is the machine-readable view of the human-canonical
 * RELEASE-NOTES.md. It is consumed (starting in v0.4.12) by the server-side
 * update checker to compute skip-upgrade reachability, i.e. "given the
 * running version C, what is the highest version reachable in one jump?"
 * A release X is reachable from C iff X > C and (X.min_from is null or
 * X.min_from <= C).
 *
 * RELEASE-NOTES.md is authored by hand. Each release section is shaped:
 *
 *     ## v0.4.11 — 2026-04-15
 *
 *     ```yaml
 *     min_from: ""
 *     breaking: false
 *     security: true
 *     ```
 *
 *     ### New
 *     - ...
 *
 * The YAML block must immediately follow the header (with one blank line
 * between). Empty min_from means "any prior version may upgrade directly
 * to this release." Non-empty must be a semver string.
 *
 * Usage:
 *   node scripts/build-releases-manifest.js              # emit manifest to stdout
 *   node scripts/build-releases-manifest.js --out PATH   # emit to file
 *   node scripts/build-releases-manifest.js --lint       # lint only, no output
 *
 * Exit codes:
 *   0: success (or all lints passed)
 *   1: lint failure, parse failure, or I/O error
 *
 * No external dependencies, uses Node built-ins only so this runs on any
 * bundled-Node install without npm ci.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const NOTES_FILE = path.join(PROJECT_DIR, 'RELEASE-NOTES.md');
const SCHEMA_VERSION = 1;

// ─── argv ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const LINT_ONLY = args.includes('--lint');
const outIdx = args.indexOf('--out');
const OUT_PATH = outIdx >= 0 ? args[outIdx + 1] : null;

// ─── helpers ──────────────────────────────────────────────

function isSemver(s) {
  return /^\d+\.\d+\.\d+$/.test(s);
}

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

// GitHub-style header anchor. Approximation. GitHub's exact algorithm is
// more nuanced but this matches for well-formed CIDRella headers.
function anchorFor(header) {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Parse a tiny YAML block. Only supports the exact fields we emit:
// min_from (string), breaking (bool), security (bool). Quoted or unquoted
// values are both accepted. No nesting, no lists, no anchors, if someone
// authors anything more complex the linter catches it.
function parseYamlBlock(yamlText, lineOffset) {
  const result = {};
  const errors = [];
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      errors.push({ line: lineOffset + i + 1, message: `unparseable YAML line: ${raw}` });
      continue;
    }
    const key = m[1];
    let value = m[2];
    // Strip optional quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Coerce booleans
    if (value === 'true') result[key] = true;
    else if (value === 'false') result[key] = false;
    else result[key] = value;
  }
  return { result, errors };
}

// ─── parse RELEASE-NOTES.md ───────────────────────────────

function parseReleaseNotes(source) {
  const releases = [];
  const errors = [];
  const warnings = [];

  const lines = source.split('\n');

  let currentRelease = null;
  let inYamlBlock = false;
  let yamlBuffer = [];
  let yamlStartLine = 0;
  let currentSubsection = null;

  // Track which subsections have content so the linter can enforce at
  // least one of New / Fixed / Known issues per release.
  const SUBSECTIONS = ['New', 'Fixed', 'Known issues', 'Security', 'Upgrade notes', 'Recovery'];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Release header: "## v<semver> — <YYYY-MM-DD>" with optional trailing tag
    // The separator is U+2014 EM DASH, not an ASCII hyphen. Enforcing the
    // em-dash keeps the format readable and gives the linter a sharp
    // boundary to detect malformed headers.
    const headerMatch = /^##\s+v(\d+\.\d+\.\d+)\s+—\s+(\d{4}-\d{2}-\d{2})(?:\s+\[([^\]]+)\])?\s*$/.exec(line);
    if (headerMatch) {
      // Close any previous release
      if (currentRelease) releases.push(currentRelease);
      currentRelease = {
        version: headerMatch[1],
        released_at: headerMatch[2],
        tag: headerMatch[3] || null,
        header_line: lineNo,
        yaml_parsed: false,
        min_from: null,
        breaking: false,
        security: false,
        anchor: anchorFor(line.replace(/^##\s+/, '')),
        subsections_with_content: new Set(),
      };
      inYamlBlock = false;
      currentSubsection = null;
      continue;
    }

    // Level-1 heading ends the release-notes region, anything after a
    // top-level "# " is not a release section
    if (/^#\s/.test(line) && !/^##\s/.test(line)) {
      if (currentRelease) {
        releases.push(currentRelease);
        currentRelease = null;
      }
      continue;
    }

    // Horizontal rule, also closes the current release in some authoring
    // styles. We treat it as a soft boundary, not a close.

    // YAML fenced block
    if (currentRelease && !currentRelease.yaml_parsed) {
      if (/^\s*```\s*yaml\s*$/.test(line)) {
        inYamlBlock = true;
        yamlBuffer = [];
        yamlStartLine = lineNo;
        continue;
      }
      if (inYamlBlock && /^\s*```\s*$/.test(line)) {
        // End of YAML block, parse it
        const { result: parsed, errors: yamlErrors } = parseYamlBlock(
          yamlBuffer.join('\n'),
          yamlStartLine
        );
        for (const e of yamlErrors) {
          errors.push({
            version: currentRelease.version,
            line: e.line,
            message: `[${currentRelease.version}] ${e.message}`,
          });
        }
        if (parsed.min_from !== undefined) {
          currentRelease.min_from = parsed.min_from === '' ? null : parsed.min_from;
        }
        if (parsed.breaking !== undefined) currentRelease.breaking = !!parsed.breaking;
        if (parsed.security !== undefined) currentRelease.security = !!parsed.security;
        currentRelease.yaml_parsed = true;
        inYamlBlock = false;
        continue;
      }
      if (inYamlBlock) {
        yamlBuffer.push(line);
        continue;
      }
    }

    // Level-3 subsection tracking, so the linter can enforce "at least
    // one non-empty New/Fixed/Known issues" per release.
    if (currentRelease) {
      const subMatch = /^###\s+(.+?)\s*$/.exec(line);
      if (subMatch) {
        currentSubsection = subMatch[1].trim();
        continue;
      }
      if (currentSubsection && line.trim() && !line.startsWith('#')) {
        if (SUBSECTIONS.includes(currentSubsection)) {
          currentRelease.subsections_with_content.add(currentSubsection);
        }
      }
    }
  }

  // Close trailing release
  if (currentRelease) releases.push(currentRelease);

  return { releases, errors, warnings };
}

// ─── lint ─────────────────────────────────────────────────

function lint(releases, errors, _warnings) {
  const issues = [...errors];
  if (releases.length === 0) {
    issues.push({ message: 'No release sections found in RELEASE-NOTES.md. Check header format: `## vX.Y.Z — YYYY-MM-DD` (with em-dash).' });
    return issues;
  }

  // 1. Every release must have a YAML block
  for (const r of releases) {
    if (!r.yaml_parsed) {
      issues.push({
        version: r.version,
        line: r.header_line,
        message: `[${r.version}] missing YAML metadata block immediately after header`,
      });
    }
  }

  // 2. min_from must be null or valid semver
  for (const r of releases) {
    if (r.min_from !== null && !isSemver(r.min_from)) {
      issues.push({
        version: r.version,
        line: r.header_line,
        message: `[${r.version}] min_from must be empty or valid semver; got "${r.min_from}"`,
      });
    }
  }

  // 3. min_from must point at an existing version in this file
  const versionSet = new Set(releases.map(r => r.version));
  for (const r of releases) {
    if (r.min_from && !versionSet.has(r.min_from)) {
      issues.push({
        version: r.version,
        line: r.header_line,
        message: `[${r.version}] min_from "${r.min_from}" does not match any release in RELEASE-NOTES.md`,
      });
    }
  }

  // 4. min_from must be strictly less than the release itself
  for (const r of releases) {
    if (r.min_from && compareSemver(r.min_from, r.version) >= 0) {
      issues.push({
        version: r.version,
        line: r.header_line,
        message: `[${r.version}] min_from "${r.min_from}" must be strictly less than this release's version`,
      });
    }
  }

  // 5. Versions must appear in descending order (newest first)
  for (let i = 1; i < releases.length; i++) {
    if (compareSemver(releases[i - 1].version, releases[i].version) <= 0) {
      issues.push({
        version: releases[i].version,
        line: releases[i].header_line,
        message: `[${releases[i].version}] out of order, releases must be listed newest first. Previous was ${releases[i - 1].version}.`,
      });
    }
  }

  // 6. Every release needs at least one non-empty New / Fixed / Known issues
  for (const r of releases) {
    const required = ['New', 'Fixed', 'Known issues'];
    const present = required.filter(s => r.subsections_with_content.has(s));
    if (present.length === 0) {
      issues.push({
        version: r.version,
        line: r.header_line,
        message: `[${r.version}] must have at least one non-empty "### New", "### Fixed", or "### Known issues" subsection`,
      });
    }
  }

  return issues;
}

// ─── main ─────────────────────────────────────────────────

function main() {
  let source;
  try {
    source = fs.readFileSync(NOTES_FILE, 'utf8');
  } catch (err) {
    console.error(`ERROR: cannot read ${NOTES_FILE}: ${err.message}`);
    process.exit(1);
  }

  const { releases, errors, warnings } = parseReleaseNotes(source);
  const issues = lint(releases, errors, warnings);

  if (LINT_ONLY) {
    if (issues.length > 0) {
      console.error(`RELEASE-NOTES.md lint: ${issues.length} issue(s)`);
      for (const iss of issues) {
        const loc = iss.line ? `line ${iss.line}: ` : '';
        console.error(`  ${loc}${iss.message}`);
      }
      process.exit(1);
    }
    console.error(`RELEASE-NOTES.md lint: OK (${releases.length} release${releases.length === 1 ? '' : 's'} parsed)`);
    process.exit(0);
  }

  // If there are hard errors, refuse to emit a manifest even without --lint
  if (issues.length > 0) {
    console.error(`RELEASE-NOTES.md has ${issues.length} lint issue(s); refusing to emit manifest. Run with --lint to see details.`);
    for (const iss of issues) {
      const loc = iss.line ? `line ${iss.line}: ` : '';
      console.error(`  ${loc}${iss.message}`);
    }
    process.exit(1);
  }

  const manifest = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    releases: releases.map(r => ({
      version: r.version,
      released_at: r.released_at,
      min_from: r.min_from,
      breaking: r.breaking,
      security: r.security,
      anchor: r.anchor,
    })),
  };

  const json = JSON.stringify(manifest, null, 2) + '\n';
  if (OUT_PATH) {
    fs.writeFileSync(OUT_PATH, json, 'utf8');
    console.error(`Wrote ${OUT_PATH} (${releases.length} releases)`);
  } else {
    process.stdout.write(json);
  }
}

main();
