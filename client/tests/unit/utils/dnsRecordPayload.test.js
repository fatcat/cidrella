import { describe, expect, it } from 'vitest';
import { dnsRecordPayload } from '../../../src/utils/dnsRecordPayload.js';

// T-21: every RR type sends only the fields it owns; zero survives, empty
// becomes null, and a value typed under a previous type never leaks.
describe('dnsRecordPayload', () => {
  const base = { name: 'svc', value: '10.0.0.5', ttl: null, enabled: true };

  it('sends A, CNAME, TXT and PTR without priority, weight or port', () => {
    for (const type of ['A', 'CNAME', 'TXT', 'PTR']) {
      expect(dnsRecordPayload({ ...base, type, priority: 10, weight: 5, port: 80 })).toEqual({
        name: 'svc',
        type,
        value: '10.0.0.5',
        enabled: true,
        priority: null,
        weight: null,
        port: null,
        ttl: null,
      });
    }
  });

  it('keeps zero as a value and drops empty numbers to null', () => {
    expect(
      dnsRecordPayload({ ...base, type: 'MX', priority: 0, weight: 7, port: '', ttl: 0 }),
    ).toEqual({
      name: 'svc',
      type: 'MX',
      value: '10.0.0.5',
      enabled: true,
      priority: 0,
      weight: null,
      port: null,
      ttl: 0,
    });
    expect(
      dnsRecordPayload({ ...base, type: 'srv', priority: '5', weight: 0, port: '443', ttl: '' }),
    ).toMatchObject({ type: 'SRV', priority: 5, weight: 0, port: 443, ttl: null });
  });

  it('treats a missing enabled flag as enabled and false as disabled', () => {
    expect(dnsRecordPayload({ ...base, type: 'A', enabled: undefined }).enabled).toBe(true);
    expect(dnsRecordPayload({ ...base, type: 'A', enabled: false }).enabled).toBe(false);
  });
});
