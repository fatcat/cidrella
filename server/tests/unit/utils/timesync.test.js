import { describe, it, expect, beforeEach, vi } from 'vitest';

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/run-command.js', async () =>
  (await import('../../helpers/fake-run-command.js')).fakeRunCommandModule(execFileSync),
);

let settings = {};
vi.mock('../../../src/db/init.js', () => ({
  getSetting: (k) => settings[k],
}));

const onClockSynchronized = vi.fn();
vi.mock('../../../src/backends/index.js', () => ({
  getDnsBackend: () => ({ onClockSynchronized }),
}));

import {
  getNtpStatus,
  ensureNtpEnabled,
  armDnssecTimecheckWhenSynced,
  stopTimesync,
} from '../../../src/utils/timesync.js';

beforeEach(() => {
  vi.clearAllMocks();
  settings = {};
  stopTimesync();
});

describe('getNtpStatus', () => {
  it('parses enabled + synchronized', async () => {
    vi.mocked(execFileSync).mockReturnValue('yes\nyes\n');
    expect(await getNtpStatus()).toEqual({ available: true, ntpEnabled: true, synchronized: true });
  });

  it('parses disabled + unsynchronized', async () => {
    vi.mocked(execFileSync).mockReturnValue('no\nno\n');
    expect(await getNtpStatus()).toEqual({ available: true, ntpEnabled: false, synchronized: false });
  });

  it('parses enabled but not yet synchronized', async () => {
    vi.mocked(execFileSync).mockReturnValue('yes\nno\n');
    expect(await getNtpStatus()).toEqual({ available: true, ntpEnabled: true, synchronized: false });
  });

  it('reports unavailable when timedatectl is missing/errors', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(await getNtpStatus()).toEqual({ available: false, ntpEnabled: false, synchronized: false });
  });
});

describe('ensureNtpEnabled', () => {
  it('is a no-op (returns false) when timedatectl is unavailable', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(await ensureNtpEnabled()).toBe(false);
    // never attempted set-ntp
    expect(execFileSync).not.toHaveBeenCalledWith(
      'timedatectl',
      ['set-ntp', 'true'],
      expect.anything(),
    );
  });

  it('does not call set-ntp when NTP is already enabled', async () => {
    vi.mocked(execFileSync).mockReturnValue('yes\nyes\n');
    expect(await ensureNtpEnabled()).toBe(true);
    expect(execFileSync).not.toHaveBeenCalledWith(
      'timedatectl',
      ['set-ntp', 'true'],
      expect.anything(),
    );
  });

  it('enables NTP when disabled', async () => {
    vi.mocked(execFileSync).mockReturnValue('no\nno\n');
    expect(await ensureNtpEnabled()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('timedatectl', ['set-ntp', 'true'], {});
  });
});

describe('armDnssecTimecheckWhenSynced', () => {
  it('SIGHUPs dnsmasq immediately when already synchronized', async () => {
    settings.dnssec_enabled = 'true';
    vi.mocked(execFileSync).mockReturnValue('yes\nyes\n');
    armDnssecTimecheckWhenSynced();
    await vi.waitFor(() => expect(onClockSynchronized).toHaveBeenCalledTimes(1));
    stopTimesync();
  });

  it('does nothing when DNSSEC is disabled', async () => {
    settings.dnssec_enabled = 'false';
    vi.mocked(execFileSync).mockReturnValue('yes\nyes\n');
    armDnssecTimecheckWhenSynced();
    expect(onClockSynchronized).not.toHaveBeenCalled();
  });

  it('does not SIGHUP while the clock is unsynchronized', async () => {
    settings.dnssec_enabled = 'true';
    vi.mocked(execFileSync).mockReturnValue('yes\nno\n');
    armDnssecTimecheckWhenSynced();
    await vi.waitFor(() => expect(execFileSync).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
    expect(onClockSynchronized).not.toHaveBeenCalled();
    stopTimesync();
  });
});
