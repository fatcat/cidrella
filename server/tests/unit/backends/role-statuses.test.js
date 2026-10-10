import { describe, it, expect, vi } from 'vitest';
import { roleStatuses } from '../../../src/backends/contract.js';
import { createFakeBackend } from '../../helpers/fake-backends.js';

describe('roleStatuses', () => {
  it('asks a service filling several roles once and shares the answer', () => {
    const shared = createFakeBackend({ name: 'one' });
    const status = vi.spyOn(shared, 'status');
    const out = roleStatuses(() => shared);
    expect(status).toHaveBeenCalledTimes(1);
    expect(out.dns).toBe(out.dhcp);
    expect(out.ra).toBe(out.dns);
    expect(out.dns).toMatchObject({ name: 'one', running: true, restartPending: false });
    expect(out.dns.capabilities.dhcpv6).toBe(true);
    expect(out.dns.features['dhcp6-stateful']).toBe(true);
  });

  it('reports each service under its own roles when DNS and DHCP differ', () => {
    const dns = createFakeBackend({
      name: 'powerdns',
      capabilities: { 'rec-dnssec-validate': true },
    });
    const dhcp = createFakeBackend({ name: 'kea' });
    const out = roleStatuses((role) => (role === 'dns' ? dns : dhcp));
    expect(out.dns.name).toBe('powerdns');
    expect(out.dns.capabilities.dnssec).toBe(true);
    expect(out.dns.features['rec-dnssec-validate']).toBe(true);
    expect(out.dhcp.name).toBe('kea');
    expect(out.ra).toBe(out.dhcp);
  });
});
