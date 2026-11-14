import { describe, it, expect, vi } from 'vitest';
import { roleStatuses } from '../../../src/backends/contract.js';
import { createFakeBackend } from '../../helpers/fake-backends.js';

describe('roleStatuses', () => {
  it('asks a service filling several roles once and shares the answer', async () => {
    const shared = createFakeBackend({ name: 'one' });
    const status = vi.spyOn(shared, 'status');
    const out = await roleStatuses(() => shared);
    expect(status).toHaveBeenCalledTimes(1);
    expect(out.dns).toBe(out.dhcp);
    expect(out.ra).toBe(out.dns);
    expect(out.dns).toMatchObject({ name: 'one', running: true, restartPending: false });
    expect(out.dns.capabilities.dhcpv6).toBe(true);
    expect(out.dns.features['dhcp6-stateful']).toBe(true);
  });

  it('reports each service under its own roles when DNS and DHCP differ', async () => {
    const dns = createFakeBackend({
      name: 'powerdns',
      capabilities: { 'rec-dnssec-validate': true },
    });
    const dhcp = createFakeBackend({ name: 'kea' });
    const out = await roleStatuses((role) => (role === 'dns' ? dns : dhcp));
    expect(out.dns.name).toBe('powerdns');
    expect(out.dns.capabilities.dnssec).toBe(true);
    expect(out.dns.features['rec-dnssec-validate']).toBe(true);
    expect(out.dhcp.name).toBe('kea');
    expect(out.ra).toBe(out.dhcp);
  });

  it('marks a service off when every role it fills is switched off, RA aside', async () => {
    const pdns = createFakeBackend({ name: 'pdns' });
    const kea = createFakeBackend({ name: 'kea' });
    const radvd = createFakeBackend({ name: 'radvd' });
    const split = { dns: pdns, dhcp: kea, ra: radvd };
    const dhcpOff = { switchedOff: (role) => role === 'dhcp' };
    const out = await roleStatuses((role) => split[role], dhcpOff);
    expect([out.dns.off, out.dhcp.off, out.ra.off]).toEqual([false, true, false]);

    // dnsmasq fills all three: off only once DNS and DHCP both are.
    const one = createFakeBackend({ name: 'dnsmasq' });
    expect((await roleStatuses(() => one, dhcpOff)).dns.off).toBe(false);
    expect((await roleStatuses(() => one, { switchedOff: (role) => role !== 'ra' })).dns.off).toBe(true);
    expect((await roleStatuses(() => one)).dns.off).toBe(false);
  });
});
