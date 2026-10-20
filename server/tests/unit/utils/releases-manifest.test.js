/**
 * scripts/build-releases-manifest.js leaves a version marked [pre-release]
 * out of the signed manifest (it has no final tarball, so the update checker
 * must never offer it), keeps it with --all for the build's own min_from
 * lookup, and refuses an unknown tag or a final release whose min_from only
 * ever was a pre-release. release-notes.js --tag reports the tag to
 * build-release.sh, and --section prints a version's notes for its release page.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MANIFEST = path.join(REPO_ROOT, 'scripts/build-releases-manifest.js');
const NOTES_LIB = path.join(REPO_ROOT, 'scripts/lib/release-notes.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const section = (heading, minFrom = '') =>
  [
    heading,
    '',
    '```yaml',
    `min_from: "${minFrom}"`,
    'breaking: false',
    'security: false',
    '```',
    '',
    '### New',
    '- Something.',
    '',
  ].join('\n');

function notes(...sections) {
  const file = path.join(dir, `notes-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(file, ['# Release notes', '', ...sections].join('\n'));
  return file;
}

const versions = (file, ...flags) =>
  JSON.parse(
    execFileSync('node', [MANIFEST, '--notes', file, ...flags], { encoding: 'utf8' }),
  ).releases.map((r) => r.version);

describe('releases.json and pre-release-only versions', () => {
  const file = notes(
    section('## v0.6.0 — 2026-11-01', '0.5.0'),
    section('## v0.5.3 — 2026-10-10 [pre-release]', '0.5.0'),
    section('## v0.5.0 — 2026-10-08'),
  );

  it('leaves a [pre-release] version out, and keeps it with --all', () => {
    expect(versions(file)).toEqual(['0.6.0', '0.5.0']);
    expect(versions(file, '--all')).toEqual(['0.6.0', '0.5.3', '0.5.0']);
  });

  it('refuses a final release whose min_from was only a pre-release, and an unknown tag', () => {
    for (const [bad, message] of [
      [
        notes(
          section('## v0.6.0 — 2026-11-01', '0.5.3'),
          section('## v0.5.3 — 2026-10-10 [pre-release]'),
        ),
        'was only ever a pre-release',
      ],
      [notes(section('## v0.6.0 — 2026-11-01 [prerelease]')), 'unknown header tag'],
    ]) {
      const run = spawnSync('node', [MANIFEST, '--notes', bad, '--lint'], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(message);
    }
  });

  it('tells build-release.sh the tag of a version', () => {
    const tag = (v) => execFileSync('node', [NOTES_LIB, '--tag', v, file], { encoding: 'utf8' });
    expect(tag('0.5.3')).toBe('pre-release');
    expect(tag('0.6.0')).toBe('');
    expect(spawnSync('node', [NOTES_LIB, '--tag', '0.9.9', file]).status).toBe(1);
  });
});

describe('release-notes.js --section', () => {
  const sectionOf = (v) =>
    spawnSync('node', [NOTES_LIB, '--section', v, file], { encoding: 'utf8' });
  const file = notes(
    [
      '## v0.6.0 — 2026-11-01',
      '',
      '```yaml',
      'min_from: "0.5.0"',
      'breaking: false',
      'security: false',
      '```',
      '',
      'The stack switch.',
      '',
      '### New',
      '- A thing.',
      '',
      '---',
      '',
    ].join('\n'),
    section('## v0.5.0 — 2026-10-08'),
  );

  it('prints the prose under a heading, without the heading, YAML block or separator', () => {
    const run = sectionOf('0.6.0');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('The stack switch.\n\n### New\n- A thing.\n');
  });

  it('stops at the next release and reads the last one to the end of the file', () => {
    expect(sectionOf('0.5.0').stdout).toBe('### New\n- Something.\n');
  });

  it('fails for a version the notes do not have', () => {
    const run = sectionOf('0.9.9');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no notes for v0.9.9');
  });
});
