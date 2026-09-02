/**
 * Seed contradictory states that the 0.4.17 schema permits. Phase 2 keeps this
 * fixture as the upgrade and reconciliation baseline for later phases.
 */
export function seedLegacyLifecycleContradictions(db) {
  const subnetId = db.prepare(`
    INSERT INTO subnets
      (cidr, name, network_address, broadcast_address, prefix_length,
       total_addresses, gateway_address, status, domain_name)
    VALUES
      ('10.77.0.0/24', 'Lifecycle legacy fixture', '10.77.0.0',
       '10.77.0.255', 24, 256, '10.77.0.1', 'allocated', 'legacy.test')
  `).run().lastInsertRowid;

  const poolTypeId = db.prepare(
    "SELECT id FROM range_types WHERE name IN ('DHCP Scope', 'DHCP Pool') ORDER BY name DESC LIMIT 1"
  ).get().id;
  const rangeId = db.prepare(`
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
    VALUES (?, ?, '10.77.0.20', '10.77.0.200', 'Legacy dynamic pool')
  `).run(subnetId, poolTypeId).lastInsertRowid;
  const scopeId = db.prepare(`
    INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, enabled)
    VALUES (?, ?, '24h', 1)
  `).run(rangeId, subnetId).lastInsertRowid;

  const zoneId = db.prepare(`
    INSERT INTO dns_zones (name, type, enabled)
    VALUES ('legacy.test', 'forward', 1)
  `).run().lastInsertRowid;

  db.prepare(`
    INSERT INTO ip_addresses
      (subnet_id, ip_address, hostname, mac_address, status, is_online,
       is_rogue, rogue_reason, detection_source)
    VALUES
      (?, '10.77.0.40', 'locked-host', 'aa:bb:cc:dd:ee:40', 'locked', 1,
       1, 'legacy contradictory claim', 'scan')
  `).run(subnetId);
  db.prepare(`
    INSERT INTO dhcp_leases
      (subnet_id, ip_address, mac_address, hostname, expires_at)
    VALUES (?, '10.77.0.40', 'aa:bb:cc:dd:ee:40', 'leased-host', 'infinite')
  `).run(subnetId);

  db.prepare(`
    INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
    VALUES (?, 'dns-host', 'A', '10.77.0.50', 'manual', 1)
  `).run(zoneId);
  db.prepare(`
    INSERT INTO dhcp_reservations
      (subnet_id, ip_address, mac_address, hostname, enabled)
    VALUES (?, '10.77.0.50', 'aa:bb:cc:dd:ee:50', 'reserved-host', 1)
  `).run(subnetId);

  db.prepare(`
    INSERT INTO ip_addresses (subnet_id, ip_address, status)
    VALUES (?, '2001:0db8:0:0:0:0:0:60', 'available'),
           (?, '2001:db8::60', 'available'),
           (?, 'fe80::1', 'available')
  `).run(subnetId, subnetId, subnetId);

  db.prepare(`
    INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
    VALUES (?, 'disabled-dns', 'A', '10.77.0.70', 'manual', 0)
  `).run(zoneId);
  db.prepare(`
    INSERT INTO ip_addresses
      (subnet_id, ip_address, hostname, status, detection_source)
    VALUES (?, '10.77.0.70', 'disabled-dns.legacy.test', 'assigned', 'dns')
  `).run(subnetId);
  db.prepare(`
    INSERT INTO dhcp_reservations
      (subnet_id, ip_address, mac_address, hostname, enabled)
    VALUES (?, '10.77.0.71', 'aa:bb:cc:dd:ee:71', 'disabled-dhcp', 0)
  `).run(subnetId);
  db.prepare(`
    INSERT INTO ip_addresses
      (subnet_id, ip_address, hostname, mac_address, status, detection_source)
    VALUES (?, '10.77.0.71', 'disabled-dhcp', 'aa:bb:cc:dd:ee:71',
            'dhcp', 'dhcp_reservation')
  `).run(subnetId);

  return { subnetId, scopeId, zoneId };
}

export const FAMILY_NEUTRAL_LIFECYCLE_FIXTURES = Object.freeze({
  canonicalIpv6: Object.freeze({
    input: '2001:0DB8:0:0:0:0:0:80',
    canonical: '2001:db8::80',
    family: 6
  }),
  mappedIpv4: Object.freeze({
    input: '::ffff:10.77.0.80',
    canonical: '10.77.0.80',
    family: 4
  }),
  linkLocal: Object.freeze({
    input: 'fe80::80%eth0',
    canonical: 'fe80::80',
    interfaceContext: 'eth0'
  }),
  dhcpv6: Object.freeze({
    ip: '2001:db8::81',
    duid: '00:04:11:22:33:44:55:66',
    iaid: '7',
    validUntil: '2030-01-01T00:00:00.000Z'
  }),
  slaac: Object.freeze({
    ip: '2001:db8::82',
    preferredUntil: '2029-12-31T23:00:00.000Z',
    validUntil: '2030-01-01T00:00:00.000Z',
    temporary: true
  }),
  ipv6Subnet: Object.freeze({
    cidr: '2001:db8::/64',
    subnetRouterAnycast: '2001:db8::',
    broadcast: null
  })
});
