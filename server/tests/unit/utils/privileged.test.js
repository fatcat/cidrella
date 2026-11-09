/**
 * utils/privileged.js: the one door to a privileged action. The helper runs
 * it where CIDRELLA_HELPER_SOCKET is set, the web app itself where not, and
 * both build the same command.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { exec, helperRun, helperPeer, helperConnected, startHelperClient } = vi.hoisted(() => ({
  exec: vi.fn(),
  helperRun: vi.fn(),
  helperPeer: vi.fn(() => null),
  helperConnected: vi.fn(() => false),
  startHelperClient: vi.fn(),
}));
vi.mock('../../../src/utils/run-command.js', async () =>
  (await import('../../helpers/fake-run-command.js')).fakeRunCommandModule(exec),
);
vi.mock('../../../src/utils/helper-client.js', () => ({
  helperRun,
  helperPeer,
  helperConnected,
  startHelperClient,
}));

const Privileged = await import('../../../src/utils/privileged.js');
const { RefusedError } = await import('../../../src/helper/commands.js');

const SOCKET = '/run/cidrella-helper/helper.sock';

beforeEach(() => {
  exec.mockReset();
  helperRun.mockReset();
  startHelperClient.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('without the helper (development)', () => {
  it('runs the command itself, either family', async () => {
    exec.mockReturnValue('reply');
    expect(await Privileged.arping('10.0.0.5')).toMatchObject({ ok: true, stdout: 'reply' });
    await Privileged.ping('2001:db8::5', { count: 2 });
    expect(exec.mock.calls.map(([cmd, args]) => [cmd, ...args])).toEqual([
      ['arping', '-c', '1', '-w', '1', '10.0.0.5'],
      ['ping', '-6', '-c', '2', '-W', '2', '2001:db8::5'],
    ]);
    expect(helperRun).not.toHaveBeenCalled();
  });

  it('reports a failed command without throwing', async () => {
    exec.mockImplementation(() => {
      throw Object.assign(new Error('exit 1'), {
        status: 1,
        stderr: 'Interactive authentication required.',
      });
    });
    expect(await Privileged.unitCommand('reload', 'cidrella-dnsmasq')).toMatchObject({
      ok: false,
      code: 1,
      stderr: 'Interactive authentication required.',
    });
  });
});

describe('with the helper', () => {
  beforeEach(() => vi.stubEnv('CIDRELLA_HELPER_SOCKET', SOCKET));

  it('asks the helper, and never runs a command itself', async () => {
    helperRun.mockResolvedValue({
      type: 'result',
      id: 3,
      ok: true,
      code: 0,
      stdout: 'x',
      stderr: '',
    });
    expect(await Privileged.ping('192.0.2.1')).toEqual({
      ok: true,
      code: 0,
      stdout: 'x',
      stderr: '',
    });
    expect(helperRun).toHaveBeenCalledWith(
      'ping',
      { ip: '192.0.2.1', count: 1, timeoutSec: 2 },
      { timeoutMs: 2500 + 5000 },
    );
    await Privileged.startUpdate('0.6.3_1762700000');
    await Privileged.enableNtp();
    expect(helperRun.mock.calls.map(([op]) => op)).toEqual(['ping', 'update', 'ntp-on']);
    expect(exec).not.toHaveBeenCalled();
  });

  it('says so when the helper does not answer', async () => {
    helperRun.mockResolvedValue(null);
    expect(await Privileged.arping('10.0.0.5')).toMatchObject({
      ok: false,
      helperDown: true,
      stderr: Privileged.HELPER_DOWN_MESSAGE,
    });
  });

  it('turns a refusal from a helper on other code into a failure', async () => {
    helperRun.mockResolvedValue({ type: 'result', id: 1, refused: 'not a unit CIDRella controls' });
    expect(await Privileged.unitCommand('restart', 'cidrella-radvd')).toMatchObject({
      ok: false,
      code: 'EREFUSED',
    });
  });

  it('refuses a bad request before it leaves the web app', async () => {
    await expect(Privileged.arping('10.0.0.5; reboot')).rejects.toBeInstanceOf(RefusedError);
    await expect(Privileged.unitCommand('restart', 'cidrella')).rejects.toBeInstanceOf(
      RefusedError,
    );
    expect(helperRun).not.toHaveBeenCalled();
  });

  it("warns from the helper's capabilities, not the web app's", () => {
    helperConnected.mockReturnValue(false);
    expect(Privileged.capabilityWarning()).toMatch(/helper is not answering/);
    helperConnected.mockReturnValue(true);
    helperPeer.mockReturnValue({
      capabilities: { cap_net_raw_effective: true, cap_net_raw_ambient: true },
    });
    expect(Privileged.capabilityWarning()).toBeNull();
    helperPeer.mockReturnValue({ capabilities: { cap_net_raw_effective: false } });
    expect(Privileged.capabilityWarning()).toMatch(/CAP_NET_RAW is not effective/);
    // Docker: arping and ping carry their own file capabilities.
    helperPeer.mockReturnValue({ fileCaps: true, capabilities: { cap_net_raw_effective: false } });
    expect(Privileged.capabilityWarning()).toBeNull();
    expect(Privileged.probeCapabilities()).toMatchObject({ source: 'helper', fileCaps: true });
  });

  it("connects at boot, but never from update.sh's preflight probe", () => {
    Privileged.startPrivileged();
    expect(startHelperClient).toHaveBeenCalledWith(expect.objectContaining({ socketPath: SOCKET }));
    startHelperClient.mockReset();
    vi.stubEnv('CIDRELLA_PREFLIGHT', '1');
    Privileged.startPrivileged();
    expect(startHelperClient).not.toHaveBeenCalled();
  });
});
