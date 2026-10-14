/**
 * The proxy asks the DNS backend with Recursion Desired set and gives the
 * client back its own RD bit. PowerDNS Recursor refuses an RD=0 query even for
 * a name CIDRella serves; dnsmasq answered it. The bits live in the header,
 * which is the same for a query over IPv4 or IPv6.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const { asksRecursion, withRecursionDesired, withClientRd } =
  await import('../../src/utils/dns-proxy.js');

// ID 0x1234, flags byte 2 as given, byte 3 0, one question.
const header = (flags2) => Buffer.from([0x12, 0x34, flags2, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);

describe('Recursion Desired toward the backend', () => {
  it('sets RD on a query that lacks it, leaving the other flags and the original alone', () => {
    const query = header(0x10); // opcode bits set, RD clear
    const sent = withRecursionDesired(query);
    expect(sent[2]).toBe(0x11);
    expect(query[2]).toBe(0x10);
    expect(sent.subarray(3)).toEqual(query.subarray(3));
  });

  it('keeps RD on a query that already asks for it', () => {
    expect(withRecursionDesired(header(0x01))[2]).toBe(0x01);
  });

  it('reads whether the client asked for recursion', () => {
    expect(asksRecursion(header(0x01))).toBe(true);
    expect(asksRecursion(header(0x00))).toBe(false);
    expect(asksRecursion(Buffer.from([0x12]))).toBe(false);
  });

  it("gives the client back its own RD bit and keeps QR, AA and RA", () => {
    const reply = header(0x85); // QR + AA + RD
    reply[3] = 0x83; // RA + NXDOMAIN
    expect(withClientRd(Buffer.from(reply), false)[2]).toBe(0x84);
    expect(withClientRd(Buffer.from(reply), true)[2]).toBe(0x85);
    expect(withClientRd(Buffer.from(reply), false)[3]).toBe(0x83);
  });

  it('leaves a truncated message alone', () => {
    expect(withRecursionDesired(Buffer.from([1, 2]))).toEqual(Buffer.from([1, 2]));
    expect(withClientRd(Buffer.from([1, 2]), true)).toEqual(Buffer.from([1, 2]));
  });
});
