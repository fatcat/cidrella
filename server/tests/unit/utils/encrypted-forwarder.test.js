import { describe, it, expect, vi } from 'vitest';
import dnsPacket from 'dns-packet';

// dns-proxy is imported transitively (framing helpers); stub its side-effecting deps.
vi.mock('../../../src/utils/dnsmasq.js', () => ({ applyInterfaceConfig: vi.fn(), restartDnsmasq: vi.fn() }));
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const { buildServfail, forwardDoT, forwardDoH } = await import('../../../src/utils/encrypted-forwarder.js');

function encodeQuery(name, { withDo = false } = {}) {
  const msg = { id: 0x4242, type: 'query', flags: dnsPacket.RECURSION_DESIRED, questions: [{ type: 'A', name }] };
  if (withDo) msg.additionals = [{ type: 'OPT', name: '.', udpPayloadSize: 4096, flags: dnsPacket.DNSSEC_OK, options: [] }];
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
    const opt = resp.additionals.find(a => a.type === 'OPT');
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
    const out = await forwardDoT(encodeQuery('example.com'), { addresses: ['127.0.0.1'], hostname: 'localhost' }, 400);
    expect(out).toBeNull();
  });

  it('forwardDoH resolves null when the upstream is unreachable', async () => {
    const out = await forwardDoH(encodeQuery('example.com'), { addresses: ['127.0.0.1'], hostname: 'localhost', doh_url: 'https://localhost/dns-query' }, 400);
    expect(out).toBeNull();
  });

  it('forwardDoT resolves null when no address is configured', async () => {
    expect(await forwardDoT(encodeQuery('x.com'), { addresses: [], hostname: 'h' }, 200)).toBeNull();
  });
});
