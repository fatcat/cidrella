import '../../../helpers/isolated-data-dir.js';
import { describe, it, expect } from 'vitest';
import {
  renderKeaConfig,
  serverIdFromDuid,
  INFINITE_LIFETIME,
} from '../../../../src/backends/kea/render.js';

const v4Scope = (over = {}) => ({
  scope: { id: 1, subnet_id: 7, subnet_cidr: '10.5.0.0/24', subnet_broadcast: '10.5.0.255' },
  family: 4,
  network: '10.5.0.0',
  prefix: 24,
  mode: null,
  leaseTime: '12h',
  pools: [{ start_ip: '10.5.0.100', end_ip: '10.5.0.199' }],
  excludedIps: [],
  suppressRouter: false,
  options: [],
  ...over,
});

const v6Scope = (over = {}) => ({
  scope: { id: 2, subnet_id: 8, subnet_cidr: 'fd00:5::/64' },
  family: 6,
  network: 'fd00:5::',
  prefix: 64,
  mode: 'stateful',
  leaseTime: '1h',
  pools: [{ start_ip: 'fd00:5::100', end_ip: 'fd00:5::1ff' }],
  excludedIps: [],
  suppressRouter: false,
  options: [],
  ...over,
});

const render = (family, scopes, extra = {}) =>
  renderKeaConfig(family, { scopes, reservations: [], interfaces: ['eth0'], ...extra })[
    family === 6 ? 'Dhcp6' : 'Dhcp4'
  ];
const dataOf = (subnet, code) => subnet['option-data'].find((o) => o.code === code);

describe('renderKeaConfig, IPv4', () => {
  it('maps a scope to a subnet keyed by the network id, splitting pools around reserved addresses', () => {
    const [subnet] = render(4, [v4Scope({ excludedIps: ['10.5.0.150'] })]).subnet4;
    expect(subnet).toMatchObject({ id: 7, subnet: '10.5.0.0/24', 'valid-lifetime': 43200 });
    expect(subnet.pools.map((p) => p.pool)).toEqual([
      '10.5.0.100 - 10.5.0.149',
      '10.5.0.151 - 10.5.0.199',
    ]);
    // Kea sends no broadcast address unless told; dnsmasq always does.
    expect(dataOf(subnet, 28)).toEqual({ code: 28, space: 'dhcp4', data: '10.5.0.255' });
  });

  it('writes an infinite lease time as the infinite lifetime', () => {
    const [subnet] = render(4, [v4Scope({ leaseTime: 'infinite' })]).subnet4;
    expect(subnet['valid-lifetime']).toBe(INFINITE_LIFETIME);
  });

  it('writes catalog options as text and the awkward ones the way dnsmasq sends them', () => {
    const [subnet] = render(4, [
      v4Scope({
        options: [
          { code: 6, type: 'ip-list', custom: false, addresses: ['10.5.0.1', '10.5.0.2'] },
          { code: 121, type: 'text', custom: false, text: '10.9.0.0/16,10.5.0.1' },
          { code: 43, type: 'text', custom: false, text: '01:04:c0:a8:01:01' },
          { code: 150, type: 'ip', custom: false, addresses: ['10.5.0.9'] },
          { code: 252, type: 'text', custom: false, text: 'http://w/p' },
        ],
      }),
    ]).subnet4;
    expect(dataOf(subnet, 6).data).toBe('10.5.0.1, 10.5.0.2');
    expect(dataOf(subnet, 121).data).toBe('10.9.0.0/16 - 10.5.0.1');
    expect(dataOf(subnet, 43)).toMatchObject({ 'csv-format': false, data: '0104c0a80101' });
    expect(dataOf(subnet, 150)).toMatchObject({ 'csv-format': false, data: '0a050009' });
    expect(dataOf(subnet, 252)).toMatchObject({
      'csv-format': false,
      data: Buffer.from('http://w/p').toString('hex'),
    });
  });

  it('writes custom options as the bytes of their type, numbers at dnsmasq widths', () => {
    const opts = [
      { code: 224, type: 'number', custom: true, text: '7' },
      { code: 225, type: 'number', custom: true, text: '300' },
      { code: 226, type: 'number', custom: true, text: '70000' },
      { code: 227, type: 'ip-list', custom: true, addresses: ['10.0.0.1', '10.0.0.2'] },
      { code: 228, type: 'text', custom: true, text: 'hi' },
    ];
    const [subnet] = render(4, [v4Scope({ options: opts })]).subnet4;
    expect([224, 225, 226, 227, 228].map((c) => dataOf(subnet, c).data)).toEqual([
      '07',
      '012c',
      '00011170',
      '0a0000010a000002',
      '6869',
    ]);
  });

  it('gives a second scope on the network its own pool options', () => {
    const second = v4Scope({
      scope: { id: 9, subnet_id: 7, subnet_cidr: '10.5.0.0/24' },
      pools: [{ start_ip: '10.5.0.200', end_ip: '10.5.0.220' }],
      options: [{ code: 3, type: 'ip', custom: false, addresses: ['10.5.0.254'] }],
    });
    const [subnet] = render(4, [v4Scope(), second]).subnet4;
    expect(subnet.pools).toEqual([
      { pool: '10.5.0.100 - 10.5.0.199' },
      {
        pool: '10.5.0.200 - 10.5.0.220',
        'option-data': [{ code: 3, space: 'dhcp4', data: '10.5.0.254' }],
      },
    ]);
  });

  it('places reservations in their subnet and drops ones outside it', () => {
    const [subnet] = render(4, [v4Scope()], {
      reservations: [
        { subnetId: 7, family: 4, mac: 'aa:bb:cc:00:00:01', ip: '10.5.0.50', hostname: 'printer' },
        { subnetId: 7, family: 4, mac: 'aa:bb:cc:00:00:02', ip: '10.9.0.50', hostname: null },
      ],
    }).subnet4;
    expect(subnet.reservations).toEqual([
      { 'hw-address': 'aa:bb:cc:00:00:01', 'ip-address': '10.5.0.50', hostname: 'printer' },
    ]);
  });

  it('turns DDNS off and leaves the client name alone', () => {
    expect(render(4, [])).toMatchObject({
      'ddns-send-updates': false,
      'ddns-replace-client-name': 'never',
    });
  });
});

