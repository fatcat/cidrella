import { describe, it, expect, vi } from 'vitest';
import dnsPacket from 'dns-packet';
import net from 'net';
import https from 'https';

// dns-proxy is imported transitively (framing helpers); stub its side-effecting deps.
vi.mock('../../../src/backends/dnsmasq/dnsmasq.js', () => ({
  applyInterfaceConfig: vi.fn(),
  restartDnsmasq: vi.fn(),
}));
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const { buildServfail, forwardDoT, forwardDoH } =
  await import('../../../src/utils/encrypted-forwarder.js');

function encodeQuery(name, { withDo = false } = {}) {
  const msg = {
    id: 0x4242,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: 'A', name }],
  };
  if (withDo)
    msg.additionals = [
      { type: 'OPT', name: '.', udpPayloadSize: 4096, flags: dnsPacket.DNSSEC_OK, options: [] },
    ];
  return dnsPacket.encode(msg);
}

describe('buildServfail', () => {
  it('produces a SERVFAIL preserving id + question', () => {
    const resp = dnsPacket.decode(buildServfail(encodeQuery('example.com')));
    expect(resp.rcode).toBe('SERVFAIL');
    expect(resp.id).toBe(0x4242);
    expect(resp.questions[0].name).toBe('example.com');
  });

  it('echoes the EDNS OPT (DO bit) when the query carried one', () => {
    const resp = dnsPacket.decode(buildServfail(encodeQuery('example.com', { withDo: true })));
    const opt = resp.additionals.find((a) => a.type === 'OPT');
    expect(opt).toBeTruthy();
    expect(opt.flag_do).toBe(true);
  });

  it('returns null for an undecodable buffer', () => {
    expect(buildServfail(Buffer.from([0, 1, 2]))).toBeNull();
  });
});

describe('fail-closed forwarding (no plaintext fallback)', () => {
  it('forwardDoT resolves null when the upstream is unreachable', async () => {
    // nothing listening on 127.0.0.1:853 in CI → connection refused → null
    const out = await forwardDoT(
      encodeQuery('example.com'),
      { addresses: ['127.0.0.1'], hostname: 'localhost' },
      400,
    );
    expect(out).toBeNull();
  });

  it('forwardDoH resolves null when the upstream is unreachable', async () => {
    const out = await forwardDoH(
      encodeQuery('example.com'),
      { addresses: ['127.0.0.1'], hostname: 'localhost', doh_url: 'https://localhost/dns-query' },
      400,
    );
    expect(out).toBeNull();
  });

  it('forwardDoT resolves null when no address is configured', async () => {
    expect(
      await forwardDoT(encodeQuery('x.com'), { addresses: [], hostname: 'h' }, 200),
    ).toBeNull();
  });
});

/**
 * DoH connects to the configured address, not to whatever the hostname
 * resolves to, through a custom `lookup`. Node (20 and later, with
 * autoSelectFamily on) calls it with { all: true } and expects an array; the
 * family must be the address's own, or an IPv6 upstream gets an IPv4 socket
 * (IPV6-23).
 */
function listener(host) {
  return new Promise((resolve, reject) => {
    const connections = [];
    const server = net.createServer((socket) => {
      connections.push(socket.remoteAddress);
      socket.destroy();
    });
    server.on('error', reject);
    server.listen(0, host, () => resolve({ server, connections, port: server.address().port }));
  });
}

const loopbackV6 = await listener('::1').then(
  ({ server }) => (server.close(), true),
  () => false,
);

describe('DoH connects to the configured upstream address', () => {
  it.each([
    ['IPv4', '127.0.0.1', true],
    ['IPv6', '::1', loopbackV6],
  ])('reaches a listener on %s', async (_label, address, available) => {
    if (!available) return; // no IPv6 loopback in this sandbox; the lookup test below still runs
    const { server, connections, port } = await listener(address);
    try {
      const out = await forwardDoH(
        encodeQuery('example.com'),
        {
          addresses: [address],
          hostname: 'doh.test',
          doh_url: `https://doh.test:${port}/dns-query`,
        },
        2000,
      );
      // The listener is not TLS, so the query fails closed, but only after
      // the connection arrived at the pinned address.
      expect(out).toBeNull();
      expect(connections).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it.each([
    ['2606:4700:4700::1111', 6],
    ['1.1.1.1', 4],
  ])('answers the lookup for %s with family %i in both callback forms', async (address, family) => {
    const spy = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('captured');
    });
    try {
      await forwardDoH(encodeQuery('example.com'), {
        addresses: [address],
        hostname: 'doh.test',
        doh_url: 'https://doh.test/dns-query',
      }).catch(() => null);
      const { lookup } = spy.mock.calls[0][0];
      const single = vi.fn();
      lookup('doh.test', {}, single);
      expect(single).toHaveBeenCalledWith(null, address, family);
      const all = vi.fn();
      lookup('doh.test', { all: true }, all);
      expect(all).toHaveBeenCalledWith(null, [{ address, family }]);
    } finally {
      spy.mockRestore();
    }
  });
});
