/**
 * A client that asks without EDNS still gets its failed answer's cause logged:
 * the proxy asks the backend with EDNS, so the answer can carry an Extended
 * DNS Error, and hands the client the answer without the OPT record it never
 * asked for. A client with EDNS keeps its own.
 *
 * Real sockets on 127.0.0.1 and ::1; a plain server stands in for the DNS
 * backend, failing every query and naming DNSSEC (EDE 6) when it can.
 */
import net from 'net';
import dgram from 'dgram';
import dnsPacket from 'dns-packet';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
// The proxy under test runs in this process.
vi.mock('../../src/utils/dns-proxy-client.js', async () =>
  (await import('../helpers/proxy-in-process.js')).inProcessProxyClient(),
);
vi.mock('../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const { setupTestDb, cleanupTestDb } = await import('../helpers/test-db.js');
const { freePort } = await import('../helpers/free-port.js');
const { plainDnsServer } = await import('../helpers/plain-dns-server.js');
const { frameTcpMessage, extractTcpMessages } = await import('../../src/utils/dns-wire.js');
const { extractEde } = await import('../../src/utils/dns-ede.js');
const Client = await import('../../src/utils/dns-proxy-client.js');

const encodeQuery = (name, edns) =>
  dnsPacket.encode({
    id: 99,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: 'A', name }],
    additionals: edns
      ? [{ type: 'OPT', name: '.', udpPayloadSize: 1232, flags: dnsPacket.DNSSEC_OK }]
      : [],
  });

function askUdp(address, port, message) {
  const sock = dgram.createSocket(address.includes(':') ? 'udp6' : 'udp4');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error(`no answer from ${address}`));
    }, 3000);
    sock.on('message', (reply) => {
      clearTimeout(timer);
      sock.close();
      resolve(dnsPacket.decode(reply));
    });
    sock.send(message, port, address);
  });
}

function askTcp(address, port, message) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, address);
    let buffer = Buffer.alloc(0);
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error(`no answer from ${address}`));
    });
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      const { messages, rest } = extractTcpMessages(Buffer.concat([buffer, chunk]));
      buffer = rest;
      if (!messages.length) return;
      sock.end();
      resolve(dnsPacket.decode(messages[0]));
    });
    sock.write(frameTcpMessage(message));
  });
}

let tmpDir;
let listenPort;
const backends = [];
const rows = [];

beforeAll(async () => {
  ({ tmpDir } = await setupTestDb());
  listenPort = await freePort();
  const internalPort = await freePort();
  for (const tcp of [false, true]) {
    backends.push(
      await plainDnsServer('127.0.0.1', { rcode: 'SERVFAIL', ede: 6, tcp, port: internalPort }),
    );
  }
  await Client.startProxyClient({ handlers: { queryRow: (row) => rows.push(row) } });
  Client.sendProxyConfig({
    proxy: {
      listenAddresses: ['127.0.0.1', '::1'],
      listenPort,
      internalPort,
      forwardsUnknownItself: true,
      queryLogPath: null,
      dnsOff: false,
      geoipDbPath: path.join(tmpDir, 'none.mmdb'),
    },
    defaults: {},
    serve: true,
  });
  await vi.waitFor(() => expect(Client.freshProxyStatus().server.bound).toBeGreaterThanOrEqual(2));
});

afterAll(() => {
  Client.stopProxyClient();
  for (const backend of backends) backend.close();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  rows.length = 0;
});

const rowFor = (name) =>
  vi.waitFor(() => {
    const row = rows.find((r) => r.domain === name);
    if (!row) throw new Error(`no query row for ${name} yet`);
    return row;
  });

describe('a client without EDNS', () => {
  for (const [transport, ask] of [
    ['UDP', askUdp],
    ['TCP', askTcp],
  ]) {
    for (const address of ['127.0.0.1', '::1']) {
      it(`gets no OPT record, and the log keeps the cause (${transport}, ${address})`, async () => {
        const name = `${transport}-${address.length}.bogus.example`.toLowerCase();
        const before = backends.reduce((sum, b) => sum + b.withEdns, 0);
        const reply = await ask(address, listenPort, encodeQuery(name, false));
        expect(reply.rcode).toBe('SERVFAIL');
        expect(reply.additionals).toEqual([]);
        expect(backends.reduce((sum, b) => sum + b.withEdns, 0)).toBe(before + 1);
        const row = await rowFor(name);
        expect(row).toMatchObject({ responseCode: 'SERVFAIL', ede: 6, failure: 'dnssec' });
      });
    }
  }
});

describe('a client with EDNS', () => {
  it('keeps its OPT record and the EDE in it, either family', async () => {
    for (const address of ['127.0.0.1', '::1']) {
      const name = `edns-${address.length}.bogus.example`;
      const reply = await askUdp(address, listenPort, encodeQuery(name, true));
      expect(extractEde(reply)?.code).toBe(6);
      const row = await rowFor(name);
      expect(row).toMatchObject({ ede: 6, failure: 'dnssec' });
    }
  });
});
