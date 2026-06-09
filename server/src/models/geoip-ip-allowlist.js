// Data access for the GeoIP IP/CIDR allowlist (geoip_ip_allowlist).

export function listEntries(db) {
  return db.prepare('SELECT * FROM geoip_ip_allowlist ORDER BY value').all();
}

export function getByValue(db, value) {
  return db.prepare('SELECT * FROM geoip_ip_allowlist WHERE value = ?').get(value) || null;
}

export function addEntry(db, value, reason) {
  const info = db.prepare(
    'INSERT INTO geoip_ip_allowlist (value, reason) VALUES (?, ?)'
  ).run(value, reason || null);
  return info.lastInsertRowid;
}

export function deleteEntry(db, id) {
  return db.prepare('DELETE FROM geoip_ip_allowlist WHERE id = ?').run(id);
}
