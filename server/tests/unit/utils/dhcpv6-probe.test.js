import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const state = vi.hoisted(() => ({ settings: {} }));
vi.mock('../../../src/db/init.js', () => ({
  getDb: () => ({}),
  getSetting: (k) => (k in state.settings ? state.settings[k] : null),
}));

const {
  buildSolicit,
  clientDuidFor,
  parseAdvertise,
  classifyAdvertise,
  readServerDuid,
  getProbeInterfaces,
  runProbe6,
  getProbe6State,
} = await import('../../../src/utils/dhcpv6-probe.js');
const { parseIp } = await import('../../../src/utils/address.js');

function addressBytes(ip) {
  const { value } = parseIp(ip);
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64BE(value >> 64n, 0);
  buf.writeBigUInt64BE(value & 0xffffffffffffffffn, 8);
  return buf;
}

function option(code, data) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(code, 0);
  head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

function duidBytes(text) {
  return Buffer.from(text.split(':').map((h) => parseInt(h, 16)));
}

function domainList(names) {
  const parts = [];
  for (const name of names) {
    for (const label of name.split('.')) {
      parts.push(Buffer.from([label.length]), Buffer.from(label, 'latin1'));
    }
    parts.push(Buffer.from([0]));
  }
  return Buffer.concat(parts);
}

// A realistic ADVERTISE: server id, echoed client id, one IA_NA with an
// address, DNS servers and a domain list.
export function buildAdvertise({
  xid = 0x123456,
  msgType = 2,
  serverDuid = '00:01:00:01:2a:2b:2c:2d:aa:bb:cc:dd:ee:ff',
  clientDuid = '00:03:00:01:11:22:33:44:55:66',
  addresses = ['fd00:1234::1500'],
  dns = ['fd00:1234::1'],
  domains = ['lab.test'],
  status = null,
  preference = null,
} = {}) {
  const head = Buffer.alloc(4);
  head.writeUInt8(msgType, 0);
  head.writeUIntBE(xid, 1, 3);
  const iaNa = Buffer.alloc(12);
  iaNa.writeUInt32BE(0x33445566, 0);
  const iaAddrs = addresses.map((ip) => {
    const data = Buffer.alloc(24);
    addressBytes(ip).copy(data, 0);
    data.writeUInt32BE(3600, 16);
    data.writeUInt32BE(7200, 20);
    return option(5, data);
  });
  const parts = [
    head,
    option(2, duidBytes(serverDuid)),
    option(1, duidBytes(clientDuid)),
    option(3, Buffer.concat([iaNa, ...iaAddrs])),
  ];
  if (dns.length) parts.push(option(23, Buffer.concat(dns.map(addressBytes))));
  if (domains.length) parts.push(option(24, domainList(domains)));
  if (status) {
    const code = Buffer.alloc(2);
    code.writeUInt16BE(status.code, 0);
    parts.push(option(13, Buffer.concat([code, Buffer.from(status.message, 'utf8')])));
  }
  if (preference !== null) parts.push(option(7, Buffer.from([preference])));
  return Buffer.concat(parts);
}

