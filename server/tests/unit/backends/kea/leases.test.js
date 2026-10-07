import '../../../helpers/isolated-data-dir.js';
import { describe, it, expect } from 'vitest';
import {
  backendLeaseFromKea,
  keaLeaseArguments,
  keaPacketCounters,
  pageLeases,
  readKeaLeases,
  releaseKeaLease,
} from '../../../../src/backends/kea/leases.js';
import { KeaError } from '../../../../src/backends/kea/client.js';
import { addressToBig } from '../../../../src/utils/cidr.js';

const CLTT = Date.parse('2026-10-07T12:00:00Z') / 1000;

describe('backendLeaseFromKea', () => {
  it('maps a DHCPv4 lease, its expiry from cltt and valid-lft', () => {
    expect(
      backendLeaseFromKea(
        {
          'ip-address': '10.5.0.100',
          'hw-address': 'AA:BB:CC:00:00:F1',
          'client-id': '01:AA:BB:CC:00:00:F1',
          hostname: 'laptop',
          cltt: CLTT,
          'valid-lft': 120,
          state: 0,
        },
        4,
      ),
    ).toEqual({
      ip: '10.5.0.100',
      mac: 'aa:bb:cc:00:00:f1',
      hostname: 'laptop',
      clientId: '01:aa:bb:cc:00:00:f1',
      expiresAt: '2026-10-07T12:02:00.000Z',
      dhcpVersion: 4,
      duid: null,
      iaid: null,
    });
  });

  it('maps a DHCPv6 lease and reads the infinite lifetime as infinite', () => {
    expect(
      backendLeaseFromKea(
        {
          'ip-address': 'fd00:5::121',
          duid: '00:01:00:01:AA:BB:CC:DD:00:25:00:41',
          iaid: 41,
          type: 'IA_NA',
          hostname: '',
          cltt: CLTT,
          'valid-lft': 4294967295,
          state: 0,
        },
        6,
      ),
    ).toMatchObject({
      ip: 'fd00:5::121',
      mac: null,
      hostname: null,
      duid: '00:01:00:01:aa:bb:cc:dd:00:25:00:41',
      iaid: 41,
      expiresAt: 'infinite',
      dhcpVersion: 6,
      temporary: false,
    });
  });

  it('drops leases not in use and delegated prefixes', () => {
    for (const state of [1, 2, 3]) {
      expect(backendLeaseFromKea({ 'ip-address': '10.5.0.9', state }, 4)).toBeNull();
    }
    expect(
      backendLeaseFromKea({ 'ip-address': 'fd00:5::', type: 'IA_PD', state: 0 }, 6),
    ).toBeNull();
  });
});

// A command that answers lease pages from `leases` (in address order) and
// statistics from `stats()`.
function fakeCommand(leases, stats = () => ({})) {
  const calls = [];
  const command = async (name, args) => {
    calls.push({ name, args });
    if (name === 'statistic-get-all') return { arguments: stats() };
    const after = args.from === 'start' ? -1n : addressToBig(args.from).value;
    const page = leases
      .filter((l) => addressToBig(l['ip-address']).value > after)
      .slice(0, args.limit);
    return page.length
      ? { arguments: { leases: page } }
      : { empty: true, arguments: { leases: [] } };
  };
  command.calls = calls;
  return command;
}

const lease4 = (n) => ({
  'ip-address': `10.5.${Math.floor(n / 200)}.${(n % 200) + 1}`,
  'hw-address': 'aa:bb:cc:00:00:01',
  cltt: CLTT,
  'valid-lft': 60,
  state: 0,
});

describe('pageLeases', () => {
  it('pages through every lease from the last address of each page', async () => {
    const leases = Array.from({ length: 1500 }, (_, n) => lease4(n));
    const command = fakeCommand(leases);
    expect((await pageLeases(command, 4)).length).toBe(1500);
    expect(command.calls.map((c) => c.args.from)).toEqual(['start', leases[999]['ip-address']]);
  });
});

describe('readKeaLeases', () => {
  const stat = (n) => ({ 'subnet[1].cumulative-assigned-addresses': [[n, 'now']] });

  it('reads both families when the counters hold still', async () => {
    const commands = {
      4: fakeCommand([lease4(1)], () => stat(5)),
      6: fakeCommand([
        {
          'ip-address': 'fd00::5',
          duid: '00:01',
          iaid: 1,
          type: 'IA_NA',
          cltt: CLTT,
          'valid-lft': 60,
          state: 0,
        },
      ]),
    };
    const { leases } = await readKeaLeases(commands, [4, 6]);
    expect(leases.map((l) => l.dhcpVersion)).toEqual([4, 6]);
  });

  it('reports unsettled when an address was handed out during the scan', async () => {
    let n = 0;
    const commands = { 4: fakeCommand([lease4(1)], () => stat(n++)) };
    expect(await readKeaLeases(commands, [4])).toEqual({ leases: null, unsettled: true });
  });
});

describe('keaLeaseArguments', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');

  it('gives a finite lease its remaining time, so it starts now', () => {
    expect(
      keaLeaseArguments(
        {
          ip: '10.5.0.120',
          mac: 'aa:bb:cc:00:00:20',
          hostname: 'pc',
          clientId: null,
          expiresAt: '2026-10-07T12:01:40Z',
          dhcpVersion: 4,
        },
        { now },
      ),
    ).toEqual({
      'ip-address': '10.5.0.120',
      'hw-address': 'aa:bb:cc:00:00:20',
      'valid-lft': 100,
      expire: now / 1000 + 100,
      hostname: 'pc',
    });
  });

  it('adds an infinite lease with no expire, the form Kea takes', () => {
    expect(
      keaLeaseArguments(
        { ip: 'fd00:5::121', duid: '00:01:aa', iaid: 41, expiresAt: 'infinite', dhcpVersion: 6 },
        { now },
      ),
    ).toEqual({
      'ip-address': 'fd00:5::121',
      duid: '00:01:aa',
      iaid: 41,
      type: 'IA_NA',
      'valid-lft': 4294967295,
    });
  });
});

describe('releaseKeaLease', () => {
  const commands = (reply) => ({ 4: async () => reply, 6: async () => reply });

  it('releases, reports a lease Kea no longer has, and never throws', async () => {
    expect(await releaseKeaLease(commands({}), { ip: '10.5.0.1' })).toEqual({ released: true });
    expect(
      await releaseKeaLease(commands({ empty: true }), { ip: 'fd00::1', dhcpVersion: 6 }),
    ).toEqual({
      released: false,
      skipped: 'not-found',
    });
    const failing = {
      4: async () => {
        throw new KeaError('down');
      },
    };
    expect(await releaseKeaLease(failing, { ip: '10.5.0.1' })).toEqual({
      released: false,
      error: 'down',
    });
    expect(await releaseKeaLease(commands({}), {})).toEqual({
      released: false,
      skipped: 'invalid-identity',
    });
  });
});

describe('keaPacketCounters', () => {
  it('sums packets received and sent over the families served', async () => {
    const stats = (r, s, f) => async () => ({
      arguments: { [`pkt${f}-received`]: [[r, 'now']], [`pkt${f}-sent`]: [[s, 'now']] },
    });
    expect(await keaPacketCounters({ 4: stats(10, 8, 4), 6: stats(3, 2, 6) }, [4, 6])).toEqual({
      received: 13,
      sent: 10,
    });
  });
});
