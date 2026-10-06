import { describe, expect, it } from 'vitest';
import { anyBackendDown, backendUnits, outageDetail } from '../../../src/utils/backend-status.js';

const status = (name, running = true) => ({
  name,
  running,
  restartPending: false,
  capabilities: {},
});

describe('backendUnits', () => {
  it('merges the roles one daemon fills into one unit', () => {
    const shared = status('dnsmasq');
    expect(backendUnits({ backends: { dns: shared, dhcp: shared, ra: shared } })).toEqual([
      {
        key: 'dnsmasq',
        name: 'dnsmasq',
        roles: ['dns', 'dhcp', 'ra'],
        running: true,
        restartPending: false,
      },
    ]);
  });

  it('gives DNS and DHCP their own units when different daemons fill them', () => {
    const units = backendUnits({
      backends: { dns: status('powerdns'), dhcp: status('kea', false), ra: status('kea', false) },
    });
    expect(units.map((u) => [u.name, u.roles, u.running])).toEqual([
      ['powerdns', ['dns'], true],
      ['kea', ['dhcp', 'ra'], false],
    ]);
  });

  it('reads the legacy dnsmasq flag from health and from metrics', () => {
    expect(backendUnits({ services: { dnsmasq: false } })).toMatchObject([
      { key: 'dnsmasq', running: false, roles: ['dns', 'dhcp', 'ra'] },
    ]);
    expect(backendUnits({ dnsmasq: true })).toMatchObject([{ key: 'dnsmasq', running: true }]);
  });

  it('prefers backends over the legacy flag, and yields nothing without either', () => {
    const units = backendUnits({ backends: { dns: status('kea') }, services: { dnsmasq: true } });
    expect(units.map((u) => u.name)).toEqual(['kea']);
    expect(backendUnits(null)).toEqual([]);
    expect(backendUnits({})).toEqual([]);
  });
});

describe('anyBackendDown', () => {
  it('is true when one unit of several is down', () => {
    expect(anyBackendDown({ backends: { dns: status('a'), dhcp: status('b', false) } })).toBe(true);
    expect(anyBackendDown({ backends: { dns: status('a'), dhcp: status('b') } })).toBe(false);
    expect(anyBackendDown(null)).toBe(false);
  });
});

describe('outageDetail', () => {
  it('names what stops, leaving RA out unless it is all the unit does', () => {
    expect(outageDetail({ roles: ['dns', 'dhcp', 'ra'] })).toBe(
      'No DNS answers or DHCP leases until it is back',
    );
    expect(outageDetail({ roles: ['dns'] })).toBe('No DNS answers until it is back');
    expect(outageDetail({ roles: ['ra'] })).toBe('No Router Advertisements until it is back');
  });
});
