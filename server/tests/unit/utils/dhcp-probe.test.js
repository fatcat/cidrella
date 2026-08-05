import { describe, it, expect } from 'vitest';
import { buildDiscover, parseOffer, classifyOffer, getSelfIps, runProbe, getProbeState } from '../../../src/utils/dhcp-probe.js';

// Build a realistic DHCP OFFER (BOOTREPLY) buffer for parse tests.
function buildOffer({
  xid = 0x12345678, msgType = 2, serverId = '10.0.0.1', gateway = '10.0.0.1',
  dns = ['10.0.0.1', '9.9.9.9'], mask = '255.255.255.0', yiaddr = '10.0.0.50',
  clientMac = 'aa:bb:cc:dd:ee:ff', cookie = 0x63825363, op = 2, giaddr = null,
} = {}) {
  const buf = Buffer.alloc(300);
  buf.writeUInt8(op, 0); buf.writeUInt8(1, 1); buf.writeUInt8(6, 2);
  buf.writeUInt32BE(xid >>> 0, 4);
  yiaddr.split('.').forEach((o, i) => buf.writeUInt8(+o, 16 + i));
  if (giaddr) giaddr.split('.').forEach((o, i) => buf.writeUInt8(+o, 24 + i));
  clientMac.split(':').forEach((h, i) => buf.writeUInt8(parseInt(h, 16), 28 + i));
  buf.writeUInt32BE(cookie, 236);
  let off = 240;
  const writeIp = (ip) => ip.split('.').forEach(o => buf.writeUInt8(+o, off++));
  buf.writeUInt8(53, off++); buf.writeUInt8(1, off++); buf.writeUInt8(msgType, off++);
  buf.writeUInt8(54, off++); buf.writeUInt8(4, off++); writeIp(serverId);
  buf.writeUInt8(1, off++); buf.writeUInt8(4, off++); writeIp(mask);
  buf.writeUInt8(3, off++); buf.writeUInt8(4, off++); writeIp(gateway);
  buf.writeUInt8(6, off++); buf.writeUInt8(4 * dns.length, off++); dns.forEach(writeIp);
  buf.writeUInt8(255, off++);
  return buf;
}

describe('buildDiscover', () => {
  it('produces a 300-byte BOOTREQUEST with the broadcast flag + DISCOVER option', () => {
    const buf = buildDiscover({ xid: 0xdeadbeef, mac: '11:22:33:44:55:66' });
    expect(buf.length).toBe(300);
    expect(buf.readUInt8(0)).toBe(1);              // op = BOOTREQUEST
    expect(buf.readUInt16BE(10)).toBe(0x8000);     // broadcast flag
    expect(buf.readUInt32BE(4)).toBe(0xdeadbeef);  // xid
    expect(buf.readUInt32BE(236)).toBe(0x63825363); // magic cookie
    // chaddr echoes the MAC
    expect(buf.readUInt8(28)).toBe(0x11);
    expect(buf.readUInt8(33)).toBe(0x66);
    // option 53 (msg type) = DISCOVER(1) right after the cookie
    expect(buf.readUInt8(240)).toBe(53);
    expect(buf.readUInt8(241)).toBe(1);
    expect(buf.readUInt8(242)).toBe(1);
  });
});

describe('parseOffer', () => {
  it('extracts server id, gateway, DNS list, mask, yiaddr from a valid OFFER', () => {
    const offer = parseOffer(buildOffer({ xid: 0x11223344 }));
    expect(offer).not.toBeNull();
    expect(offer.msgType).toBe(2);
    expect(offer.xid).toBe(0x11223344);
    expect(offer.serverId).toBe('10.0.0.1');
    expect(offer.gateway).toBe('10.0.0.1');
    expect(offer.subnetMask).toBe('255.255.255.0');
    expect(offer.yiaddr).toBe('10.0.0.50');
    expect(offer.dns).toEqual(['10.0.0.1', '9.9.9.9']);
  });

  it('returns null for a non-OFFER message type (e.g. ACK)', () => {
    expect(parseOffer(buildOffer({ msgType: 5 }))).toBeNull();
  });

  it('returns null for a BOOTREQUEST (op=1)', () => {
    expect(parseOffer(buildOffer({ op: 1 }))).toBeNull();
  });

  it('returns null when the magic cookie is wrong', () => {
    expect(parseOffer(buildOffer({ cookie: 0x12345678 }))).toBeNull();
  });

  it('returns null for a too-short buffer', () => {
    expect(parseOffer(Buffer.alloc(100))).toBeNull();
  });
});

