import { describe, it, expect, afterAll, vi } from 'vitest';
import net from 'net';
import dnsPacket from 'dns-packet';

// Avoid pulling in real dnsmasq / DuckDB side effects on import.
vi.mock('../../../src/utils/dnsmasq.js', () => ({
  applyInterfaceConfig: vi.fn(),
  restartDnsmasq: vi.fn(),
}));
vi.mock('../../../src/db/duckdb.js', () => ({
  logDnsQuery: vi.fn(),
}));

import { frameTcpMessage, extractTcpMessages } from '../../../src/utils/dns-wire.js';
import {
  relayQueryOverTcp,
  createNxdomainResponse, createBlockedResponse, getQueryOpt, classifyDnssecSupport,
} from '../../../src/utils/dns-proxy.js';

const stubServers = [];
afterAll(() => {
  for (const s of stubServers) { try { s.close(); } catch { /* ignore */ } }
});

function listen(server) {
  stubServers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function encodeQuery(name, { withDo = false } = {}) {
  const msg = {
    id: 0x1234,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: 'A', name }],
  };
  if (withDo) {
    msg.additionals = [{ type: 'OPT', name: '.', udpPayloadSize: 4096, flags: dnsPacket.DNSSEC_OK, options: [] }];
  }
  return dnsPacket.encode(msg);
}

describe('TCP framing', () => {
  it('frameTcpMessage prefixes the 2-byte big-endian length', () => {
    const payload = Buffer.from([0xaa, 0xbb, 0xcc]);
    const framed = frameTcpMessage(payload);
    expect(framed.readUInt16BE(0)).toBe(3);
    expect(framed.subarray(2)).toEqual(payload);
  });

  it('extractTcpMessages splits multiple complete messages', () => {
    const a = Buffer.from('aaaa', 'hex');
    const b = Buffer.from('bbbbbb', 'hex');
    const buf = Buffer.concat([frameTcpMessage(a), frameTcpMessage(b)]);
    const { messages, rest } = extractTcpMessages(buf);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(a);
    expect(messages[1]).toEqual(b);
    expect(rest.length).toBe(0);
  });

  it('extractTcpMessages leaves a partial trailing message in rest', () => {
    const a = Buffer.from('aaaa', 'hex');
    // full message + a length prefix promising 4 bytes but only 1 present
    const partial = Buffer.concat([frameTcpMessage(a), Buffer.from([0x00, 0x04, 0x01])]);
    const { messages, rest } = extractTcpMessages(partial);
    expect(messages).toHaveLength(1);
    expect(rest).toEqual(Buffer.from([0x00, 0x04, 0x01]));
  });
});

describe('relayQueryOverTcp', () => {
  it('relays a query and returns the upstream response bytes verbatim', async () => {
    const responseBytes = Buffer.from('deadbeef', 'hex');
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 2) return;
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) return;
        // echo a canned framed response
        sock.write(frameTcpMessage(responseBytes));
      });
    });
    const port = await listen(server);

    const out = await relayQueryOverTcp(Buffer.from('0001', 'hex'), '127.0.0.1', port, 1000);
    expect(out).toEqual(responseBytes);
  });

  it('resolves null on connection error (nothing listening)', async () => {
    // port 1 is privileged/closed, connect should fail fast
    const out = await relayQueryOverTcp(Buffer.from('0001', 'hex'), '127.0.0.1', 1, 500);
    expect(out).toBeNull();
  });

  it('resolves null on upstream timeout', async () => {
    const server = net.createServer(() => { /* accept but never respond */ });
    const port = await listen(server);
    const out = await relayQueryOverTcp(Buffer.from('0001', 'hex'), '127.0.0.1', port, 200);
    expect(out).toBeNull();
  });
});

describe('EDNS echo on synthesized responses', () => {
  it('echoes a DO-bit OPT record on NXDOMAIN when the query carried EDNS', () => {
    const query = dnsPacket.decode(encodeQuery('blocked.example.com', { withDo: true }));
    expect(getQueryOpt(query)).not.toBeNull();

    const resp = dnsPacket.decode(createNxdomainResponse(query));
    expect(resp.rcode).toBe('NXDOMAIN');
    const opt = resp.additionals.find(a => a.type === 'OPT');
    expect(opt).toBeTruthy();
    expect(opt.flag_do).toBe(true);
    // AD (authenticated-data) header flag must NOT be set for local policy.
    expect(resp.flag_ad).toBeFalsy();
  });

  it('omits OPT when the query carried no EDNS record', () => {
    const query = dnsPacket.decode(encodeQuery('blocked.example.com', { withDo: false }));
    const resp = dnsPacket.decode(createNxdomainResponse(query));
    expect(resp.additionals.find(a => a.type === 'OPT')).toBeUndefined();
  });

  it('createBlockedResponse (NXDOMAIN default) echoes EDNS too', () => {
    const query = dnsPacket.decode(encodeQuery('ads.example.com', { withDo: true }));
    const resp = dnsPacket.decode(createBlockedResponse(query));
    const opt = resp.additionals.find(a => a.type === 'OPT');
    expect(opt).toBeTruthy();
    expect(opt.flag_do).toBe(true);
  });
});

describe('DNSSEC support classification', () => {
  it('classifies validated and unsigned successful answers', () => {
    expect(classifyDnssecSupport(
      { rcode: 'NOERROR', flags: dnsPacket.AUTHENTIC_DATA },
      { enabled: true },
    )).toBe(true);
    expect(classifyDnssecSupport(
      { rcode: 'NOERROR', flags: 0 },
      { enabled: true },
    )).toBe(false);
  });

  it('leaves disabled, checking-disabled, and failed responses unknown', () => {
    const unsigned = { rcode: 'NOERROR', flags: 0 };
    expect(classifyDnssecSupport(unsigned, { enabled: false })).toBeNull();
    expect(classifyDnssecSupport(unsigned, { enabled: true, checkingDisabled: true })).toBeNull();
    expect(classifyDnssecSupport({ rcode: 'SERVFAIL', flags: 0 }, { enabled: true })).toBeNull();
  });
});
