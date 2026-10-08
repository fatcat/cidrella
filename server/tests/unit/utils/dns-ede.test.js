import { describe, it, expect } from 'vitest';
import dnsPacket from 'dns-packet';
import {
  extractEde,
  edeOption,
  failureCause,
  EDE_NAMES,
  FAILURE_CAUSES,
  FAILURE_LABELS,
} from '../../../src/utils/dns-ede.js';

// An answer as dnsmasq sends it, through dns-packet both ways.
function answer({ rcode = 'SERVFAIL', type = 'A', options = [] } = {}) {
  const flags =
    dnsPacket.RECURSION_AVAILABLE | ({ NOERROR: 0, SERVFAIL: 2, NXDOMAIN: 3 }[rcode] ?? 0);
  return dnsPacket.decode(
    dnsPacket.encode({
      id: 1,
      type: 'response',
      flags,
      questions: [{ type, name: 'dnssec-failed.org' }],
      additionals: [{ type: 'OPT', name: '.', udpPayloadSize: 1232, flags: 0, options }],
    }),
  );
}

describe('extractEde', () => {
  it.each(['A', 'AAAA'])('reads the code and text of an %s answer', (type) => {
    expect(extractEde(answer({ type, options: [edeOption(7, 'expired')] }))).toEqual({
      code: 7,
      text: 'expired',
    });
  });

  it('is null with no OPT, no EDE, or a short option', () => {
    expect(extractEde(null)).toBeNull();
    expect(extractEde({ additionals: [] })).toBeNull();
    expect(extractEde(answer())).toBeNull();
    expect(extractEde(answer({ options: [{ code: 15, data: Buffer.from([0]) }] }))).toBeNull();
  });
});

describe('failureCause', () => {
  it.each([
    ['SERVFAIL', 6, 'dnssec'],
    ['SERVFAIL', 7, 'dnssec'],
    ['SERVFAIL', 9, 'dnssec'],
    ['SERVFAIL', 22, 'upstream'],
    ['SERVFAIL', 23, 'upstream'],
    ['SERVFAIL', 29, 'other'],
    ['SERVFAIL', null, 'other'],
    ['REFUSED', null, 'refused'],
    ['NOERROR', null, null],
    ['NXDOMAIN', 29, null],
  ])('%s with EDE %s is %s', (rcode, ede, cause) => {
    expect(failureCause(rcode, ede)).toBe(cause);
    expect(failureCause(rcode, ede == null ? null : { code: ede })).toBe(cause);
  });

  it('calls the proxy giving up a timeout, whatever else it knows', () => {
    expect(failureCause(undefined, null, { timedOut: true })).toBe('timeout');
  });

  it('labels every cause and names the RFC 8914 codes', () => {
    for (const cause of FAILURE_CAUSES) expect(FAILURE_LABELS[cause]).toBeTruthy();
    expect(EDE_NAMES[6]).toBe('DNSSEC Bogus');
    expect(EDE_NAMES[22]).toBe('No Reachable Authority');
  });
});