describe('renderKeaConfig, IPv6', () => {
  const sysIfaces = { eth1: [{ family: 'IPv6', address: 'fd00:5::2' }] };

  it('places a stateful scope on the interface that is on its network', () => {
    const [subnet] = render(6, [v6Scope()], { sysIfaces }).subnet6;
    expect(subnet).toMatchObject({
      id: 8,
      subnet: 'fd00:5::/64',
      interface: 'eth1',
      'valid-lifetime': 3600,
      'preferred-lifetime': 3600,
      'rapid-commit': true,
      pools: [{ pool: 'fd00:5::100 - fd00:5::1ff' }],
    });
  });

  it('serves a stateless scope with no pools and leaves a SLAAC scope to the RAs', () => {
    const subnets = render(6, [
      v6Scope({ mode: 'stateless' }),
      v6Scope({
        mode: 'slaac',
        scope: { id: 3, subnet_id: 9, subnet_cidr: 'fd00:6::/64' },
        network: 'fd00:6::',
      }),
    ]).subnet6;
    expect(subnets).toHaveLength(1);
    expect(subnets[0].pools).toEqual([]);
    expect(subnets[0]['rapid-commit']).toBeUndefined();
  });

  it('writes NTP servers as RFC 5908 suboptions, multicast as its own kind', () => {
    const [subnet] = render(6, [
      v6Scope({
        options: [
          { code: 56, type: 'ip-list', custom: false, addresses: ['fd00::1', 'ff05::101'] },
        ],
      }),
    ]).subnet6;
    expect(dataOf(subnet, 56)).toEqual({
      code: 56,
      space: 'dhcp6',
      'csv-format': false,
      data: `00010010fd000000000000000000000000000001` + `00020010ff050000000000000000000000000101`,
    });
  });

  it('places DUID reservations and answers with the carried server DUID', () => {
    const cfg = render(6, [v6Scope()], {
      reservations: [
        {
          subnetId: 8,
          family: 6,
          duid: '00:03:00:01:aa:bb:cc:dd:ee:ff',
          ip: 'fd00:5::50',
          hostname: 'nas',
        },
      ],
      serverDuid: '00:03:00:01:52:54:00:00:00:01',
    });
    expect(cfg.subnet6[0].reservations).toEqual([
      { duid: '00:03:00:01:aa:bb:cc:dd:ee:ff', 'ip-addresses': ['fd00:5::50'], hostname: 'nas' },
    ]);
    expect(cfg['server-id']).toEqual({
      type: 'LL',
      htype: 1,
      identifier: '525400000001',
      persist: false,
    });
  });
});

describe('serverIdFromDuid', () => {
  it('reads the three DUID types Kea can be told', () => {
    expect(serverIdFromDuid('00:01:00:01:2a:2b:2c:2d:aa:bb:cc:dd:ee:ff')).toEqual({
      type: 'LLT',
      htype: 1,
      time: 0x2a2b2c2d,
      identifier: 'aabbccddeeff',
      persist: false,
    });
    expect(serverIdFromDuid('00:02:00:00:09:bf:01:02:03')).toEqual({
      type: 'EN',
      enterprise: 2495,
      identifier: '010203',
      persist: false,
    });
  });

  it('leaves Kea to make its own for anything else', () => {
    expect(serverIdFromDuid(null)).toBeNull();
    expect(serverIdFromDuid('00:04:01:02:03:04:05:06')).toBeNull();
    expect(serverIdFromDuid('not a duid')).toBeNull();
  });
});
