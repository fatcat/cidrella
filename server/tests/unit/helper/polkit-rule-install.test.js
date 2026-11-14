/**
 * install_polkit_rule (scripts/lib/systemd-install.sh), the one way install.sh,
 * update.sh and deploy-lxc.sh write the helper's polkit rule. polkitd reloads
 * on the first change in rules.d, so a rule written in place is read
 * half-written (POLKIT-WRITE-01): a changed rule must arrive as a new file
 * renamed over the old one, never as a rewrite of it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIB = path.join(REPO_ROOT, 'scripts/lib/systemd-install.sh');
const RULE = path.join(REPO_ROOT, 'scripts/polkit/49-cidrella.rules');

let dir;
let rulesDir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polkit-rule-'));
  rulesDir = path.join(dir, 'rules.d');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Runs the function as the lib's callers do; resolves { code, stdout }.
function installRule(src) {
  try {
    const stdout = execFileSync(
      'bash',
      ['-c', '. "$1" && install_polkit_rule "$2" "$3"', 'bash', LIB, src, rulesDir],
      { encoding: 'utf8' },
    );
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout };
  }
}

const installed = () => path.join(rulesDir, '49-cidrella.rules');

describe('install_polkit_rule', () => {
  it('installs the rule 0644, making the directory, and leaves no temp file', () => {
    expect(installRule(RULE)).toEqual({ code: 0, stdout: 'changed\n' });
    expect(fs.readFileSync(installed(), 'utf8')).toBe(fs.readFileSync(RULE, 'utf8'));
    expect(fs.statSync(installed()).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(rulesDir)).toEqual(['49-cidrella.rules']);
  });

  it('writes nothing when the installed rule already matches, so polkit does not reload', () => {
    installRule(RULE);
    const before = fs.statSync(installed());
    expect(installRule(RULE)).toEqual({ code: 0, stdout: '' });
    const after = fs.statSync(installed());
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });

  it('swaps a changed rule in whole: a new file renamed over the old one', () => {
    const edited = path.join(dir, '49-cidrella.rules');
    fs.writeFileSync(edited, '// an older or hand-edited rule\n');
    installRule(edited);
    const old = fs.statSync(installed()).ino;

    expect(installRule(RULE)).toEqual({ code: 0, stdout: 'changed\n' });
    expect(fs.readFileSync(installed(), 'utf8')).toBe(fs.readFileSync(RULE, 'utf8'));
    expect(fs.statSync(installed()).ino).not.toBe(old);
    expect(fs.readdirSync(rulesDir)).toEqual(['49-cidrella.rules']);
  });

  it('fails, touching nothing, when the source is missing', () => {
    expect(installRule(path.join(dir, 'missing.rules')).code).toBe(1);
    expect(fs.existsSync(rulesDir)).toBe(false);
  });
});
