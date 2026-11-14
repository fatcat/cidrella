import '../../../helpers/isolated-data-dir.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DNSMASQ-05: the health read must report OUR dnsmasq, not any process named
// dnsmasq on the host. `pidof` answers yes to libvirt's or LXD's.
const { execFileSync, execSync } = vi.hoisted(() => ({ execFileSync: vi.fn(), execSync: vi.fn() }));
vi.mock('child_process', () => ({ execFileSync, execSync, spawnSync: vi.fn() }));
vi.mock('../../../../src/utils/run-command.js', async () =>
  (await import('../../../helpers/fake-run-command.js')).fakeRunCommandModule(execFileSync),
);

const { createDnsmasqBackend } = await import('../../../../src/backends/dnsmasq/index.js');
const backend = createDnsmasqBackend();

const enoent = () => Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
const inactive = () => Object.assign(new Error('Command failed'), { status: 3 });

beforeEach(() => {
  execFileSync.mockReset();
  execSync.mockReset();
});

describe('dnsmasq status().running', () => {
  it('asks systemd about the cidrella-dnsmasq unit and reports it active', async () => {
    expect((await backend.status()).running).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'systemctl',
      ['is-active', '--quiet', 'cidrella-dnsmasq'],
      expect.anything(),
    );
  });

  it('reports a stopped unit as down even while another dnsmasq runs on the host', async () => {
    execFileSync.mockImplementation((cmd) => {
      if (cmd === 'systemctl') throw inactive();
      return ''; // pidof dnsmasq would find libvirt's
    });
    expect((await backend.status()).running).toBe(false);
    expect(execFileSync).not.toHaveBeenCalledWith('pidof', expect.anything(), expect.anything());
  });

  it('falls back to pidof where there is no systemctl (Docker with s6)', async () => {
    let pidofAnswers = true;
    execFileSync.mockImplementation((cmd) => {
      if (cmd === 'systemctl') throw enoent();
      if (!pidofAnswers) throw new Error('no process');
      return '';
    });
    expect((await backend.status()).running).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('pidof', ['dnsmasq'], expect.anything());

    pidofAnswers = false;
    expect((await backend.status()).running).toBe(false);
  });
});
