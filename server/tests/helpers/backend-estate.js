/**
 * One estate with something of everything a DNS/DHCP backend is told about:
 * v4 and v6 scopes in every mode, v4 and DUID reservations, every record
 * type, a disabled zone. The backend golden tests seed it and snapshot what
 * each adapter renders from it.
 */
import { parseNetwork } from '../../src/utils/cidr.js';
import { insertSubnet, configureSubnet } from '../../src/services/subnet-topology.js';
import { invalidateSubnetCache } from '../../src/utils/ip-sync.js';

// os.networkInterfaces() for the estate. eth0 is on 10.60.0.0/24; no
// interface is on any of the estate's IPv6 networks.
export const ESTATE_INTERFACES = {
  lo: [
    { family: 'IPv4', address: '127.0.0.1', internal: true },
    { family: 'IPv6', address: '::1', internal: true },
  ],
  eth0: [
    { family: 'IPv4', address: '10.60.0.2', internal: false },
    { family: 'IPv6', address: 'fd00:60::2', internal: false },
    { family: 'IPv6', address: 'fe80::2', internal: false },
  ],
  eth1: [{ family: 'IPv4', address: '10.61.0.2', internal: false }],
};

/** Add an allocated network, configured as the network dialog would. */
export function network(db, cidr, fields) {
  const id = insertSubnet(db, {
    cidr,
    name: cidr,
    status: 'unallocated',
    depth: 0,
  }).lastInsertRowid;
  const parsed = parseNetwork(cidr);
  configureSubnet(db, db.prepare('SELECT * FROM subnets WHERE id = ?').get(id), parsed, {
    name: cidr,
    gateway: parsed.firstUsable,
    gateway_policy: 'first',
    ...fields,
  });
  invalidateSubnetCache();
  return Number(id);
}

function record(db, zoneId, name, type, value, extra = {}) {
  db.prepare(
    `INSERT INTO dns_records (zone_id, name, type, value, priority, weight, port, ttl, enabled, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
  ).run(
    zoneId,
    name,
    type,
    value,
    extra.priority ?? null,
    extra.weight ?? null,
    extra.port ?? null,
    extra.ttl ?? null,
    extra.enabled ?? 1,
  );
}

const zoneIdOf = (db, name) => db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(name).id;

/** Seed the estate into a migrated, IPv6-enabled test database. */
export function seedBackendEstate(db) {
  // IPv4 network with a pool, a domain and reverse DNS.
  const v4 = network(db, '10.60.0.0/24', {
    domain_name: 'golden.test',
    create_reverse_dns: true,
    create_dhcp_scope: true,
    dhcpPool: {
      startLong: Number(parseNetwork('10.60.0.100/32').networkLong),
      endLong: Number(parseNetwork('10.60.0.199/32').networkLong),
    },
  });
  const v4Scope = db.prepare('SELECT id FROM dhcp_scopes WHERE subnet_id = ?').get(v4).id;
  db.prepare(
    "INSERT OR REPLACE INTO dhcp_scope_options (scope_id, option_code, value, address_family) VALUES (?, 66, 'tftp.golden.test', 4)",
  ).run(v4Scope);
  db.prepare(
    "INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, hostname, address_family) VALUES (?, 'aa:bb:cc:00:00:01', '10.60.0.50', 'printer', 4)",
  ).run(v4);
  db.prepare(
    "INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, address_family) VALUES (?, 'aa:bb:cc:00:00:02', '10.60.0.51', 4)",
  ).run(v4);

  // IPv6 in every mode, one with reverse DNS.
  network(db, 'fd00:61::/64', { create_dhcp_scope: true, dhcpV6: { mode: 'slaac', pool: null } });
  network(db, 'fd00:62::/64', {
    create_dhcp_scope: true,
    dhcpV6: { mode: 'stateless', pool: null },
  });
  const v6 = network(db, 'fd00:63::/64', {
    domain_name: 'golden.test',
    create_reverse_dns: true,
    create_dhcp_scope: true,
    dhcpV6: { mode: 'stateful', pool: null },
  });
  db.prepare(
    "INSERT INTO dhcp_reservations (subnet_id, duid, iaid, ip_address, hostname, address_family) VALUES (?, '00:01:00:01:2a:2b:2c:2d:aa:bb:cc:00:00:03', 7, 'fd00:63::50', 'nas', 6)",
  ).run(v6);

  // Every record type, served and unserved PTRs, both families.
  const fwd = zoneIdOf(db, 'golden.test');
  record(db, fwd, 'web', 'A', '10.60.0.10');
  record(db, fwd, 'web', 'AAAA', 'fd00:63::10');
  record(db, fwd, 'www', 'CNAME', 'web.golden.test', { ttl: 300 });
  record(db, fwd, '@', 'MX', 'mail.golden.test', { priority: 5 });
  record(db, fwd, '@', 'TXT', 'v=spf1 "quoted" -all');
  record(db, fwd, '_sip._tcp', 'SRV', 'sip.golden.test', { port: 5060, priority: 1, weight: 2 });
  record(db, fwd, 'off', 'A', '10.60.0.11', { enabled: 0 });
  const rev4 = db
    .prepare("SELECT id FROM dns_zones WHERE type = 'reverse' AND name LIKE '%in-addr.arpa'")
    .get().id;
  record(db, rev4, '10', 'PTR', 'web.golden.test');
  record(db, rev4, '12', 'PTR', 'elsewhere.example.net');
  const rev6 = db
    .prepare("SELECT id FROM dns_zones WHERE type = 'reverse' AND name LIKE '%ip6.arpa'")
    .get().id;
  record(db, rev6, '0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0', 'PTR', 'web.golden.test');

  // A disabled zone writes nothing.
  db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('off.test', 'forward', 0)").run();
  record(db, zoneIdOf(db, 'off.test'), 'gone', 'CNAME', 'web.golden.test');
}
