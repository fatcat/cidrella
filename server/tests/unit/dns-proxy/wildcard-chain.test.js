/**
 * A forwarded CNAME chain ending in a wildcard goes to PowerDNS Recursor one
 * step at a time (PDNS-DNSSEC-NASA-01). The shape is www.nasa.gov as Quad9 and
 * Google answer it: a signed CNAME, then a target signed with fewer labels than
 * its name has, with the NSEC proof in the authority section.
 */
import { describe, it, expect } from 'vitest';
import dnsPacket from 'dns-packet';
import { splitWildcardChain } from '../../../src/dns-proxy/wildcard-chain.js';

const SIGNATURE = Buffer.alloc(32, 7);
const rrsig = (name, typeCovered, labels, signersName) => ({
  type: 'RRSIG',
  name,
  ttl: 300,
  data: {
    typeCovered,
    algorithm: 13,
    labels,
    originalTTL: 300,
    expiration: 1800000000,
    inception: 1790000000,
    keyTag: 41562,
    signersName,
    signature: SIGNATURE,
  },
});
const cname = (name, data) => ({ type: 'CNAME', name, ttl: 300, data });
const nsec = {
  type: 'NSEC',
  name: 'lotus.go-vip.net',
  ttl: 60,
  data: { nextDomain: 'ns1.go-vip.net', rrtypes: ['A', 'RRSIG', 'NSEC'] },
};
const nsecSig = rrsig('lotus.go-vip.net', 'NSEC', 3, 'go-vip.net');
const opt = { type: 'OPT', name: '.', udpPayloadSize: 1232, flags: dnsPacket.DNSSEC_OK };

function message({ name = 'www.nasa.gov', type = 'A', answers, authorities = [], additionals }) {
  return dnsPacket.encode({
    id: 4242,
    type: 'response',
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE | dnsPacket.AUTHENTIC_DATA,
    questions: [{ type, name }],
    answers,
    authorities,
    additionals: additionals ?? [opt],
  });
}

const FAMILIES = [
  ['IPv4', 'A', { type: 'A', name: 'nasa-gov.go-vip.net', ttl: 3600, data: '192.0.66.108' }],
  ['IPv6', 'AAAA', { type: 'AAAA', name: 'nasa-gov.go-vip.net', ttl: 3600, data: '2001:db8::108' }],
];

const chain = (type, target) => [
  cname('www.nasa.gov', 'nasa-gov.go-vip.net'),
  rrsig('www.nasa.gov', 'CNAME', 3, 'nasa.gov'),
  target,
  rrsig('nasa-gov.go-vip.net', type, 2, 'go-vip.net'),
];

