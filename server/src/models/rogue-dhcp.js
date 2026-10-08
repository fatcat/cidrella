// Data access for rogue detection: the authorized-server allowlist and the
// detected rogue events. All functions take an explicit `db` handle, matching
// the other model modules (e.g. models/geoip-rule.js).
//
// Three probes write here. `kind` says which one found the event:
//   dhcp    a DHCPv4 server answered a DISCOVER (identified by IP)
//   dhcpv6  a DHCPv6 server answered a SOLICIT (identified by DUID and link-local)
//   ra      a router advertised itself on the link (identified by link-local and MAC)

export const ROGUE_KINDS = Object.freeze(['dhcp', 'dhcpv6', 'ra']);

// ─── Detected rogue events ───────────────────────────────

// Insert or refresh a detected rogue. Dedup key is (kind, server_ip,
// server_mac); server_mac defaults to '' when unknown so the UNIQUE key never
// sees NULL. On re-detection we bump last_seen_at/times_seen and refresh the
// observed fields, but deliberately leave `acknowledged` untouched, a
// persistent rogue stays silenced once acknowledged; clearing the event
// re-arms it.
export function upsertRogueEvent(db, ev) {
  const kind = ev.kind || 'dhcp';
  if (!ROGUE_KINDS.includes(kind)) throw new Error(`Unknown rogue event kind: ${kind}`);
  return db
    .prepare(
      `
    INSERT INTO rogue_dhcp_events
      (kind, address_family, server_ip, server_mac, server_duid, server_identifier,
       offered_ip, offered_gateway, offered_dns, offered_subnet_mask,
       advertised_prefixes, relay_ip, iface)
    VALUES (@kind, @address_family, @server_ip, @server_mac, @server_duid, @server_identifier,
            @offered_ip, @offered_gateway, @offered_dns, @offered_subnet_mask,
            @advertised_prefixes, @relay_ip, @iface)
    ON CONFLICT(kind, server_ip, server_mac) DO UPDATE SET
      last_seen_at        = datetime('now'),
      times_seen          = times_seen + 1,
      server_duid         = excluded.server_duid,
      server_identifier   = excluded.server_identifier,
      offered_ip          = excluded.offered_ip,
      offered_gateway     = excluded.offered_gateway,
      offered_dns         = excluded.offered_dns,
      offered_subnet_mask = excluded.offered_subnet_mask,
      advertised_prefixes = excluded.advertised_prefixes,
      relay_ip            = excluded.relay_ip,
      iface               = excluded.iface
  `,
    )
    .run({
      kind,
      address_family: ev.address_family ?? (kind === 'dhcp' ? 4 : 6),
      server_ip: ev.server_ip,
      server_mac: ev.server_mac || '',
      server_duid: ev.server_duid ?? null,
      server_identifier: ev.server_identifier ?? null,
      offered_ip: ev.offered_ip ?? null,
      offered_gateway: ev.offered_gateway ?? null,
      offered_dns: ev.offered_dns ?? null,
      offered_subnet_mask: ev.offered_subnet_mask ?? null,
      advertised_prefixes: ev.advertised_prefixes ?? null,
      relay_ip: ev.relay_ip ?? null,
      iface: ev.iface ?? null,
    });
}

export function listEvents(db) {
  return db.prepare('SELECT * FROM rogue_dhcp_events ORDER BY last_seen_at DESC').all();
}

export function acknowledgeEvent(db, id) {
  return db
    .prepare(
      "UPDATE rogue_dhcp_events SET acknowledged = 1, acknowledged_at = datetime('now') WHERE id = ?",
    )
    .run(id);
}

export function acknowledgeAll(db) {
  return db
    .prepare(
      "UPDATE rogue_dhcp_events SET acknowledged = 1, acknowledged_at = datetime('now') WHERE acknowledged = 0",
    )
    .run();
}

export function clearEvent(db, id) {
  return db.prepare('DELETE FROM rogue_dhcp_events WHERE id = ?').run(id);
}

export function countUnacknowledged(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM rogue_dhcp_events WHERE acknowledged = 0').get().c;
}

// ─── Authorized-server allowlist ─────────────────────────

export function listAuthorized(db) {
  return db
    .prepare('SELECT * FROM dhcp_authorized_servers ORDER BY server_ip, server_mac, server_duid')
    .all();
}

// An entry needs at least one identity. IP and DUID are unique on their own
// (partial indexes). A MAC-only entry has no index of its own because a MAC
// may legitimately repeat across entries that pair it with different IPs, so
// its duplicate check lives here.
export function addAuthorized(db, { server_ip, server_mac, server_duid, description }) {
  const ip = server_ip || null;
  const mac = server_mac || null;
  const duid = server_duid || null;
  if (!ip && !mac && !duid) throw new Error('An authorized server needs an IP, MAC or DUID');
  if (!ip && !duid) {
    const dup = db
      .prepare(
        'SELECT 1 FROM dhcp_authorized_servers WHERE server_mac = ? AND server_ip IS NULL AND server_duid IS NULL',
      )
      .get(mac);
    if (dup) return { changes: 0, lastInsertRowid: null };
  }
  return db
    .prepare(
      'INSERT OR IGNORE INTO dhcp_authorized_servers (server_ip, server_mac, server_duid, description) VALUES (?, ?, ?, ?)',
    )
    .run(ip, mac, duid, description || null);
}

export function deleteAuthorized(db, id) {
  return db.prepare('DELETE FROM dhcp_authorized_servers WHERE id = ?').run(id);
}

// Lowercased set of authorized server IPs (allowlist only, CIDRella's own LAN
// IPs are added separately by the probe via getSelfIps()).
export function authorizedIpSet(db) {
  return authorizedSets(db).ips;
}

/**
 * Every identity the allowlist trusts, one lowercased Set per identity type.
 * The DHCPv4 probe matches on `ips`, the DHCPv6 probe on `ips` and `duids`,
 * the Router Advertisement check on `ips` and `macs`.
 */
export function authorizedSets(db) {
  const rows = db
    .prepare('SELECT server_ip, server_mac, server_duid FROM dhcp_authorized_servers')
    .all();
  const ips = new Set();
  const macs = new Set();
  const duids = new Set();
  for (const row of rows) {
    if (row.server_ip) ips.add(row.server_ip.trim().toLowerCase());
    if (row.server_mac) macs.add(row.server_mac.trim().toLowerCase());
    if (row.server_duid) duids.add(row.server_duid.trim().toLowerCase());
  }
  return { ips, macs, duids };
}

/**
 * MACs of the routers the operator has configured as gateways, as learned by
 * scans. A Router Advertisement from one of these is the expected router
 * doing its job, not a rogue. Without this every deployment's first check
 * would flag its own default router.
 */
export function configuredGatewayMacSet(db) {
  const rows = db
    .prepare(
      "SELECT DISTINCT mac_address FROM ip_addresses WHERE allocation_state = 'gateway' AND mac_address IS NOT NULL AND mac_address != ''",
    )
    .all();
  return new Set(rows.map((r) => r.mac_address.trim().toLowerCase()));
}
