// Data access for rogue DHCP detection, the authorized-server allowlist and
// the detected rogue events. All functions take an explicit `db` handle, matching
// the other model modules (e.g. models/geoip-rule.js).

// ─── Detected rogue events ───────────────────────────────

// Insert or refresh a detected rogue. Dedup key is (server_ip, server_mac);
// server_mac defaults to '' when unknown so the UNIQUE key never sees NULL.
// On re-detection we bump last_seen_at/times_seen and refresh the offered_*
// fields, but deliberately leave `acknowledged` untouched, a persistent rogue
// stays silenced once acknowledged; clearing the event re-arms it.
export function upsertRogueEvent(db, ev) {
  return db.prepare(`
    INSERT INTO rogue_dhcp_events
      (server_ip, server_mac, server_identifier, offered_ip, offered_gateway,
       offered_dns, offered_subnet_mask, relay_ip, iface)
    VALUES (@server_ip, @server_mac, @server_identifier, @offered_ip, @offered_gateway,
            @offered_dns, @offered_subnet_mask, @relay_ip, @iface)
    ON CONFLICT(server_ip, server_mac) DO UPDATE SET
      last_seen_at        = datetime('now'),
      times_seen          = times_seen + 1,
      server_identifier   = excluded.server_identifier,
      offered_ip          = excluded.offered_ip,
      offered_gateway     = excluded.offered_gateway,
      offered_dns         = excluded.offered_dns,
      offered_subnet_mask = excluded.offered_subnet_mask,
      relay_ip            = excluded.relay_ip,
      iface               = excluded.iface
  `).run({
    server_ip: ev.server_ip,
    server_mac: ev.server_mac || '',
    server_identifier: ev.server_identifier ?? null,
    offered_ip: ev.offered_ip ?? null,
    offered_gateway: ev.offered_gateway ?? null,
    offered_dns: ev.offered_dns ?? null,
    offered_subnet_mask: ev.offered_subnet_mask ?? null,
    relay_ip: ev.relay_ip ?? null,
    iface: ev.iface ?? null,
  });
}

export function listEvents(db) {
  return db.prepare('SELECT * FROM rogue_dhcp_events ORDER BY last_seen_at DESC').all();
}

export function acknowledgeEvent(db, id) {
  return db.prepare(
    "UPDATE rogue_dhcp_events SET acknowledged = 1, acknowledged_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function acknowledgeAll(db) {
  return db.prepare(
    "UPDATE rogue_dhcp_events SET acknowledged = 1, acknowledged_at = datetime('now') WHERE acknowledged = 0"
  ).run();
}

export function clearEvent(db, id) {
  return db.prepare('DELETE FROM rogue_dhcp_events WHERE id = ?').run(id);
}

export function countUnacknowledged(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM rogue_dhcp_events WHERE acknowledged = 0').get().c;
}

// ─── Authorized-server allowlist ─────────────────────────

export function listAuthorized(db) {
  return db.prepare('SELECT * FROM dhcp_authorized_servers ORDER BY server_ip').all();
}

export function addAuthorized(db, { server_ip, server_mac, description }) {
  return db.prepare(
    'INSERT OR IGNORE INTO dhcp_authorized_servers (server_ip, server_mac, description) VALUES (?, ?, ?)'
  ).run(server_ip, server_mac || null, description || null);
}

export function deleteAuthorized(db, id) {
  return db.prepare('DELETE FROM dhcp_authorized_servers WHERE id = ?').run(id);
}

// Lowercased set of authorized server IPs (allowlist only, CIDRella's own LAN
// IPs are added separately by the probe via getSelfIps()).
export function authorizedIpSet(db) {
  const rows = db.prepare('SELECT server_ip FROM dhcp_authorized_servers').all();
  return new Set(rows.map(r => r.server_ip.trim().toLowerCase()));
}
