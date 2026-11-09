/**
 * The watchdog's restart of the DNS proxy unit: reset-failed first (a unit
 * past its start limit refuses a start), then start, both through the
 * privileged helper.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const { unitCommand } = vi.hoisted(() => ({ unitCommand: vi.fn() }));
vi.mock('../../../src/utils/privileged.js', () => ({ unitCommand }));

const { restartProxyProcess, PROXY_UNIT } = await import(
  '../../../src/services/dns-proxy-supervisor.js'
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  unitCommand.mockReset();
});

describe('restartProxyProcess', () => {
  it('resets and starts the unit under systemd', async () => {
    vi.stubEnv('CIDRELLA_DNS_PROXY_SUPERVISOR', 'systemd');
    unitCommand.mockResolvedValue({ ok: true, code: 0, stdout: '', stderr: '' });
    await restartProxyProcess(null);
    expect(unitCommand.mock.calls).toEqual([
      ['reset-failed', PROXY_UNIT],
      ['start', PROXY_UNIT],
    ]);
  });

  it('logs a start that failed', async () => {
    vi.stubEnv('CIDRELLA_DNS_PROXY_SUPERVISOR', 'systemd');
    unitCommand.mockResolvedValue({ ok: false, code: null, stdout: '', stderr: 'helper down' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await restartProxyProcess(null);
    expect(error.mock.calls.flat().join(' ')).toMatch(/Could not start the DNS proxy unit.*helper down/);
  });

  it('leaves the start to s6, and to the client in development', async () => {
    vi.stubEnv('CIDRELLA_DNS_PROXY_SUPERVISOR', 's6');
    await restartProxyProcess(null);
    vi.stubEnv('CIDRELLA_DNS_PROXY_SUPERVISOR', '');
    await restartProxyProcess(null);
    expect(unitCommand).not.toHaveBeenCalled();
  });
});
