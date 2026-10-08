/**
 * scripts/check-dns-providers.js: what counts as a working resolver, and how
 * the release build tells a broken preset from a build host with no network.
 * The queries themselves go through the upstream pool, tested on its own.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import dnsPacket from 'dns-packet';

const require = createRequire(import.meta.url);
const { checkProviders, report } = require('../../../../scripts/check-dns-providers.js');
// The probe moved to the server, shared with the services health check.
const { answerProblem } = await import('../../../src/utils/upstream-probe.js');

function response({ rcode = 'NOERROR', answers = ['A', 'RRSIG'] } = {}) {
  return dnsPacket.encode({
    id: 1,
    type: 'response',
    flags: dnsPacket.RECURSION_AVAILABLE | { NOERROR: 0, SERVFAIL: 2 }[rcode],
    questions: [{ type: 'A', name: 'example.com' }],
    answers: answers.map((type) =>
      type === 'A'
        ? { type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }
        : {
            type: 'RRSIG',
            name: 'example.com',
            ttl: 60,
            data: {
              typeCovered: 'A',
              algorithm: 13,
              labels: 2,
              originalTTL: 60,
              expiration: 2000000000,
              inception: 1700000000,
              keyTag: 1,
              signersName: 'example.com',
              signature: Buffer.alloc(64),
            },
          },
    ),
  });
}

describe('answerProblem', () => {
  const transparent = { dnssecTransparent: true };

  it('accepts a signed answer', () => {
    expect(answerProblem(response(), transparent)).toBeNull();
  });

  it('refuses an error, an empty answer, or a stripped signature', () => {
    expect(answerProblem(response({ rcode: 'SERVFAIL' }), transparent)).toMatch(/SERVFAIL/);
    expect(answerProblem(response({ answers: [] }), transparent)).toMatch(/no A record/);
    expect(answerProblem(response({ answers: ['A'] }), transparent)).toMatch(/no RRSIG/);
    expect(answerProblem(response({ answers: ['A'] }), {})).toBeNull();
  });
});

const providers = [
  {
    id: 'one',
    hostname: 'one.test',
    doh_url: 'https://one.test/dns-query',
    addresses: ['192.0.2.1', '2001:db8::1'],
  },
  {
    id: 'two',
    hostname: 'two.test',
    doh_url: 'https://two.test/dns-query',
    addresses: ['198.51.100.1'],
  },
];

describe('checkProviders and report', () => {
  it('asks every address of every preset over DoT and DoH', async () => {
    const probe = vi.fn(async () => ({ problem: null, connected: true }));
    const result = await checkProviders(providers, probe);
    expect(probe.mock.calls.map(([a]) => `${a.provider.id} ${a.address} ${a.protocol}`)).toEqual([
      'one 192.0.2.1 dot',
      'one 192.0.2.1 doh',
      'one 2001:db8::1 dot',
      'one 2001:db8::1 doh',
      'two 198.51.100.1 dot',
      'two 198.51.100.1 doh',
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(report(result)).toBe(0);
    log.mockRestore();
  });

  it('stops the build on one address that does not resolve, naming it', async () => {
    const probe = async ({ address, protocol }) =>
      address === '198.51.100.1' && protocol === 'doh'
        ? { problem: 'answered SERVFAIL for example.com', connected: true }
        : { problem: null, connected: true };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(report(await checkProviders(providers, probe))).toBe(1);
      const lines = err.mock.calls.map(([line]) => line).join('\n');
      expect(lines).toContain(
        'two 198.51.100.1 DoH (hostname two.test, https://two.test/dns-query)',
      );
      expect(lines).not.toContain('192.0.2.1 ');
    } finally {
      err.mockRestore();
    }
  });

  it('tries a failed address once more before calling the preset broken', async () => {
    const seen = new Set();
    const probe = vi.fn(async ({ address, protocol }) => {
      const key = `${address} ${protocol}`;
      if (address === '192.0.2.1' && protocol === 'dot' && !seen.has(key)) {
        seen.add(key);
        return { problem: 'connection closed', connected: false };
      }
      return { problem: null, connected: true };
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(report(await checkProviders(providers, probe))).toBe(0);
      expect(probe).toHaveBeenCalledTimes(7);
    } finally {
      log.mockRestore();
    }
  });

  it('blames the network, not the presets, when one protocol never answered', async () => {
    const probe = async ({ protocol }) =>
      protocol === 'dot'
        ? { problem: 'connect ETIMEDOUT', connected: false }
        : { problem: null, connected: true };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(report(await checkProviders(providers, probe))).toBe(3);
      const lines = err.mock.calls.map(([line]) => line).join('\n');
      expect(lines).toContain(
        'No preset answered over DoT; check that this host can reach TCP port 853.',
      );
      expect(lines).not.toContain('Broken encrypted DNS presets');
    } finally {
      err.mockRestore();
    }
  });

  it('still stops on a broken preset when the other protocol is blocked', async () => {
    const probe = async ({ address, protocol }) =>
      protocol === 'dot'
        ? { problem: 'connect ETIMEDOUT', connected: false }
        : address === '198.51.100.1'
          ? { problem: 'answered SERVFAIL for example.com', connected: true }
          : { problem: null, connected: true };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(report(await checkProviders(providers, probe))).toBe(1);
    } finally {
      err.mockRestore();
    }
  });

  it('calls it the network when nothing answered at all', async () => {
    const probe = async () => ({ problem: 'connect ENETUNREACH', connected: false });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(report(await checkProviders(providers, probe))).toBe(3);
    } finally {
      err.mockRestore();
    }
  });
});
