/**
 * The EDNS helpers the DNS proxy uses for a client that asked without EDNS:
 * an OPT record added to the query, and the backend's taken out of the answer.
 */
import { describe, it, expect } from 'vitest';
import dnsPacket from 'dns-packet';
import { addEdns, removeOpt } from '../../../src/utils/dns-wire.js';
import { edeOption, extractEde } from '../../../src/utils/dns-ede.js';

const query = (type = 'A', name = 'example.com') =>
  dnsPacket.encode({
    id: 42,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type, name }],
  });

const opt = (options = []) => ({ type: 'OPT', name: '.', udpPayloadSize: 1232, flags: 0, options });

describe('addEdns', () => {
  it('adds an OPT record with a 512-byte limit and no DO bit', () => {
    const decoded = dnsPacket.decode(addEdns(query()));
    expect(decoded.additionals).toHaveLength(1);
    expect(decoded.additionals[0]).toMatchObject({ type: 'OPT', udpPayloadSize: 512 });
    expect(decoded.additionals[0].flags & dnsPacket.DNSSEC_OK).toBe(0);
    expect(decoded.questions).toEqual([{ type: 'A', name: 'example.com', class: 'IN' }]);
  });

  it('leaves a message too short to have a header alone', () => {
    const short = Buffer.from([1, 2, 3]);
    expect(addEdns(short)).toBe(short);
  });
});

describe('removeOpt', () => {
  it('gives back the query addEdns was given', () => {
    for (const type of ['A', 'AAAA']) {
      expect(removeOpt(addEdns(query(type)))).toEqual(query(type));
    }
  });

  it("takes the backend's OPT record, EDE and all, out of an answer of either family", () => {
    const answer = dnsPacket.encode({
      id: 42,
      type: 'response',
      flags: dnsPacket.RECURSION_AVAILABLE | 2,
      questions: [{ type: 'AAAA', name: 'bad.example' }],
      answers: [
        { type: 'AAAA', name: 'bad.example', ttl: 60, data: '2001:db8::1' },
        { type: 'A', name: 'bad.example', ttl: 60, data: '192.0.2.1' },
      ],
      additionals: [opt([edeOption(6)])],
    });
    expect(extractEde(dnsPacket.decode(answer)).code).toBe(6);
    const stripped = dnsPacket.decode(removeOpt(answer));
    expect(stripped.additionals).toEqual([]);
    expect(stripped.rcode).toBe('SERVFAIL');
    expect(stripped.answers.map((a) => a.data)).toEqual(['2001:db8::1', '192.0.2.1']);
  });

  it('reads past compressed names', () => {
    // Header, question example.com A, an answer named by a pointer to the
    // question (0xc00c), then the OPT record.
    const name = Buffer.from([7, ...Buffer.from('example'), 3, ...Buffer.from('com'), 0]);
    const answer = Buffer.concat([
      Buffer.from([0, 42, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 1]),
      name,
      Buffer.from([0, 1, 0, 1]),
      Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 7]),
      Buffer.from([0, 0, 41, 4, 0xd0, 0, 0, 0, 0, 0, 0]),
    ]);
    const stripped = dnsPacket.decode(removeOpt(answer));
    expect(stripped.additionals).toEqual([]);
    expect(stripped.answers[0]).toMatchObject({ name: 'example.com', data: '192.0.2.7' });
  });

  it('leaves an answer with no OPT record as it is', () => {
    const plain = query();
    expect(removeOpt(plain)).toBe(plain);
  });

  it('leaves an OPT record with a record after it', () => {
    const answer = dnsPacket.encode({
      id: 42,
      type: 'response',
      questions: [{ type: 'A', name: 'example.com' }],
      additionals: [opt(), { type: 'A', name: 'ns.example.com', ttl: 60, data: '192.0.2.53' }],
    });
    expect(removeOpt(answer)).toBe(answer);
  });

  it('leaves a message it cannot read', () => {
    const cut = addEdns(query()).subarray(0, 20);
    expect(removeOpt(cut)).toBe(cut);
    const badLabel = Buffer.concat([Buffer.from([0, 42, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x80])]);
    expect(removeOpt(badLabel)).toBe(badLabel);
  });
});
