import { describe, expect, it } from 'vitest';
import {
  isImmutableNetworkAddress,
  managedDnsRecordMenuItem
} from '../../../src/utils/rowContextMenu.js';

describe('row context menu policy', () => {
  it.each([
    ['dns', 'Managed by forward DNS record'],
    ['dhcp', 'Managed by DHCP lease'],
    ['reservation', 'Managed by DHCP reservation'],
    ['placeholder', 'Generated reverse DNS placeholder']
  ])('gives %s-managed DNS rows an explanatory menu item', (source, label) => {
    expect(managedDnsRecordMenuItem({ dns_source: source })).toEqual({
      label,
      icon: 'pi pi-lock',
      disabled: true
    });
  });

  it('leaves operator-managed DNS rows editable', () => {
    expect(managedDnsRecordMenuItem({ dns_source: 'manual' })).toBeNull();
    expect(managedDnsRecordMenuItem({ dns_source: null })).toBeNull();
  });

  it('treats only the network and broadcast identities as immutable table rows', () => {
    expect(isImmutableNetworkAddress({ range_type_name: 'Network' })).toBe(true);
    expect(isImmutableNetworkAddress({ range_type_name: 'Broadcast' })).toBe(true);
    expect(isImmutableNetworkAddress({ range_type_name: 'Gateway' })).toBe(false);
    expect(isImmutableNetworkAddress({ range_type_name: 'DHCP Scope' })).toBe(false);
  });
});
