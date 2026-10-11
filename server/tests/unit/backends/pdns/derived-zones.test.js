/**
 * The zones the PowerDNS renderer adds so PowerDNS answers what dnsmasq
 * answers: PTRs made from the forward records for addresses in an allocated
 * network, and empty zones for the reserved names.
 */
import { describe, it, expect } from 'vitest';
import { desiredZones } from '../../../../src/backends/pdns/render.js';

const zone = (id, name, type = 'forward') => ({
  id,
  name,
  type,
  soa_primary_ns: 'ns1.example.test',
  soa_admin_email: 'admin@example.test',
  soa_serial: 7,
});

let nextId = 1;
const record = (z, name, type, value) => ({
  id: nextId++,
  zoneId: z.id,
  zoneName: z.name,
  zoneType: z.type,
  name,
  fqdn: name.endsWith('.') ? name.slice(0, -1) : `${name}.${z.name}`,
  type,
  value,
  ttl: null,
  priority: null,
  weight: null,
  port: null,
  ...(type === 'PTR' ? { placeholder: false } : {}),
});

const LAB = zone(1, 'lab.test');
const ptrOf = (zones, zoneName, owner) =>
  zones.get(zoneName)?.rrsets.get(`${owner}|PTR`)?.records ?? null;

describe('PTRs from the forward records', () => {
  it('makes a whole-network reverse zone for a private network, both families', () => {
    const zones = desiredZones({
      zones: [LAB],
      records: [
        record(LAB, 'nas', 'A', '10.5.0.20'),
        record(LAB, 'nas', 'AAAA', 'fd00:5::20'),
      ],
      networks: ['10.5.0.0/24', 'fd00:5::/64'],
    });
    expect(ptrOf(zones, '0.5.10.in-addr.arpa.', '20.0.5.10.in-addr.arpa.')).toEqual([
      'nas.lab.test.',
    ]);
    const v6Zone = '0.0.0.0.0.0.0.0.5.0.0.0.0.0.d.f.ip6.arpa.';
    const v6Owner = `0.2.${'0.'.repeat(14)}${v6Zone}`;
    expect(ptrOf(zones, v6Zone, v6Owner)).toEqual(['nas.lab.test.']);
    expect([...zones.get('0.5.10.in-addr.arpa.').rrsets.keys()]).toContain(
      '0.5.10.in-addr.arpa.|SOA',
    );
  });

  it('makes a zone of the one address in public space, so the rest resolves upstream', () => {
    const zones = desiredZones({
      zones: [LAB],
      records: [
        record(LAB, 'www', 'A', '203.1.7.9'),
        record(LAB, 'www', 'AAAA', '2001:4860::9'),
      ],
      networks: ['203.1.7.0/24', '2001:4860::/48'],
    });
    expect(ptrOf(zones, '9.7.1.203.in-addr.arpa.', '9.7.1.203.in-addr.arpa.')).toEqual([
      'www.lab.test.',
    ]);
    expect(zones.has('7.1.203.in-addr.arpa.')).toBe(false);
    const v6Owner = `9.${'0.'.repeat(23)}0.6.8.4.1.0.0.2.ip6.arpa.`;
    expect(ptrOf(zones, v6Owner, v6Owner)).toEqual(['www.lab.test.']);
  });

  it('puts the PTR in the CIDRella reverse zone covering it', () => {
    const REV = zone(2, '0.5.10.in-addr.arpa', 'reverse');
    const zones = desiredZones({
      zones: [LAB, REV],
      records: [record(LAB, 'nas', 'A', '10.5.0.20')],
      networks: ['10.5.0.0/16'],
    });
    expect(ptrOf(zones, '0.5.10.in-addr.arpa.', '20.0.5.10.in-addr.arpa.')).toEqual([
      'nas.lab.test.',
    ]);
    expect(zones.has('5.10.in-addr.arpa.')).toBe(false);
  });

  it('leaves an address with a PTR record served alone', () => {
    const REV = zone(2, '0.5.10.in-addr.arpa', 'reverse');
    const zones = desiredZones({
      zones: [LAB, REV],
      records: [
        record(LAB, 'nas', 'A', '10.5.0.20'),
        record(LAB, 'files', 'A', '10.5.0.20'),
        record(REV, '20', 'PTR', 'files.lab.test'),
      ],
      networks: ['10.5.0.0/24'],
    });
    expect(ptrOf(zones, '0.5.10.in-addr.arpa.', '20.0.5.10.in-addr.arpa.')).toEqual([
      'files.lab.test.',
    ]);
  });

  it('names the first name for an address, as dnsmasq does', () => {
    const zones = desiredZones({
      zones: [LAB],
      records: [record(LAB, 'one', 'A', '10.5.0.30'), record(LAB, 'two', 'A', '10.5.0.30')],
      networks: ['10.5.0.0/24'],
    });
    expect(ptrOf(zones, '0.5.10.in-addr.arpa.', '30.0.5.10.in-addr.arpa.')).toEqual([
      'one.lab.test.',
    ]);
  });

  it('makes nothing for an address outside every allocated network', () => {
    const zones = desiredZones({
      zones: [LAB],
      records: [record(LAB, 'far', 'A', '10.9.0.1'), record(LAB, 'far', 'AAAA', 'fd00:9::1')],
      networks: ['10.5.0.0/24'],
    });
    expect([...zones.keys()]).toEqual(['lab.test.']);
  });
});

describe('reserved names', () => {
  it('gets an empty zone for each, unless a zone has that name', () => {
    const HOME = zone(3, 'home.arpa');
    const zones = desiredZones(
      { zones: [HOME], records: [], networks: [] },
      { reserved: ['test', 'home.arpa', '8.e.f.ip6.arpa'] },
    );
    expect([...zones.keys()].sort()).toEqual(['8.e.f.ip6.arpa.', 'home.arpa.', 'test.']);
    expect([...zones.get('test.').rrsets.keys()]).toEqual(['test.|SOA', 'test.|NS']);
    expect(zones.get('home.arpa.').rrsets.get('home.arpa.|SOA').records[0]).toContain(
      'ns1.example.test.',
    );
  });
});
