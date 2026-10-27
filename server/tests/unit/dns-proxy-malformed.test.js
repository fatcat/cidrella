/**
 * A query dns-packet cannot decode gets a FORMERR built from its own header,
 * so the client stops retrying. The header is the same over IPv4 or IPv6.
 */
import { describe, it, expect, vi } from 'vitest';
import dnsPacket from 'dns-packet';

vi.mock('../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const { formErrReply } = await import('../../src/utils/dns-proxy.js');

// ID 0xbeef, opcode 0 with RD, one question whose first label claims 63
// bytes and has none: "Cannot decode name (buffer overflow)".
const truncatedName = Buffer.from([0xbe, 0xef, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 63, 0x61]);

describe('FORMERR for a malformed query', () => {
  it('answers a query whose name runs past the end', () => {
    expect(() => dnsPacket.decode(truncatedName)).toThrow(/Cannot decode name/);
    const reply = formErrReply(truncatedName);
    const decoded = dnsPacket.decode(reply);
    expect(decoded).toMatchObject({ id: 0xbeef, type: 'response', rcode: 'FORMERR' });
    expect(decoded.flags & dnsPacket.RECURSION_DESIRED).toBeTruthy();
    expect(decoded.questions).toEqual([]);
  });

  it('keeps the opcode', () => {
    const notify = Buffer.from(truncatedName);
    notify[2] = 0x20; // opcode 4 (NOTIFY), RD clear
    const reply = formErrReply(notify);
    expect(reply[2]).toBe(0xa0);
    expect(reply[3] & 0x0f).toBe(1);
  });

  it('does not answer something shorter than a header, or a response', () => {
    expect(formErrReply(Buffer.from([0xbe, 0xef, 0x01]))).toBeNull();
    const response = Buffer.from(truncatedName);
    response[2] |= 0x80;
    expect(formErrReply(response)).toBeNull();
  });
});
