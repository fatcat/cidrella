// Data access for the GeoIP IP/CIDR allowlist (geoip_ip_allowlist).

import { canonicalizeIpOrCidr } from '../utils/cidr-match.js';

// Boot-time self-heal: rewrite stored values to canonical CIDR form and
// collapse rows that canonicalize to the same network (oldest row wins,
// inheriting a dropped duplicate's reason when it has none of its own).
// Runs every boot instead of a migration because IPv6 zero-compression
// can't be expressed in the .sql-only migration chain; the table is tiny
// and the pass is idempotent.
//
// Two-pass on purpose: group rows by canonical value FIRST, delete the
// losers, THEN rewrite the keepers. A single interleaved pass hit a
// UNIQUE(value) violation when a non-canonical spelling (lower id) was
// rewritten while a row already storing the canonical string still
// existed, and that crash-looped the whole server at boot.
export function canonicalizeExisting(db) {
  const rows = db.prepare('SELECT id, value, reason FROM geoip_ip_allowlist ORDER BY id').all();
  const rewrite = db.prepare('UPDATE geoip_ip_allowlist SET value = ?, reason = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM geoip_ip_allowlist WHERE id = ?');

  const byCanon = new Map(); // canonical value -> { keeper, dupes: [] }
  for (const row of rows) {
    const canon = canonicalizeIpOrCidr(row.value);
    if (!canon) continue; // unparseable legacy value: leave it visible for the operator
    const group = byCanon.get(canon);
    if (group) group.dupes.push(row);
    else byCanon.set(canon, { keeper: row, dupes: [] });
  }

  db.transaction(() => {
    for (const [canon, { keeper, dupes }] of byCanon) {
      // Deletes go first so the keeper's rewrite can never collide with a
      // later row that already holds the canonical string.
      let reason = keeper.reason;
      for (const dupe of dupes) {
        if (!reason && dupe.reason) reason = dupe.reason;
        remove.run(dupe.id);
        console.log(`[geoip-allowlist] Collapsed duplicate ${dupe.value} into ${canon}`);
      }
      if (canon !== keeper.value || reason !== keeper.reason) {
        rewrite.run(canon, reason, keeper.id);
      }
    }
  })();
}

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
