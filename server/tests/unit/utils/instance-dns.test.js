/**
 * The DNS servers a DHCP client is given when several instances answer DNS:
 * CIDRella's entry in a scope's list becomes every instance, both families.
 */
import { describe, it, expect } from 'vitest';
import {
  instanceAddressFor,
  instanceDnsServers,
  MAX_SERVED_INSTANCES,
  servedInstances,
} from '../../../src/utils/instance-dns.js';

const controller = { addresses: ['10.60.0.2', '192.0.2.2', 'fd00:63::2', '2001:db8::2'] };
const memberOnNet = { addresses: ['10.60.0.3', 'fd00:63::3'] };
const memberElsewhere = { addresses: ['172.16.9.9', '2001:db8:9::9'] };
const three = [controller, memberOnNet, memberElsewhere];

describe('instanceAddressFor', () => {
  it('prefers an address inside the network, either family', () => {
    expect(instanceAddressFor(controller.addresses, { family: 4, cidr: '192.0.2.0/24' })).toBe(
      '192.0.2.2',
    );
    expect(instanceAddressFor(controller.addresses, { family: 6, cidr: '2001:db8::/64' })).toBe(
      '2001:db8::2',
    );
  });

  it('falls back to the first address of the family, and to nothing when it has none', () => {
    expect(instanceAddressFor(memberElsewhere.addresses, { family: 4, cidr: '10.60.0.0/24' })).toBe(
      '172.16.9.9',
    );
    expect(instanceAddressFor(memberElsewhere.addresses, { family: 6, cidr: 'fd00:63::/64' })).toBe(
      '2001:db8:9::9',
    );
    expect(instanceAddressFor(['10.0.0.1'], { family: 6, cidr: 'fd00:63::/64' })).toBeNull();
    expect(instanceAddressFor(['not-an-address'], { family: 4, cidr: '10.0.0.0/8' })).toBeNull();
  });
});

describe('instanceDnsServers', () => {
  it('leaves a single box as it is', () => {
    expect(
      instanceDnsServers('10.60.0.2', { family: 4, cidr: '10.60.0.0/24', instances: [controller] }),
    ).toBe('10.60.0.2');
    expect(
      instanceDnsServers('10.60.0.2', { family: 4, cidr: '10.60.0.0/24', instances: [] }),
    ).toBe('10.60.0.2');
  });

  it('serves every instance in place of CIDRella’s entry, the controller first (IPv4)', () => {
    expect(
      instanceDnsServers('10.60.0.2', { family: 4, cidr: '10.60.0.0/24', instances: three }),
    ).toBe('10.60.0.2,10.60.0.3,172.16.9.9');
  });

  it('does the same for IPv6, however the stored address is written', () => {
    expect(
      instanceDnsServers('FD00:0063:0:0:0:0:0:2', {
        family: 6,
        cidr: 'fd00:63::/64',
        instances: three,
      }),
    ).toBe('fd00:63::2,fd00:63::3,2001:db8:9::9');
  });

  it('recognizes any instance’s address as the entry, a member’s included', () => {
    expect(
      instanceDnsServers('10.60.0.3', { family: 4, cidr: '10.60.0.0/24', instances: three }),
    ).toBe('10.60.0.2,10.60.0.3,172.16.9.9');
    // The controller's address on another network still means CIDRella.
    expect(
      instanceDnsServers('192.0.2.2', { family: 4, cidr: '10.60.0.0/24', instances: three }),
    ).toBe('10.60.0.2,10.60.0.3,172.16.9.9');
  });

  it('keeps a person’s other resolvers where they put them, and lists no address twice', () => {
    expect(
      instanceDnsServers('9.9.9.9, 10.60.0.2, 1.1.1.1, 10.60.0.3', {
        family: 4,
        cidr: '10.60.0.0/24',
        instances: three,
      }),
    ).toBe('9.9.9.9,10.60.0.2,10.60.0.3,172.16.9.9,1.1.1.1');
  });

  it('serves a list that names no instance as it is', () => {
    expect(
      instanceDnsServers('9.9.9.9,1.1.1.1', { family: 4, cidr: '10.60.0.0/24', instances: three }),
    ).toBe('9.9.9.9,1.1.1.1');
    expect(instanceDnsServers('', { family: 4, cidr: '10.60.0.0/24', instances: three })).toBe('');
  });

  it('leaves out an instance with no address in the family', () => {
    const v4only = { addresses: ['10.60.0.4'] };
    expect(
      instanceDnsServers('fd00:63::2', {
        family: 6,
        cidr: 'fd00:63::/64',
        instances: [controller, v4only],
      }),
    ).toBe('fd00:63::2');
  });

  it('serves three instances at most, in order, and keeps a person’s resolvers (both families)', () => {
    const five = [
      controller,
      memberOnNet,
      memberElsewhere,
      { addresses: ['10.60.0.4', 'fd00:63::4'] },
      { addresses: ['10.60.0.5', 'fd00:63::5'] },
    ];
    expect(MAX_SERVED_INSTANCES).toBe(3);
    expect(
      instanceDnsServers('9.9.9.9,10.60.0.2,1.1.1.1', {
        family: 4,
        cidr: '10.60.0.0/24',
        instances: five,
      }),
    ).toBe('9.9.9.9,10.60.0.2,10.60.0.3,172.16.9.9,1.1.1.1');
    expect(
      instanceDnsServers('fd00:63::2', { family: 6, cidr: 'fd00:63::/64', instances: five }),
    ).toBe('fd00:63::2,fd00:63::3,2001:db8:9::9');
    // A left-out instance's address a person listed is not served either.
    expect(
      instanceDnsServers('10.60.0.2,10.60.0.5', {
        family: 4,
        cidr: '10.60.0.0/24',
        instances: five,
      }),
    ).toBe('10.60.0.2,10.60.0.3,172.16.9.9');
  });

  it('counts an instance with no address in a family out of that family only', () => {
    const v4only = (n) => ({ addresses: [`10.60.0.${n}`] });
    const v6only = { addresses: ['fd00:63::9'] };
    const list = [v4only(2), v4only(3), v4only(4), v4only(5), v6only];
    const served = servedInstances(list);
    expect(list.map((instance) => served.has(instance))).toEqual([true, true, true, false, true]);
    expect(
      instanceDnsServers('fd00:63::9', { family: 6, cidr: 'fd00:63::/64', instances: list }),
    ).toBe('fd00:63::9');
  });
});
