import { describe, expect, it } from 'vitest';
import { useIpDetailsDrawer } from '../../../src/composables/useIpDetailsDrawer.js';

describe('useIpDetailsDrawer', () => {
  it('opens the shared drawer with canonical row context', () => {
    const drawer = useIpDetailsDrawer();
    const row = { ip_address: '10.0.0.25', subnet_id: 7, hostname: 'host.example.test' };

    expect(drawer.openIpDetails(row, { domainName: 'example.test' })).toBe(true);
    expect(drawer.visible.value).toBe(true);
    expect(drawer.host.value).toStrictEqual(row);
    expect(drawer.subnetId.value).toBe(7);
    expect(drawer.domainName.value).toBe('example.test');
  });

  it('does not open for DNS records that do not identify an IP', () => {
    const drawer = useIpDetailsDrawer();

    expect(drawer.openIpDetails({ record_type: 'CNAME', value: 'target.example.test' })).toBe(false);
    expect(drawer.visible.value).toBe(false);
    expect(drawer.host.value).toBeNull();
  });
});
