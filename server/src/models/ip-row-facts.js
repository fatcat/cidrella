/**
 * The facts one table has about an address, attached to the rows of the
 * others. The Addresses, DNS and DHCP tables are one table model: any of them
 * can show any column (client views/networks-workspace/workspace-columns.js),
 * so an address row carries the DNS record and the DHCP reservation or lease
 * behind it, and a DNS row carries its address's DHCP facts. The address view
 * itself (status, type, lease state) stays ip-view.js's.
 *
 * Attached as nested objects, `dns_record` and `dhcp`, so a DHCP row's own
 * `enabled` never collides with a record's.
 */
import { getScopePools } from './dhcp-scope.js';
import { fqdnForRecordName } from './dns-record.js';
import { addressInRange, isValidAddress } from '../utils/ip.js';
import { isLeaseActive } from '../utils/lease-sql.js';

function text(value) {
  return String(value ?? '').toLowerCase();
}

export function allScopes(db) {
  const scopes = db
    .prepare(
      `
      SELECT s.*, sub.cidr AS subnet_cidr, sub.name AS subnet_name,
             sub.domain_name AS subnet_domain_name, sub.folder_id
        FROM dhcp_scopes s
        JOIN subnets sub ON sub.id = s.subnet_id
       ORDER BY sub.network_address, s.id
    `,
    )
    .all();
  for (const scope of scopes) scope.pools = getScopePools(db, scope.id);
  return scopes;
}

export function scopesForAddress(scopes, subnetId, ip) {
  if (!isValidAddress(ip)) return [];
  return scopes.filter(
    (scope) =>
      scope.subnet_id === subnetId &&
      scope.pools.some((pool) => addressInRange(ip, pool.start_ip, pool.end_ip)),
  );
}

/**
 * Every DHCP Reservation, and every lease no reservation accounts for, as one
 * row each. A reservation whose client holds an active lease absorbs it.
 */
export function unifiedDhcpRows(db) {
  const subnets = new Map(
    db
      .prepare('SELECT id, cidr, name, domain_name, folder_id FROM subnets')
      .all()
      .map((subnet) => [subnet.id, subnet]),
  );
  const leases = db.prepare('SELECT * FROM dhcp_leases').all();
  const reservations = db.prepare('SELECT * FROM dhcp_reservations').all();
  const activeByIdentity = new Map(
    leases
      .filter((lease) => isLeaseActive(lease.expires_at))
      .map((lease) => [`${text(lease.mac_address)}:${lease.ip_address}`, lease]),
  );
  const subnetFields = (id) => {
    const subnet = subnets.get(id);
    return {
      subnet_cidr: subnet?.cidr ?? null,
      subnet_name: subnet?.name ?? null,
      subnet_domain_name: subnet?.domain_name ?? null,
      folder_id: subnet?.folder_id ?? null,
    };
  };
  const matched = new Set();
  const rows = reservations.map((reservation) => {
    const key = `${text(reservation.mac_address)}:${reservation.ip_address}`;
    const lease = activeByIdentity.get(key);
    if (lease) matched.add(key);
    return {
      ...reservation,
      protocol_id: `reservation:${reservation.id}`,
      reservation_id: reservation.id,
      lease_id: lease?.id ?? null,
      dhcp_assignment_type: 'reserved',
      lease_status: lease ? 'active' : 'offline',
      expires_at: lease?.expires_at ?? null,
      ...subnetFields(reservation.subnet_id),
    };
  });
  for (const lease of leases) {
    const key = `${text(lease.mac_address)}:${lease.ip_address}`;
    if (matched.has(key)) continue;
    rows.push({
      ...lease,
      protocol_id: `lease:${lease.id}`,
      reservation_id: null,
      lease_id: lease.id,
      dhcp_assignment_type: 'dynamic',
      lease_status: isLeaseActive(lease.expires_at) ? 'active' : 'offline',
      enabled: 1,
      ...subnetFields(lease.subnet_id),
    });
  }
  return rows;
}

// A reservation says more about an address than a lease does, and a live
// lease more than a spent one.
function dhcpRank(row) {
  if (row.dhcp_assignment_type === 'reserved') return 0;
  return row.lease_status === 'active' ? 1 : 2;
}

function dhcpFact(row, scopes) {
  return {
    dhcp_assignment_type: row.dhcp_assignment_type,
    lease_status: row.lease_status,
    enabled: row.enabled,
    duid: row.duid ?? null,
    iaid: row.iaid ?? null,
    subnet_name: row.subnet_name,
    related_scope_ids: scopesForAddress(scopes, row.subnet_id, row.ip_address).map(
      (scope) => scope.id,
    ),
  };
}

/** Attach `dhcp`, the reservation or lease behind each row's address. */
export function attachDhcpFacts(db, rows) {
  const targets = rows.filter((row) => row.ip_address && row.subnet_id != null);
  if (!targets.length) return rows;
  const best = new Map();
  for (const row of unifiedDhcpRows(db)) {
    const key = `${row.subnet_id}:${row.ip_address}`;
    const current = best.get(key);
    if (!current || dhcpRank(row) < dhcpRank(current)) best.set(key, row);
  }
  const scopes = best.size ? allScopes(db) : [];
  for (const row of targets) {
    const found = best.get(`${row.subnet_id}:${row.ip_address}`);
    row.dhcp = found ? dhcpFact(found, scopes) : null;
  }
  return rows;
}

function recordFact(record) {
  return {
    id: record.id,
    name: record.name,
    record_fqdn: fqdnForRecordName(record.name, record.zone_name),
    record_type: record.type,
    value: record.value,
    ttl: record.ttl,
    priority: record.priority,
    port: record.port,
    enabled: record.enabled,
    dns_source: record.source || 'manual',
    zone_name: record.zone_name,
    zone_soa_minimum_ttl: record.zone_soa_minimum_ttl,
  };
}

/**
 * Attach `dns_record`, the forward record behind each row's address, and
 * `dns_record_count`. The record the allocation names wins (the one that
 * claims or holds the address), then the lowest-id served record, then the
 * lowest-id record of any kind.
 */
export function attachDnsFacts(db, rows) {
  const targets = rows.filter((row) => row.ip_address);
  if (!targets.length) return rows;
  const byIp = new Map();
  for (const record of db
    .prepare(
      `
      SELECT r.id, r.name, r.type, r.value, r.ttl, r.priority, r.port, r.enabled, r.source,
             z.name AS zone_name, z.enabled AS zone_enabled,
             z.soa_minimum_ttl AS zone_soa_minimum_ttl
        FROM dns_records r
        JOIN dns_zones z ON z.id = r.zone_id
       WHERE r.type IN ('A', 'AAAA') AND z.type = 'forward'
       ORDER BY r.id
    `,
    )
    .all()) {
    const list = byIp.get(record.value) || [];
    list.push(record);
    byIp.set(record.value, list);
  }
  for (const row of targets) {
    const records = byIp.get(row.ip_address) || [];
    const owner =
      row.allocation_source_type === 'dns' &&
      records.find((record) => record.id === Number(row.allocation_source_id));
    const chosen =
      owner ||
      records.find((record) => record.enabled && record.zone_enabled) ||
      records[0] ||
      null;
    row.dns_record = chosen ? recordFact(chosen) : null;
    row.dns_record_count = records.length;
  }
  return rows;
}
