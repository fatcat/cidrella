import { describe, expect, it } from 'vitest';
import { ipSourceLabel } from '../../../src/utils/ipTableDisplay.js';

describe('ipSourceLabel', () => {
  it('names a served record static DNS and a held one a disabled record', () => {
    expect(ipSourceLabel({ allocation_state: 'static_dns', allocation_source_type: 'dns' })).toBe(
      'Static DNS',
    );
    expect(ipSourceLabel({ allocation_state: 'reserved', allocation_source_type: 'dns' })).toBe(
      'Disabled DNS record',
    );
    expect(
      ipSourceLabel({ allocation_state: 'reserved', allocation_source_type: 'admin_reservation' }),
    ).toBe('Admin reservation');
  });

  it('prefers the DNS record source on a DNS row', () => {
    expect(
      ipSourceLabel({
        dns_source: 'manual',
        allocation_state: 'reserved',
        allocation_source_type: 'dns',
      }),
    ).toBe('Manual');
  });
});
