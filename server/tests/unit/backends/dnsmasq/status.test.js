import '../../../helpers/isolated-data-dir.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DNSMASQ-05: the health read must report OUR dnsmasq, not any process named
// dnsmasq on the host. `pidof` (execSync) answers yes to libvirt's or LXD's.
const execFileSync = vi.fn();
const execSync = vi.fn();
vi.mock('child_process', () => ({ execFileSync, execSync, spawnSync: vi.fn() }));

const { createDnsmasqBackend } = await import('../../../../src/backends/dnsmasq/index.js');
const backend = createDnsmasqBackend();

const enoent = () => Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
const inactive = () => Object.assign(new Error('Command failed'), { status: 3 });

beforeEach(() => {
  execFileSync.mockReset();
  execSync.mockReset();
});

describe('dnsmasq status().running', () => {
  it('asks systemd about the cidrella-dnsmasq unit and reports it active', () => {
    expect(backend.status().running).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'systemctl',
      ['is-active', '--quiet', 'cidrella-dnsmasq'],
      { stdio: 'ignore' },
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('reports a stopped unit as down even while another dnsmasq runs on the host', () => {
    execFileSync.mockImplementation(() => {
      throw inactive();
    });
    execSync.mockReturnValue(''); // pidof dnsmasq would find libvirt's
    expect(backend.status().running).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('falls back to pidof where there is no systemctl (Docker with s6)', () => {
    execFileSync.mockImplementation(() => {
      throw enoent();
    });
    expect(backend.status().running).toBe(true);
    expect(execSync).toHaveBeenCalledWith('pidof dnsmasq', { stdio: 'ignore' });

    execSync.mockImplementation(() => {
      throw new Error('no process');
    });
    expect(backend.status().running).toBe(false);
  });
});
