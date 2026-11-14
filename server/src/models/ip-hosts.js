/**
 * A network's hosts (docs/IPV6-HANDLING.md rule 5): its address rows grouped
 * into devices by `groupHosts` (utils/ip-hosts.js), paged by host, with the
 * vendor, the fingerprint and the host's addresses in the other family.
 *
 * A read model only. The rows are the network's stored rows with real facts
 * (`rowHasFactsSql`): an IPv4 network's empty placeholder rows are no host,
 * so the cost follows what is stored, never the network's size.
 */
import { lookupVendorBatch } from '../utils/mac-vendor.js';
import { activeLeaseSql } from '../utils/lease-sql.js';
import { groupHosts, hostMatches } from '../utils/ip-hosts.js';
import { lookupFingerprintBatch } from './device-fingerprint.js';
import { projectPersistedSubnetIpRows } from './subnet-ip-read.js';

const CHUNK = 900;

// The DUID and MAC pairs a lease or reservation of the network holds, which
// join a DHCPv6 address to the rows the neighbor table gave a MAC.
function duidLinks(db, subnetId) {
  return db
    .prepare(
      `SELECT lower(mac_address) AS mac, lower(duid) AS duid FROM dhcp_leases
        WHERE subnet_id = ? AND duid IS NOT NULL AND mac_address IS NOT NULL
       UNION
       SELECT lower(mac_address), lower(duid) FROM dhcp_reservations
        WHERE subnet_id = ? AND duid IS NOT NULL AND mac_address IS NOT NULL`,
    )
    .all(subnetId, subnetId);
}

// The other family's addresses of each MAC, from stored rows in any network
// and from that family's active leases and reservations: what joins a dual
// stack host's IPv6 addresses to its IPv4 one.
function otherFamilyByMac(db, macs, family) {
  const other = family === 6 ? 4 : 6;
  const found = new Map();
  const note = (row) => {
    const mac = row.mac;
    if (!found.has(mac)) found.set(mac, new Map());
    const key = `${row.subnet_id}|${row.ip_address}|${row.interface_id || ''}`;
    if (!found.get(mac).has(key)) {
      found.get(mac).set(key, {
        ip_address: row.ip_address,
        interface_id: row.interface_id || null,
        subnet_id: row.subnet_id ?? null,
        cidr: row.cidr || null,
        network_name: row.network_name || null,
        source: row.source,
      });
    }
  };
  for (let i = 0; i < macs.length; i += CHUNK) {
    const chunk = macs.slice(i, i + CHUNK);
    const marks = chunk.map(() => '?').join(',');
    db.prepare(
      `SELECT lower(COALESCE(ip.mac_address, ip.last_seen_mac)) AS mac, ip.ip_address,
              ip.interface_id, ip.subnet_id, s.cidr, s.name AS network_name, 'address' AS source
         FROM ip_addresses ip LEFT JOIN subnets s ON s.id = ip.subnet_id
        WHERE ip.address_family = ?
          AND lower(COALESCE(ip.mac_address, ip.last_seen_mac)) IN (${marks})`,
    )
      .all(other, ...chunk)
      .forEach(note);
    db.prepare(
      `SELECT lower(l.mac_address) AS mac, l.ip_address, NULL AS interface_id, l.subnet_id,
              s.cidr, s.name AS network_name, 'lease' AS source
         FROM dhcp_leases l LEFT JOIN subnets s ON s.id = l.subnet_id
        WHERE l.dhcp_version = ? AND ${activeLeaseSql('l')}
          AND lower(l.mac_address) IN (${marks})
       UNION ALL
       SELECT lower(r.mac_address), r.ip_address, NULL, r.subnet_id, s.cidr, s.name,
              'reservation'
         FROM dhcp_reservations r LEFT JOIN subnets s ON s.id = r.subnet_id
        WHERE r.address_family = ? AND r.enabled = 1 AND lower(r.mac_address) IN (${marks})`,
    )
      .all(other, ...chunk, other, ...chunk)
      .forEach(note);
  }
  return new Map([...found].map(([mac, list]) => [mac, [...list.values()]]));
}

// Vendor, fingerprint and the other family, for the hosts on the page only.
function attachHostFacts(db, hosts, family) {
  const macs = [...new Set(hosts.map((host) => host.mac).filter(Boolean))];
  const vendors = lookupVendorBatch(macs);
  const prints = lookupFingerprintBatch(db, macs);
  const otherFamily = macs.length ? otherFamilyByMac(db, macs, family) : new Map();
  for (const host of hosts) {
    const print = host.mac ? prints.get(host.mac) : null;
    host.vendor = host.mac ? vendors.get(host.mac) || null : null;
    host.device_type = print?.device_type || null;
    host.os_family = print?.os_family || null;
    host.other_family = host.mac ? otherFamily.get(host.mac) || [] : [];
  }
  return hosts;
}

/**
 * The hosts of a network, paged. `q` and `search` are the table's and the
 * explorer's search boxes (hostMatches), both applied;
 * `address` (with `interfaceId` for a link-local one) returns only the host
 * holding that address, for the address details panel.
 */
export function subnetHosts(
  db,
  subnet,
  { page = 1, pageSize = 50, q = '', search = '', address = null, interfaceId = null } = {},
) {
  const rows = projectPersistedSubnetIpRows(db, subnet, { withFacts: true }).filter(
    // The network address is topology, not a device.
    (row) => row.allocation_state !== 'system' || row.mac_address || row.last_seen_mac,
  );
  let hosts = groupHosts(rows, duidLinks(db, subnet.id));
  if (address) {
    hosts = hosts.filter((host) =>
      host.addresses.some(
        (a) => a.ip_address === address && (interfaceId ? a.interface_id === interfaceId : true),
      ),
    );
  } else {
    hosts = hosts.filter((host) => hostMatches(host, q) && hostMatches(host, search));
  }
  const total = hosts.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const slice = hosts.slice((current - 1) * pageSize, current * pageSize);
  return {
    hosts: attachHostFacts(db, slice, subnet.address_family === 6 ? 6 : 4),
    total,
    page: current,
    page_size: pageSize,
    total_pages: totalPages,
  };
}
