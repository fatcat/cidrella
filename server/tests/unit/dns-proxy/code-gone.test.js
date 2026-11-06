import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CODE_GONE_EXIT, proxyCodeGone } from '../../../src/dns-proxy/code-gone.js';

const ENTRY = 'server/src/dns-proxy/main.js';

describe('proxyCodeGone', () => {
  let root;
  let install;
  const slot = (name) => `${install}-${name}`;
  const point = (target) => {
    fs.rmSync(install, { force: true });
    fs.symlinkSync(target, install);
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-gone-')));
    install = path.join(root, 'cidrella');
    // Slot a is the old release, with no proxy; slot b has one.
    fs.mkdirSync(slot('a'));
    fs.mkdirSync(path.dirname(path.join(slot('b'), ENTRY)), { recursive: true });
    fs.writeFileSync(path.join(slot('b'), ENTRY), '');
    point(slot('b'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sees a rollback, though the slot the proxy came from is still there', () => {
    const entry = path.join(slot('b'), ENTRY);
    expect(proxyCodeGone(entry, install)).toBe(false);

    point(slot('a'));

    expect(fs.existsSync(entry)).toBe(true);
    expect(proxyCodeGone(entry, install)).toBe(true);
  });

  it('stays when the other slot has a proxy too', () => {
    const entry = path.join(slot('b'), ENTRY);
    fs.mkdirSync(path.dirname(path.join(slot('a'), ENTRY)), { recursive: true });
    fs.writeFileSync(path.join(slot('a'), ENTRY), '');

    point(slot('a'));

    expect(proxyCodeGone(entry, install)).toBe(false);
  });

  it('reads the entry Node really gives a process started through the symlink', () => {
    fs.writeFileSync(path.join(slot('b'), 'argv.js'), 'console.log(process.argv[1])');
    const argv = execFileSync(process.execPath, ['argv.js'], { cwd: install, encoding: 'utf8' });
    expect(argv.trim()).toBe(path.join(slot('b'), 'argv.js'));
    expect(proxyCodeGone(argv.trim(), install)).toBe(false);

    point(slot('a'));

    expect(proxyCodeGone(argv.trim(), install)).toBe(true);
  });

  it('handles an install that is a plain directory', () => {
    fs.rmSync(install);
    fs.mkdirSync(path.dirname(path.join(install, ENTRY)), { recursive: true });
    fs.writeFileSync(path.join(install, ENTRY), '');
    expect(proxyCodeGone(path.join(install, ENTRY), install)).toBe(false);

    fs.rmSync(path.join(install, ENTRY));

    expect(proxyCodeGone(path.join(install, ENTRY), install)).toBe(true);
  });

  it('watches the entry itself outside an install', () => {
    const entry = path.join(root, 'app', ENTRY);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');
    expect(proxyCodeGone(entry, install)).toBe(false);

    fs.rmSync(entry);

    expect(proxyCodeGone(entry, install)).toBe(true);
  });

  it('does not take a sibling directory for the install', () => {
    const entry = path.join(`${install}-dev`, ENTRY);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');

    point(slot('a'));

    expect(proxyCodeGone(entry, install)).toBe(false);
  });
});

describe('the unit and the exit status', () => {
  const unit = fs.readFileSync(
    new URL('../../../../scripts/systemd/cidrella-dns-proxy.service', import.meta.url),
    'utf8',
  );
  const statuses = (key) =>
    unit
      .match(new RegExp(`^${key}=(.*)$`, 'm'))[1]
      .trim()
      .split(/\s+/)
      .map(Number);

  it('does not restart the proxy when its code is gone', () => {
    expect(statuses('RestartPreventExitStatus')).toContain(CODE_GONE_EXIT);
  });

  it('counts it as a clean stop, not a failed unit', () => {
    expect(statuses('SuccessExitStatus')).toContain(CODE_GONE_EXIT);
  });

  it('still restarts on the exit the web app asks for', () => {
    expect(statuses('RestartPreventExitStatus')).not.toContain(0);
  });
});
