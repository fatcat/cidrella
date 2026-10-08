import { describe, it, expect, vi, beforeEach } from 'vitest';
import dnsPacket from 'dns-packet';
import net from 'net';

// dns-proxy is imported transitively (framing helpers); stub its side-effecting deps.
vi.mock('../../../src/utils/dnsmasq.js', () => ({
  applyInterfaceConfig: vi.fn(),
  restartDnsmasq: vi.fn(),
}));
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const {
  buildServfail,
  forwardDoT,
  forwardDoH,
  forwardPlain,
  queryUpstreams,
  getAndResetForwarderMetrics,
  heldProviders,
  releaseHolds,
} = await import('../../../src/utils/encrypted-forwarder.js');
const { pinnedLookup } = await import('../../../src/utils/upstream-pool.js');
const { plainDnsServer } = await import('../../helpers/plain-dns-server.js');

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

  it('carries an EDE when given one, so the proxy can name the cause', async () => {
    const { extractEde, failureCause } = await import('../../../src/utils/dns-ede.js');
    const resp = dnsPacket.decode(
      buildServfail(encodeQuery('example.com', { withDo: true }), { code: 22, text: 'none' }),
    );
    expect(extractEde(resp)).toEqual({ code: 22, text: 'none' });
    expect(failureCause(resp.rcode, extractEde(resp))).toBe('upstream');
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

describe('upstream failures in the journal', () => {
  it('logs the first failure, holds the rest for a minute, then says how many it held', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Start well clear of any line an earlier test logged.
    const start = Date.now() + 10 * 60 * 1000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const unreachable = { addresses: [], hostname: 'dns.example' };
    try {
      for (let i = 0; i < 3; i++) await forwardDoT(encodeQuery('x.com'), unreachable, 200);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('Upstream query failed: no upstream address');
      expect(warn.mock.calls[0][0]).toContain('"upstream":"dns.example"');

      now.mockReturnValue(start + 61 * 1000);
      await forwardDoT(encodeQuery('x.com'), unreachable, 200);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1][0]).toContain('"notLoggedSinceLastLine":2');
    } finally {
      warn.mockRestore();
      now.mockRestore();
    }
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
  ])('pins the lookup for %s to family %i in both callback forms', (address, family) => {
    // The HTTP/1.1 fallback connects through Node's lookup; it must hand back
    // the configured address in its own family.
    const lookup = pinnedLookup(address);
    const single = vi.fn();
    lookup('doh.test', {}, single);
    expect(single).toHaveBeenCalledWith(null, address, family);
    const all = vi.fn();
    lookup('doh.test', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address, family }]);
  });
});

// A provider that gave no answer is held; each test starts with none held.
beforeEach(() => releaseHolds());

describe('queryUpstreams: another provider when one fails', () => {
  const quad9 = { hostname: 'dns10.quad9.net', addresses: ['9.9.9.10', '2620:fe::10'] };
  const adguard = { hostname: 'unfiltered.adguard-dns.com', addresses: ['94.140.14.140'] };
  const answer = Buffer.from('answer');

  it('asks the next provider when the first gives no answer', async () => {
    const asked = [];
    const forward = async (_buf, upstream) => {
      asked.push(upstream.hostname);
      return upstream === adguard ? answer : null;
    };
    expect(await queryUpstreams(encodeQuery('x.example'), [quad9, adguard], { forward })).toBe(
      answer,
    );
    expect(asked).toEqual(['dns10.quad9.net', 'unfiltered.adguard-dns.com']);
  });

  it('starts where it is told and wraps round, so turns still spread the load', async () => {
    const asked = [];
    const forward = async (_buf, upstream) => {
      asked.push(upstream.hostname);
      return null;
    };
    expect(
      await queryUpstreams(encodeQuery('x.example'), [quad9, adguard], { first: 1, forward }),
    ).toBeNull();
    expect(asked).toEqual(['unfiltered.adguard-dns.com', 'dns10.quad9.net']);
  });

  it('hands every provider the same deadline and stops once it passes', async () => {
    const deadlines = [];
    const forward = async (_buf, _upstream, deadline) => {
      deadlines.push(deadline);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return null;
    };
    const out = await queryUpstreams(encodeQuery('x.example'), [quad9, adguard, quad9], {
      forward,
      budgetMs: 50,
    });
    expect(out).toBeNull();
    expect(deadlines).toHaveLength(1);
  });

  describe('holding a provider that gave no answer', () => {
    let clock;
    const now = () => clock;
    const asked = [];
    const forwardTo = (alive) => async (_buf, upstream) => {
      asked.push(upstream.hostname);
      return alive.includes(upstream) ? answer : null;
    };
    const ask = (forward, first = 0) =>
      queryUpstreams(encodeQuery('x.example'), [quad9, adguard], {
        first,
        forward,
        now,
        holdMs: 30_000,
      });

    beforeEach(() => {
      clock = 1_000_000;
      asked.length = 0;
    });

    it('asks a silent primary once, then goes to the backup until the hold ends', async () => {
      const backupOnly = forwardTo([adguard]);
      expect(await ask(backupOnly)).toBe(answer);
      expect(heldProviders(clock)).toEqual(['dns10.quad9.net']);
      clock += 10_000;
      expect(await ask(backupOnly)).toBe(answer);
      expect(asked).toEqual([
        'dns10.quad9.net',
        'unfiltered.adguard-dns.com',
        'unfiltered.adguard-dns.com',
      ]);

      // The hold ends: the primary is asked again, and answers.
      clock += 25_000;
      asked.length = 0;
      expect(await ask(forwardTo([quad9, adguard]))).toBe(answer);
      expect(asked).toEqual(['dns10.quad9.net']);
      expect(heldProviders(clock)).toEqual([]);
    });

    it('still asks held providers when all of them are held', async () => {
      await ask(forwardTo([]));
      expect(heldProviders(clock)).toEqual(['dns10.quad9.net', 'unfiltered.adguard-dns.com']);
      asked.length = 0;
      expect(await ask(forwardTo([adguard]))).toBe(answer);
      expect(asked).toEqual(['dns10.quad9.net', 'unfiltered.adguard-dns.com']);
    });

    it('under turns, skips the held provider when its turn comes', async () => {
      await ask(forwardTo([adguard])); // quad9 now held
      asked.length = 0;
      await ask(forwardTo([adguard]), 0);
      await ask(forwardTo([adguard]), 1);
      expect(asked).toEqual(['unfiltered.adguard-dns.com', 'unfiltered.adguard-dns.com']);
    });
  });

  it('keeps going past a provider that throws', async () => {
    const forward = async (_buf, upstream) => {
      if (upstream === quad9) throw new Error('boom');
      return answer;
    };
    expect(await queryUpstreams(encodeQuery('x.example'), [quad9, adguard], { forward })).toBe(
      answer,
    );
  });
});

