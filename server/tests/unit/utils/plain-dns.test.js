import { describe, it, expect } from 'vitest';
import { plainDnsServer } from '../../helpers/plain-dns-server.js';
import { plainUdpQuery, plainTcpQuery } from '../../../src/utils/plain-dns.js';
import { nameQuery } from '../../../src/utils/upstream-probe.js';

describe.each(['127.0.0.1', '::1'])('plain DNS to %s', (address) => {
  it.each([
    ['UDP', false, plainUdpQuery],
    ['TCP', true, plainTcpQuery],
  ])('answers over %s, with the round trip', async (_t, tcp, send) => {
    const server = await plainDnsServer(address, { tcp });
    try {
      const query = nameQuery('example.com');
      const { answer, ms } = await send(address, query, { timeoutMs: 1000, port: server.port });
      expect(answer.readUInt16BE(0)).toBe(query.readUInt16BE(0));
      expect(ms).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
    }
  });

  it('tells a refused TCP connection from no answer in time', async () => {
    // Bound and closed again, so nothing listens on the port.
    const gone = await plainDnsServer(address, { tcp: true });
    gone.close();
    const refused = await plainTcpQuery(address, nameQuery('example.com'), {
      timeoutMs: 1000,
      port: gone.port,
    });
    expect(refused).toMatchObject({ answer: null, refused: true });

    const slow = await plainDnsServer(address, { tcp: true, delayMs: 500 });
    try {
      const late = await plainTcpQuery(address, nameQuery('example.com'), {
        timeoutMs: 100,
        port: slow.port,
      });
      expect(late).toMatchObject({ answer: null, refused: false });
    } finally {
      slow.close();
    }
  });
});

describe('plainUdpQuery when the send fails', () => {
  it.each(['127.0.0.1', '::1'])('resolves no answer from %s instead of throwing', async (address) => {
    // Port 0 cannot be sent to; the socket is closed once and nothing throws.
    const result = await plainUdpQuery(address, nameQuery('example.com'), {
      timeoutMs: 1000,
      port: 0,
    });
    expect(result.answer).toBeNull();
  });
});