describe.each(FAMILIES)('a chain ending in a wildcard, %s', (_family, type, target) => {
  const whole = () => message({ type, answers: chain(type, target), authorities: [nsec, nsecSig] });

  it("keeps only the query name's CNAME and its signature", () => {
    const answer = dnsPacket.decode(splitWildcardChain(whole()));
    expect(answer.answers.map((record) => [record.type, record.name])).toEqual([
      ['CNAME', 'www.nasa.gov'],
      ['RRSIG', 'www.nasa.gov'],
    ]);
    expect(answer.answers[0].data).toBe('nasa-gov.go-vip.net');
    expect(answer.authorities).toEqual([]);
  });

  it('stays the same message to the asker, and claims no validation', () => {
    const answer = dnsPacket.decode(splitWildcardChain(whole()));
    expect(answer.id).toBe(4242);
    expect(answer.questions).toEqual([{ name: 'www.nasa.gov', type, class: 'IN' }]);
    expect(answer.flag_ad).toBe(false);
    expect(answer.flag_rd).toBe(true);
    expect(answer.flag_ra).toBe(true);
    expect(answer.rcode).toBe('NOERROR');
    expect(answer.additionals.map((record) => record.type)).toEqual(['OPT']);
    expect(answer.answers[1].data.signature.equals(SIGNATURE)).toBe(true);
  });

  it('matches names whatever their case', () => {
    const shouted = message({
      name: 'WWW.NASA.GOV',
      type,
      answers: chain(type, target),
      authorities: [nsec, nsecSig],
    });
    expect(dnsPacket.decode(splitWildcardChain(shouted)).answers).toHaveLength(2);
  });

  it('drops what is not an OPT from the additional section', () => {
    const answer = dnsPacket.decode(
      splitWildcardChain(
        message({
          type,
          answers: chain(type, target),
          additionals: [opt, { type: 'A', name: 'ns1.go-vip.net', ttl: 60, data: '192.0.2.53' }],
        }),
      ),
    );
    expect(answer.additionals.map((record) => record.type)).toEqual(['OPT']);
  });

  it("keeps the proof when the query name's own record is an expansion too", () => {
    const answers = [
      cname('www.nasa.gov', 'nasa-gov.go-vip.net'),
      rrsig('www.nasa.gov', 'CNAME', 2, 'nasa.gov'),
      target,
      rrsig('nasa-gov.go-vip.net', type, 2, 'go-vip.net'),
    ];
    const answer = dnsPacket.decode(
      splitWildcardChain(message({ type, answers, authorities: [nsec, nsecSig] })),
    );
    expect(answer.answers).toHaveLength(2);
    expect(answer.authorities.map((record) => record.type)).toEqual(['NSEC', 'RRSIG']);
  });

  it('cuts a longer chain at its first step', () => {
    const answers = [
      cname('www.nasa.gov', 'step.nasa.gov'),
      rrsig('www.nasa.gov', 'CNAME', 3, 'nasa.gov'),
      cname('step.nasa.gov', 'nasa-gov.go-vip.net'),
      rrsig('step.nasa.gov', 'CNAME', 3, 'nasa.gov'),
      target,
      rrsig('nasa-gov.go-vip.net', type, 2, 'go-vip.net'),
    ];
    const answer = dnsPacket.decode(splitWildcardChain(message({ type, answers })));
    expect(answer.answers.map((record) => record.name)).toEqual(['www.nasa.gov', 'www.nasa.gov']);
    expect(answer.answers[0].data).toBe('step.nasa.gov');
  });
});

describe.each(FAMILIES)('answers left exactly as they came, %s', (_family, type, target) => {
  const untouched = (resp) => expect(splitWildcardChain(resp)).toBe(resp);

  it('a chain with no wildcard', () => {
    untouched(
      message({
        type,
        answers: [
          cname('www.nasa.gov', 'nasa-gov.go-vip.net'),
          rrsig('www.nasa.gov', 'CNAME', 3, 'nasa.gov'),
          target,
          rrsig('nasa-gov.go-vip.net', type, 3, 'go-vip.net'),
        ],
      }),
    );
  });

  it('a chain with no signatures, which is what DNSSEC off gets', () => {
    untouched(message({ type, answers: [cname('www.nasa.gov', 'nasa-gov.go-vip.net'), target] }));
  });

  it('the target asked for directly, wildcard or not', () => {
    untouched(
      message({
        name: 'nasa-gov.go-vip.net',
        type,
        answers: [target, rrsig('nasa-gov.go-vip.net', type, 2, 'go-vip.net')],
        authorities: [nsec, nsecSig],
      }),
    );
  });
});

describe('what cannot be split', () => {
  it('NXDOMAIN with a proof', () => {
    const resp = dnsPacket.encode({
      id: 1,
      type: 'response',
      flags: 3,
      questions: [{ type: 'A', name: 'nope.nasa.gov' }],
      answers: [],
      authorities: [nsec, nsecSig],
    });
    expect(splitWildcardChain(resp)).toBe(resp);
  });

  it('an answer that cannot be read', () => {
    const garbage = Buffer.from([1, 2, 3]);
    expect(splitWildcardChain(garbage)).toBe(garbage);
  });
});