// giaddr is the relay agent that forwarded the offer. It is the only field that
// separates "a second DHCP server is answering here" from "our own offer came
// back through a relay that rewrote the server-id to itself". It was parsed as
// part of a fixed comment range and never actually read.
describe('parseOffer: relay agent (giaddr)', () => {
  it('is null when the offer came straight from a server on our segment', () => {
    expect(parseOffer(buildOffer()).giaddr).toBeNull();
  });

  it('reports an all-zero giaddr as null rather than 0.0.0.0', () => {
    expect(parseOffer(buildOffer({ giaddr: '0.0.0.0' })).giaddr).toBeNull();
  });

  it('reads the relay address when one forwarded the offer', () => {
    expect(parseOffer(buildOffer({ giaddr: '10.0.3.254' })).giaddr).toBe('10.0.3.254');
  });

  it('does not disturb the other parsed fields', () => {
    const offer = parseOffer(buildOffer({ giaddr: '10.0.3.254', yiaddr: '10.0.0.137' }));
    expect(offer.yiaddr).toBe('10.0.0.137');
    expect(offer.serverId).toBe('10.0.0.1');
    expect(offer.subnetMask).toBe('255.255.255.0');
  });
});

describe('classifyOffer', () => {
  const selfIps = new Set(['10.0.0.1']);
  const authorized = new Set(['10.0.0.2']);

  it('trusts CIDRella\'s own server (self)', () => {
    const v = classifyOffer({ serverId: '10.0.0.1' }, { selfIps, authorized });
    expect(v).toEqual({ rogue: false, reason: 'self' });
  });

  it('trusts an allowlisted server', () => {
    const v = classifyOffer({ serverId: '10.0.0.2' }, { selfIps, authorized });
    expect(v).toEqual({ rogue: false, reason: 'authorized' });
  });

  it('flags an unknown server as rogue', () => {
    const v = classifyOffer({ serverId: '10.0.0.99' }, { selfIps, authorized });
    expect(v.rogue).toBe(true);
  });

  it('falls back to siaddr / sourceIp when there is no server-id', () => {
    expect(classifyOffer({ siaddr: '10.0.0.1' }, { selfIps, authorized }).rogue).toBe(false);
    expect(classifyOffer({ sourceIp: '10.0.0.2' }, { selfIps, authorized }).rogue).toBe(false);
    expect(classifyOffer({ sourceIp: '10.0.0.99' }, { selfIps, authorized }).rogue).toBe(true);
  });
});

// Regression: runProbe set probeInProgress BEFORE the socket existed and only
// finish() cleared it, so anything thrown in between stranded the flag. Every
// later call then returned {skipped:true} with no log at all, which silently
// disabled rogue DHCP detection until the service restarted. On prod that went
// unnoticed for four days.
describe('runProbe: the in-progress flag cannot be stranded', () => {
  it('clears the flag and records the error when setup throws', async () => {
    // No DB is initialised in this suite, so setup throws for real.
    await expect(runProbe({})).rejects.toThrow();

    const state = getProbeState();
    expect(state.probeInProgress).toBe(false);
    expect(state.lastProbeOutcome).toBe('error');
    expect(state.lastProbeError).toBeTruthy();
  });

  it('is still runnable after a failed setup, rather than silently skipping forever', async () => {
    await expect(runProbe({})).rejects.toThrow();

    // The whole point. Before the fix this resolved with {skipped:true} because
    // the stranded flag short-circuited every later call. Rejecting again proves
    // it actually re-entered setup.
    await expect(runProbe({})).rejects.toThrow();
    expect(getProbeState().probeInProgress).toBe(false);
  });
});

describe('getSelfIps', () => {
  it('returns a Set of strings', () => {
    const ips = getSelfIps();
    expect(ips).toBeInstanceOf(Set);
  });
});