describe('buildSolicit', () => {
  it('produces a SOLICIT with a client DUID-LL, an IA_NA and a DNS option request', () => {
    const buf = buildSolicit({ xid: 0xabcdef, mac: '11:22:33:44:55:66' });
    expect(buf.readUInt8(0)).toBe(1); // SOLICIT
    expect(buf.readUIntBE(1, 3)).toBe(0xabcdef);
    // Option 1 (client id) comes first: DUID-LL = type 3, hw type 1, the MAC.
    expect(buf.readUInt16BE(4)).toBe(1);
    expect(buf.readUInt16BE(6)).toBe(10);
    expect(buf.subarray(8, 18)).toEqual(
      Buffer.from([0, 3, 0, 1, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]),
    );
    const codes = [];
    let off = 4;
    while (off + 4 <= buf.length) {
      codes.push(buf.readUInt16BE(off));
      off += 4 + buf.readUInt16BE(off + 2);
    }
    expect(codes).toEqual([1, 8, 3, 6]);
    expect(off).toBe(buf.length); // options end exactly at the buffer end
  });

  it('keeps the transaction id to 24 bits', () => {
    const buf = buildSolicit({ xid: 0x01abcdef, mac: '11:22:33:44:55:66' });
    expect(buf.readUIntBE(1, 3)).toBe(0xabcdef);
  });

  it('derives the client DUID from the MAC', () => {
    expect(clientDuidFor('aa:bb:cc:dd:ee:ff')).toEqual(
      Buffer.from([0, 3, 0, 1, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
    );
  });
});

describe('parseAdvertise', () => {
  it('extracts the server DUID, offered address, DNS servers and domains', () => {
    const adv = parseAdvertise(
      buildAdvertise({ xid: 0x0a0b0c, dns: ['fd00:1234::1', '2606:4700:4700::1111'] }),
    );
    expect(adv).not.toBeNull();
    expect(adv.msgType).toBe(2);
    expect(adv.xid).toBe(0x0a0b0c);
    expect(adv.serverDuid).toBe('00:01:00:01:2a:2b:2c:2d:aa:bb:cc:dd:ee:ff');
    expect(adv.clientDuid).toBe('00:03:00:01:11:22:33:44:55:66');
    expect(adv.addresses).toEqual([{ address: 'fd00:1234::1500', preferred: 3600, valid: 7200 }]);
    expect(adv.dns).toEqual(['fd00:1234::1', '2606:4700:4700::1111']);
    expect(adv.domains).toEqual(['lab.test']);
    expect(adv.status).toBeNull();
    expect(adv.rapidCommit).toBe(false);
  });

  it('accepts a REPLY, which a server only sends to a SOLICIT when it commits unasked', () => {
    expect(parseAdvertise(buildAdvertise({ msgType: 7 })).msgType).toBe(7);
  });

  it('returns null for other message types', () => {
    expect(parseAdvertise(buildAdvertise({ msgType: 1 }))).toBeNull(); // SOLICIT
    expect(parseAdvertise(buildAdvertise({ msgType: 3 }))).toBeNull(); // REQUEST
  });

  it('returns null without a server identifier', () => {
    const head = Buffer.from([2, 0, 0, 1]);
    expect(parseAdvertise(Buffer.concat([head, option(1, Buffer.from([0, 3]))]))).toBeNull();
  });

  it('returns null for a too-short or truncated buffer', () => {
    expect(parseAdvertise(Buffer.alloc(3))).toBeNull();
    const cut = buildAdvertise().subarray(0, 12); // option header without its body
    expect(parseAdvertise(cut)).toBeNull();
  });

  it('reads a status code and a preference', () => {
    const adv = parseAdvertise(
      buildAdvertise({
        addresses: [],
        status: { code: 2, message: 'no addresses' },
        preference: 255,
      }),
    );
    expect(adv.addresses).toEqual([]);
    expect(adv.status).toEqual({ code: 2, message: 'no addresses' });
    expect(adv.preference).toBe(255);
  });
});

describe('classifyAdvertise', () => {
  const selfIps = new Set(['fe80::1', 'fd00:1234::1']);
  const selfDuid = '00:01:00:01:00:00:00:00:00:11:22:33:44:55';
  const authorized = {
    ips: new Set(['fe80::2']),
    duids: new Set(['00:03:00:01:aa:aa:aa:aa:aa:aa']),
    macs: new Set(['bb:bb:bb:bb:bb:bb']),
  };
  const ctx = { selfIps, selfDuid, authorized };

  it('trusts an advertisement from one of our own addresses', () => {
    expect(classifyAdvertise({ sourceIp: 'fe80::1', serverDuid: '00:01:ff' }, ctx)).toEqual({
      rogue: false,
      reason: 'self',
    });
  });

  it("trusts dnsmasq's own DUID wherever it answers from", () => {
    expect(classifyAdvertise({ sourceIp: 'fe80::99', serverDuid: selfDuid }, ctx).reason).toBe(
      'self',
    );
  });

  it('trusts an allowlisted link-local, DUID, or MAC', () => {
    expect(classifyAdvertise({ sourceIp: 'fe80::2', serverDuid: '00:01:ff' }, ctx).reason).toBe(
      'authorized',
    );
    expect(
      classifyAdvertise({ sourceIp: 'fe80::99', serverDuid: '00:03:00:01:AA:AA:AA:AA:AA:AA' }, ctx)
        .reason,
    ).toBe('authorized');
    expect(
      classifyAdvertise(
        { sourceIp: 'fe80::99', serverDuid: '00:01:ff' },
        { ...ctx, mac: 'BB:BB:BB:BB:BB:BB' },
      ).reason,
    ).toBe('authorized');
  });

  it('flags everything else', () => {
    const v = classifyAdvertise({ sourceIp: 'fe80::99', serverDuid: '00:01:ff' }, ctx);
    expect(v).toEqual({ rogue: true, reason: 'unauthorized' });
  });

  it('does not treat a missing self DUID as matching a missing server DUID', () => {
    const v = classifyAdvertise(
      { sourceIp: 'fe80::99', serverDuid: null },
      { ...ctx, selfDuid: null },
    );
    expect(v.rogue).toBe(true);
  });
});

describe('readServerDuid', () => {
  it('reads the duid header dnsmasq writes to its lease file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-duid-'));
    const file = path.join(dir, 'dnsmasq.leases');
    fs.writeFileSync(
      file,
      'duid 00:01:00:01:2E:3F:40:51:AA:BB:CC:DD:EE:FF\n1800000000 12345 fd00:1234::1500 laptop *\n',
    );
    expect(readServerDuid({ leaseFile: file })).toBe('00:01:00:01:2e:3f:40:51:aa:bb:cc:dd:ee:ff');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is null when the file is missing or has no header', () => {
    expect(readServerDuid({ leaseFile: '/nonexistent/dnsmasq.leases' })).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-duid-'));
    const file = path.join(dir, 'dnsmasq.leases');
    fs.writeFileSync(file, '1800000000 aa:bb:cc:dd:ee:ff 10.0.0.5 host *\n');
    expect(readServerDuid({ leaseFile: file })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('getProbeInterfaces: DHCP-serving interfaces holding a link-local address', () => {
  const IFACES = {
    lo: [{ family: 'IPv6', internal: true, address: '::1', mac: '00:00:00:00:00:00', scopeid: 0 }],
    eth0: [
      { family: 'IPv4', internal: false, address: '10.0.0.1', mac: 'aa:aa:aa:aa:aa:aa' },
      {
        family: 'IPv6',
        internal: false,
        address: 'fd00:1234::1',
        mac: 'aa:aa:aa:aa:aa:aa',
        scopeid: 0,
      },
      {
        family: 'IPv6',
        internal: false,
        address: 'FE80::A8AA:AAFF:FEAA:AAAA',
        mac: 'aa:aa:aa:aa:aa:aa',
        scopeid: 2,
      },
    ],
    eth1: [{ family: 'IPv4', internal: false, address: '10.0.1.1', mac: 'bb:bb:bb:bb:bb:bb' }],
  };

  beforeEach(() => {
    state.settings = {};
  });

  it('returns nothing when DHCP is globally disabled', () => {
    state.settings.dhcp_enabled = 'false';
    expect(getProbeInterfaces({ sysIfaces: IFACES })).toEqual([]);
  });

  it('skips interfaces without a link-local address and canonicalizes the one it keeps', () => {
    expect(getProbeInterfaces({ sysIfaces: IFACES })).toEqual([
      {
        ifName: 'eth0',
        address: 'fe80::a8aa:aaff:feaa:aaaa',
        mac: 'aa:aa:aa:aa:aa:aa',
        scopeid: 2,
      },
    ]);
  });

  it('honors the interface config like the v4 probe', () => {
    state.settings.interface_config = JSON.stringify({ eth0: { dhcp: false, dns: true } });
    expect(getProbeInterfaces({ sysIfaces: IFACES })).toEqual([]);
  });
});

describe('runProbe6: the in-progress flag cannot be stranded', () => {
  it('clears the flag and records the error when setup throws', async () => {
    await expect(runProbe6({})).rejects.toThrow();
    const state6 = getProbe6State();
    expect(state6.probeInProgress).toBe(false);
    expect(state6.lastProbeOutcome).toBe('error');
    expect(state6.lastProbeError).toBeTruthy();
    await expect(runProbe6({})).rejects.toThrow();
  });
});
