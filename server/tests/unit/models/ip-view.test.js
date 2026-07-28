import { describe, it, expect } from 'vitest';
import { computeIpView, ADDRESS_TYPE } from '../../../src/models/ip-view.js';

// computeIpView decides the label on every row of the Networks table. It is a
// pure function of one row, so it is cheap to pin down.
//
// Two of its branches INFER "rogue" from "online but nothing claims this
// address". Both used to ignore has_static_dns even though the same function
// computes it, so a host with a manual A record was labelled rogue on sight.

function view(row) {
  return computeIpView({ ip_address: '10.0.1.50', status: 'available', ...row });
}

describe('computeIpView: rogue inference respects a DNS claim', () => {
  it('labels an online unclaimed address rogue', () => {
    expect(view({ is_online: 1 }).address_type).toBe(ADDRESS_TYPE.ROGUE);
  });

  it('labels the same address static DNS once a manual A record claims it', () => {
    expect(view({ is_online: 1, has_static_dns: 1 }).address_type).toBe(ADDRESS_TYPE.STATIC_DNS);
  });

  it('does not infer rogue for a DHCP-status address that DNS claims', () => {
    expect(view({ is_online: 1, ip_lifecycle_status: 'dhcp', has_static_dns: 1 }).address_type)
      .toBe(ADDRESS_TYPE.STATIC_DNS);
  });

  it('still labels a DHCP-status address rogue when nothing claims it', () => {
    expect(view({ is_online: 1, ip_lifecycle_status: 'dhcp' }).address_type)
      .toBe(ADDRESS_TYPE.ROGUE);
  });

  it('keeps an explicitly flagged rogue flagged, a DNS name does not excuse a conflict', () => {
    // The stored flag can carry a real reason such as a MAC mismatch, so the
    // is_rogue branch is deliberately NOT softened by has_static_dns.
    const row = view({
      is_online: 1,
      is_rogue: 1,
      rogue_reason: 'MAC mismatch (expected aa:bb:cc:dd:ee:ff, got 11:22:33:44:55:66)',
      has_static_dns: 1,
    });
    expect(row.address_type).toBe(ADDRESS_TYPE.ROGUE);
    expect(row.address_type_tooltip).toContain('MAC mismatch');
  });

  it('prefers reservation and lease labels over a DNS claim', () => {
    expect(view({ is_online: 1, has_dhcp_reservation: 1, has_static_dns: 1 }).address_type)
      .toBe(ADDRESS_TYPE.RESERVED_DHCP);
    expect(view({ is_online: 1, dhcp_expires_at: 'infinite', has_static_dns: 1 }).address_type)
      .toBe(ADDRESS_TYPE.DYNAMIC_DHCP);
  });

  it('leaves system and gateway rows alone', () => {
    expect(view({ is_online: 1, range_type_name: 'Gateway' }).address_type).toBe(ADDRESS_TYPE.GATEWAY);
    expect(view({ is_online: 1, range_type_name: 'Broadcast' }).address_type).toBe(ADDRESS_TYPE.SYSTEM);
  });

  it('an offline unclaimed address is not rogue, it is just available', () => {
    expect(view({ is_online: 0 }).address_type).toBeNull();
  });
});
