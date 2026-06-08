import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

let settings = {};
vi.mock('../../../src/db/init.js', () => ({
  getSetting: (k) => settings[k],
}));

vi.mock('../../../src/utils/dnsmasq.js', () => ({
  signalDnsmasq: vi.fn(),
}));

import { execFileSync } from 'child_process';
import {
  getNtpStatus, ensureNtpEnabled, armDnssecTimecheckWhenSynced, stopTimesync,
} from '../../../src/utils/timesync.js';
import { signalDnsmasq } from '../../../src/utils/dnsmasq.js';

beforeEach(() => {
  vi.clearAllMocks();
  settings = {};
  stopTimesync();
});

describe('getNtpStatus', () => {
  it('parses enabled + synchronized', () => {
    vi.mocked(execFileSync).mockReturnValue('yes\nyes\n');
    expect(getNtpStatus()).toEqual({ available: true, ntpEnabled: true, synchronized: true });
  });

  it('parses disabled + unsynchronized', () => {
    vi.mocked(execFileSync).mockReturnValue('no\nno\n');
    expect(getNtpStatus()).toEqual({ available: true, ntpEnabled: false, synchronized: false });
  });

  it('parses enabled but not yet synchronized', () => {
    vi.mocked(execFileSync).mockReturnValue('yes\nno\n');
    expect(getNtpStatus()).toEqual({ available: true, ntpEnabled: true, synchronized: false });
  });

  it('reports unavailable when timedatectl is missing/errors', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(getNtpStatus()).toEqual({ available: false, ntpEnabled: false, synchronized: false });
  });
});

describe('ensureNtpEnabled', () => {
  it('is a no-op (returns false) when timedatectl is unavailable', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(ensureNtpEnabled()).toBe(false);
    // never attempted set-ntp
    expect(execFileSync).not.toHaveBeenCalledWith('timedatectl', ['set-ntp', 'true'], expect.anything());
  });

  it('does not call set-ntp when NTP is already enabled', () => {
    vi.mocked(execFileSync).mockReturnValue('yes\nyes\n');
    expect(ensureNtpEnabled()).toBe(true);
    expect(execFileSync).not.toHaveBeenCalledWith('timedatectl', ['set-ntp', 'true'], expect.anything());
  });

  it('enables NTP when disabled', () => {
    vi.mocked(execFileSync).mockReturnValue('no\nno\n');
    expect(ensureNtpEnabled()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('timedatectl', ['set-ntp', 'true'], { stdio: 'pipe' });
  });
});

describe('armDnssecTimecheckWhenSynced', () => {
  it('SIGHUPs dnsmasq immediately when already synchronized', () => {
    settings.dnssec_enabled = 'true';
    vi.mocked(execFileSync).mockReturnValue('yes\nyes\n');
    armDnssecTimecheckWhenSynced();
    expect(signalDnsmasq).toHaveBeenCalledTimes(1);
    stopTimesync();
  });

  it('does nothing when DNSSEC is disabled', () => {
    settings.dnssec_enabled = 'false';
    vi.mocked(execFileSync).mockReturnValue('yes\nyes\n');
    armDnssecTimecheckWhenSynced();
    expect(signalDnsmasq).not.toHaveBeenCalled();
  });

  it('does not SIGHUP while the clock is unsynchronized', () => {
    settings.dnssec_enabled = 'true';
    vi.mocked(execFileSync).mockReturnValue('yes\nno\n');
    armDnssecTimecheckWhenSynced();
    expect(signalDnsmasq).not.toHaveBeenCalled();
    stopTimesync();
  });
});
