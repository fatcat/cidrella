/**
 * createUnitControl without systemctl (Docker): s6 supervises the daemon,
 * and a daemon kept down until wanted (Kea) waits on its enable file.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('child_process', () => ({ execFileSync }));

const { createUnitControl } = await import('../../../src/backends/shared/unit-control.js');

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

  it('enables a daemon that is waiting, with no restart left pending', () => {
    host({ running: false });
    const unit = control();
    unit.restart();
    expect(fs.existsSync(enableFile)).toBe(true);
    expect(unit.restartPending()).toBe(false);
  });

  it('restarts a running daemon by TERM and keeps it enabled', () => {
    host({ running: true });
    control().restart();
    expect(execFileSync).toHaveBeenCalledWith('pkill', ['-TERM', '-x', 'kea-dhcp4'], {
      stdio: 'pipe',
    });
    expect(fs.existsSync(enableFile)).toBe(true);
  });

  it('stops by removing the file first, so s6 does not start it again', () => {
    host({ running: true });
    const unit = control();
    unit.restart();
    unit.stop();
    expect(fs.existsSync(enableFile)).toBe(false);
    expect(execFileSync).toHaveBeenLastCalledWith('pkill', ['-TERM', '-x', 'kea-dhcp4'], {
      stdio: 'pipe',
    });
  });

  it('marks a restart pending for a daemon with no enable file that is not running', () => {
    host({ running: false });
    const unit = createUnitControl({ unit: 'cidrella-dnsmasq', processName: 'dnsmasq', restartPendingFile });
    unit.restart();
    expect(unit.restartPending()).toBe(true);
  });

  it('touches no file under systemd', () => {
    execFileSync.mockImplementation(() => {});
    control().restart();
    expect(fs.existsSync(enableFile)).toBe(false);
  });
});
