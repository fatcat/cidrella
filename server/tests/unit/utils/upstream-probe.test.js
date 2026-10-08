import { describe, it, expect } from 'vitest';
import dgram from 'dgram';
import {
  probeAddress,
  timeQuery,
  nameQuery,
  uncachedName,
} from '../../../src/utils/upstream-probe.js';
import { plainDnsServer } from '../../helpers/plain-dns-server.js';
import { plainUdpQuery } from '../../../src/utils/plain-dns.js';

// The answer checks are in check-dns-providers.test.js and the connection
// handling in upstream-pool.test.js; this is what a probe reports.
describe('probeAddress', () => {
  it.each(['127.0.0.1', '::1'])(
    'reports a refused DoT connection at %s, with the time it took',
    async (address) => {
      const result = await probeAddress({
        provider: { hostname: 'localhost' },
        address,
        protocol: 'dot',
        timeoutMs: 400,
      });
      expect(result.connected).toBe(false);
      expect(result.problem).toBeTruthy();
      expect(result.ms).toBeGreaterThanOrEqual(0);
    },
  );
});

describe('plain queries for the resolver test', () => {
  it.each(['127.0.0.1', '::1'])('times an answer from %s', async (address) => {
    const server = await plainDnsServer(address);
    try {
      const result = await timeQuery({
        protocol: 'plain',
        address,
        name: 'example.com',
        timeoutMs: 1000,
        port: server.port,
      });
      expect(result.problem).toBeNull();
      expect(result.ms).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it.each(['127.0.0.1', '::1'])('gives up on %s when nothing answers', async (address) => {
    const server = await plainDnsServer(address);
    server.close(); // the port is now silent
    const result = await timeQuery({
      protocol: 'plain',
      address,
      name: 'example.com',
      timeoutMs: 150,
      port: server.port,
    });
    expect(result.problem).toBe('no answer');
  });

  it('counts NXDOMAIN as an answer and SERVFAIL as a failure', async () => {
    for (const [rcode, problem] of [
      ['NXDOMAIN', null],
      ['SERVFAIL', 'answered SERVFAIL'],
    ]) {
      const server = await plainDnsServer('127.0.0.1', { rcode });
      try {
        const result = await timeQuery({
          protocol: 'plain',
          address: '127.0.0.1',
          name: uncachedName('example.com'),
          timeoutMs: 1000,
          port: server.port,
        });
        expect(result.problem).toBe(problem);
      } finally {
        server.close();
      }
    }
  });

  it('ignores a reply with the wrong id', async () => {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (message, rinfo) => {
      const wrong = Buffer.from(message);
      wrong.writeUInt16BE((message.readUInt16BE(0) + 1) & 0xffff, 0);
      socket.send(wrong, rinfo.port, rinfo.address);
    });
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    try {
      const { answer } = await plainUdpQuery('127.0.0.1', nameQuery('example.com'), {
        timeoutMs: 150,
        port: socket.address().port,
      });
      expect(answer).toBeNull();
    } finally {
      socket.close();
    }
  });

  it('makes a fresh random name each time, under the zone', () => {
    const a = uncachedName('apple.com');
    expect(a).toMatch(/^[0-9a-f]{16}\.apple\.com$/);
    expect(uncachedName('apple.com')).not.toBe(a);
  });
});
