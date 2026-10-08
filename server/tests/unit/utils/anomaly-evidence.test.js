import { describe, expect, it } from 'vitest';
import {
  hasSignalEvidence,
  rankDomainsForSignal,
  shannonEntropy,
} from '../../../src/utils/anomaly-evidence.js';

const row = (domain, extra = {}) => ({
  domain,
  count: 1,
  nxdomain_count: 0,
  blocked_count: 0,
  other_type_count: 0,
  unresolved_count: 0,
  resolved_ip_count: 1,
  ...extra,
});

describe('anomaly evidence ranking', () => {
  it('measures entropy the way the sidecar does', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBe(1);
    expect(shannonEntropy('q7x2k9p4m1z8.example.net')).toBeGreaterThan(
      shannonEntropy('www.example.net'),
    );
  });

  it('ranks the entropy signal by the names that look random, not by count', () => {
    const rows = [
      row('cdn.example.com', { count: 900 }),
      row('a8f3k2m9x1q7.upd.tunnel.net', { count: 1 }),
      row('www.example.com', { count: 300 }),
    ];
    const out = rankDomainsForSignal('avg_domain_entropy', rows, 2);
    expect(out.metric).toBe('entropy');
    expect(out.total).toBe(3);
    expect(out.items.map((i) => i.domain)[0]).toBe('a8f3k2m9x1q7.upd.tunnel.net');
    expect(out.items).toHaveLength(2);
    expect(out.items[0].value).toBeGreaterThan(out.items[1].value);
  });

  it('keeps only the names that contribute to a rate signal', () => {
    const rows = [
      row('fine.example.com', { count: 50 }),
      row('missing.example.com', { count: 4, nxdomain_count: 4 }),
      row('ads.example.com', { count: 12, blocked_count: 12 }),
    ];
    expect(rankDomainsForSignal('nxdomain_ratio', rows).items).toEqual([
      { domain: 'missing.example.com', count: 4, value: 4 },
    ]);
    expect(rankDomainsForSignal('block_ratio', rows).items.map((i) => i.domain)).toEqual([
      'ads.example.com',
    ]);
  });

  it('groups by TLD for the diversity signal and sizes names for length and depth', () => {
    const rows = [row('a.example.com'), row('b.example.com'), row('c.example.org', { count: 5 })];
    const tld = rankDomainsForSignal('tld_diversity', rows);
    // Ranked by how many distinct names each TLD carried, not by query count.
    expect(tld.items[0]).toEqual({ domain: 'com', count: 2, value: 2 });
    expect(tld.items[1]).toEqual({ domain: 'org', count: 5, value: 1 });
    expect(rankDomainsForSignal('max_domain_length', rows).items[0].value).toBe(13);
    expect(rankDomainsForSignal('subdomain_depth_mean', rows).items[0].value).toBe(3);
  });

  it('offers no name-level evidence for time-of-day style signals', () => {
    expect(hasSignalEvidence('hour_cos')).toBe(false);
    expect(hasSignalEvidence('avg_domain_entropy')).toBe(true);
    expect(rankDomainsForSignal('hour_cos', [])).toBeNull();
  });
});
