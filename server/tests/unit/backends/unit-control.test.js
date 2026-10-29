/**
 * createUnitControl without systemctl (Docker): s6 supervises the daemon,
 * and a daemon kept down until wanted (Kea) waits on its enable file.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('../../../src/utils/run-command.js', async () =>
  (await import('../../helpers/fake-run-command.js')).fakeRunCommandModule(execFileSync),
);

const { createUnitControl } = await import('../../../src/backends/shared/unit-control.js');
const { unitEvents } = await import('../../../src/backends/shared/unit-events.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-control-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const enableFile = path.join(dir, 'runtime', 'kea-dhcp4.enabled');
const restartPendingFile = path.join(dir, 'runtime', 'restart-pending');

const noSystemctl = Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
const notRunning = Object.assign(new Error('pkill: no process'), { status: 1 });

// No systemctl; pkill finds the daemon or not.
function host({ running }) {
  execFileSync.mockImplementation((cmd) => {
    if (cmd === 'systemctl') throw noSystemctl;
    if (cmd === 'pkill' && !running) throw notRunning;
  });
}

beforeEach(() => {
  execFileSync.mockReset();
  fs.rmSync(path.join(dir, 'runtime'), { recursive: true, force: true });
});

describe('createUnitControl under s6', () => {
  const control = () =>
    createUnitControl({
      unit: 'cidrella-kea@dhcp4',
      processName: 'kea-dhcp4',
      restartPendingFile,
      enableFile,
    });

  it('enables a daemon that is waiting, with no restart left pending', async () => {
    host({ running: false });
    const unit = control();
    await unit.restart();
    expect(fs.existsSync(enableFile)).toBe(true);
    expect(unit.restartPending()).toBe(false);
  });

  it('restarts a running daemon by TERM and keeps it enabled', async () => {
    host({ running: true });
    await control().restart();
    expect(execFileSync).toHaveBeenCalledWith('pkill', ['-TERM', '-x', 'kea-dhcp4'], expect.any(Object));
    expect(fs.existsSync(enableFile)).toBe(true);
  });

  it('stops by removing the file first, so s6 does not start it again', async () => {
    host({ running: true });
    const unit = control();
    await unit.restart();
    await unit.stop();
    expect(fs.existsSync(enableFile)).toBe(false);
    expect(execFileSync).toHaveBeenLastCalledWith('pkill', ['-TERM', '-x', 'kea-dhcp4'], expect.any(Object));
  });

  it('marks a restart pending for a daemon with no enable file that is not running', async () => {
    host({ running: false });
    const unit = createUnitControl({
      unit: 'cidrella-dnsmasq',
      processName: 'dnsmasq',
      restartPendingFile,
    });
    await unit.restart();
    expect(unit.restartPending()).toBe(true);
  });

  it('touches no file under systemd', async () => {
    execFileSync.mockImplementation(() => {});
    await control().restart();
    expect(fs.existsSync(enableFile)).toBe(false);
  });
});

describe('createUnitControl with a disable flag (dnsmasq)', () => {
  const disableFile = path.join(dir, 'runtime', 'dnsmasq.disabled');
  const control = () =>
    createUnitControl({
      unit: 'cidrella-dnsmasq',
      processName: 'dnsmasq',
      restartPendingFile,
      disableFile,
    });

  it('stop sets the flag under systemd too, so the unit stays down at boot', async () => {
    execFileSync.mockImplementation(() => {});
    await control().stop();
    expect(fs.existsSync(disableFile)).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['stop', 'cidrella-dnsmasq'], expect.any(Object));
  });

  it('restart clears the flag before asking systemctl, whose start condition reads it', async () => {
    let flagAtRestart;
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'systemctl' && args[0] === 'restart') flagAtRestart = fs.existsSync(disableFile);
    });
    const unit = control();
    await unit.stop();
    await unit.restart();
    expect(flagAtRestart).toBe(false);
    expect(unit.restartPending()).toBe(false);
  });

  it('under s6 a stopped daemon waits, with no restart left pending', async () => {
    host({ running: false });
    const unit = control();
    await unit.stop();
    await unit.restart();
    expect(fs.existsSync(disableFile)).toBe(false);
    expect(unit.restartPending()).toBe(false);
  });
});

describe('awaitStopped', () => {
  const unit = () =>
    createUnitControl({ unit: 'cidrella-dnsmasq', processName: 'dnsmasq', restartPendingFile });

  it('returns once the daemon has exited', async () => {
    let checks = 0;
    execFileSync.mockImplementation((cmd) => {
      if (cmd === 'systemctl') throw noSystemctl;
      if (cmd === 'pidof' && ++checks >= 3) throw notRunning;
    });
    await unit().awaitStopped({ timeoutMs: 2000, intervalMs: 1 });
    expect(checks).toBe(3);
  });

  it('names the daemon when it outlives the timeout', async () => {
    host({ running: true });
    await expect(unit().awaitStopped({ timeoutMs: 20, intervalMs: 5 })).rejects.toThrow(
      /dnsmasq is still running/,
    );
  });
});

describe('createUnitControl under systemd', () => {
  const control = () =>
    createUnitControl({ unit: 'cidrella-dnsmasq', processName: 'dnsmasq', restartPendingFile });

  it('never sends a TERM by name when systemctl refuses a stop', async () => {
    execFileSync.mockImplementation((cmd) => {
      if (cmd === 'systemctl') {
        throw Object.assign(new Error('Unit cidrella-dnsmasq.service not loaded.'), {
          status: 5,
          stderr: Buffer.from('Unit cidrella-dnsmasq.service not loaded.'),
        });
      }
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await control().stop();
    warn.mockRestore();
    expect(execFileSync.mock.calls.map(([cmd]) => cmd)).toEqual(['systemctl']);
  });

  it('says whether the unit is installed here', async () => {
    execFileSync.mockReturnValueOnce(Buffer.from('loaded\n'));
    expect(await control().installed()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'systemctl',
      ['show', '-p', 'LoadState', '--value', 'cidrella-dnsmasq'],
      expect.anything(),
    );
    execFileSync.mockReturnValueOnce(Buffer.from('not-found\n'));
    expect(await control().installed()).toBe(false);
  });

  it('counts the daemon as installed where s6 runs it', async () => {
    host({ running: false });
    expect(await control().installed()).toBe(true);
  });
});

describe('the events a daemon change emits', () => {
  const control = () =>
    createUnitControl({ unit: 'cidrella-dnsmasq', processName: 'dnsmasq', restartPendingFile });
  let seen;
  const listen = (event) => seen.push(event.action);
  beforeEach(() => {
    seen = [];
    unitEvents.on('unit', listen);
  });
  afterEach(() => unitEvents.off('unit', listen));

  it('says restarted after systemctl restarts it, and stopped after it stops', async () => {
    execFileSync.mockImplementation(() => Buffer.from(''));
    await control().restart();
    await control().stop();
    expect(seen).toEqual(['restarted', 'stopped']);
  });

  it('says restart_failed when neither systemctl nor a signal can restart it', async () => {
    host({ running: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await control().restart();
    warn.mockRestore();
    expect(seen).toEqual(['restart_failed']);
  });

  it('says nothing for a reload', async () => {
    execFileSync.mockImplementation(() => Buffer.from(''));
    await control().reload();
    expect(seen).toEqual([]);
  });
});

describe('a hung systemctl', () => {
  it('counts as a failed restart once it times out, never a wait forever', async () => {
    execFileSync.mockImplementation((cmd, args, options) => {
      if (cmd === 'systemctl' && args[0] === 'restart') {
        expect(options.timeout).toBeGreaterThan(0);
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true });
      }
      if (cmd === 'pkill') throw notRunning;
    });
    const unit = createUnitControl({
      unit: 'cidrella-dnsmasq',
      processName: 'dnsmasq',
      restartPendingFile,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await unit.restart();
    warn.mockRestore();
    expect(unit.restartPending()).toBe(true);
  });
});
