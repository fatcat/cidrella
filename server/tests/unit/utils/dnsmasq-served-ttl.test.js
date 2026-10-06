/**
 * The TTL dnsmasq answers local records with. Only a CNAME line carries a
 * TTL; hosts-file entries (A, AAAA) and the other zone-file lines get
 * local-ttl, so the UI must show that rather than the stored TTL.
 */
import { describe, expect, it } from 'vitest';
import { LOCAL_TTL, servedRecordTtl } from '../../../src/utils/dnsmasq.js';

describe('servedRecordTtl', () => {
  it('serves A and AAAA with local-ttl whatever TTL they store', () => {
    expect(servedRecordTtl({ type: 'A', ttl: 900 })).toBe(LOCAL_TTL);
    expect(servedRecordTtl({ type: 'AAAA', ttl: 900 })).toBe(LOCAL_TTL);
    expect(servedRecordTtl({ type: 'A', ttl: null })).toBe(LOCAL_TTL);
  });

  it('serves MX, TXT, SRV and PTR with local-ttl', () => {
    for (const type of ['MX', 'TXT', 'SRV', 'PTR']) {
      expect(servedRecordTtl({ type, ttl: 300 })).toBe(LOCAL_TTL);
    }
  });

  it("serves a CNAME's own TTL, and local-ttl when it has none", () => {
    expect(servedRecordTtl({ type: 'CNAME', ttl: 900 })).toBe(900);
    expect(servedRecordTtl({ type: 'CNAME', ttl: null })).toBe(LOCAL_TTL);
    // The cname= line drops a TTL of 0, so dnsmasq falls back to local-ttl.
    expect(servedRecordTtl({ type: 'CNAME', ttl: 0 })).toBe(LOCAL_TTL);
  });
});