describe('getAndResetForwarderMetrics', () => {
  it('counts a failover on the provider that gave no answer, then starts over', async () => {
    getAndResetForwarderMetrics();
    const quad9 = { hostname: 'dns10.quad9.net', addresses: ['9.9.9.10'] };
    const adguard = { hostname: 'unfiltered.adguard-dns.com', addresses: ['2a10:50c0::1:ff'] };
    const forward = async (_buf, upstream) => (upstream === adguard ? Buffer.from('ok') : null);
    await queryUpstreams(encodeQuery('x.example'), [quad9, adguard], { forward });
    // The last provider failing has no next one to fail over to.
    await queryUpstreams(encodeQuery('y.example'), [adguard, quad9], {
      forward: async () => null,
    });

    const rows = getAndResetForwarderMetrics();
    expect(rows.map((r) => [r.provider, r.address, r.failovers])).toEqual([
      ['dns10.quad9.net', '', 1],
      ['unfiltered.adguard-dns.com', '', 1],
    ]);
    // Counted under the forwarder's mode, plaintext until one is applied.
    expect(rows[0]).toMatchObject({ protocol: 'plain', latency_p50_us: null });
    expect(getAndResetForwarderMetrics()).toEqual([]);
  });

  it('counts each address over a real connection, either family', async () => {
    getAndResetForwarderMetrics();
    // Nothing listens on these: each is asked once and refuses.
    for (const address of ['127.0.0.1', '::1']) {
      await forwardDoT(
        encodeQuery('z.example'),
        { hostname: 'localhost', addresses: [address] },
        400,
      );
    }
    const rows = getAndResetForwarderMetrics();
    for (const address of ['127.0.0.1', '::1']) {
      const row = rows.find((r) => r.address === address);
      expect(row).toMatchObject({ provider: 'localhost', queries: 1, answers: 0 });
      expect(row.connect_failures + row.timeouts).toBe(1);
    }
  });
});

describe('forwardPlain', () => {
  beforeEach(() => getAndResetForwarderMetrics());

  it.each([
    ['UDP', false],
    ['TCP', true],
  ])('answers over %s from either family', async (_t, tcp) => {
    for (const address of ['127.0.0.1', '::1']) {
      const server = await plainDnsServer(address, { tcp });
      try {
        const answer = await forwardPlain(
          encodeQuery('a.example'),
          { label: address, hostname: '', addresses: [address] },
          Infinity,
          { tcp, port: server.port, timeoutMs: 1000 },
        );
        expect(dnsPacket.decode(answer).id).toBe(0x4242);
        expect(server.queries).toBe(1);
      } finally {
        server.close();
      }
    }
    const rows = getAndResetForwarderMetrics();
    expect(rows.map((r) => [r.protocol, r.address, r.queries, r.answers])).toEqual(
      expect.arrayContaining([
        ['plain', '127.0.0.1', 1, 1],
        ['plain', '::1', 1, 1],
      ]),
    );
  });

  it("moves to the resolver's next address when one gives no answer", async () => {
    // Only ::1 listens on the port, so 127.0.0.1 is asked and times out.
    const server = await plainDnsServer('::1');
    const resolver = { label: 'lab', hostname: '', addresses: ['127.0.0.1', '::1'] };
    try {
      const answer = await forwardPlain(encodeQuery('b.example'), resolver, Infinity, {
        port: server.port,
        timeoutMs: 150,
      });
      expect(answer).not.toBeNull();
    } finally {
      server.close();
    }
    const rows = getAndResetForwarderMetrics();
    expect(rows.find((r) => r.address === '127.0.0.1')).toMatchObject({
      provider: 'lab',
      queries: 1,
      answers: 0,
      timeouts: 1,
    });
    expect(rows.find((r) => r.address === '::1')).toMatchObject({ queries: 1, answers: 1 });
  });

  it('asks nothing once the deadline has passed', async () => {
    const answer = await forwardPlain(
      encodeQuery('c.example'),
      { label: 'lab', hostname: '', addresses: ['127.0.0.1'] },
      Date.now() - 1,
    );
    expect(answer).toBeNull();
    expect(getAndResetForwarderMetrics()).toEqual([]);
  });
});
