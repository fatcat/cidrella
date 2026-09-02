import { canonicalizeIp, parseIp, sortKey } from '../utils/address.js';

/**
 * Populate canonical identity fields after schema migrations. SQLite has no
 * built-in IPv6 parser, so this backfill belongs at the database boundary.
 *
 * A spelling collision is left for lifecycle reconciliation. Both rows still
 * receive the same family and sort key so the conflict is detectable without
 * relying on text equality.
 */
export function backfillCanonicalIpIdentity(db) {
  const rows = db.prepare(`
    SELECT id, subnet_id, ip_address
    FROM ip_addresses
    WHERE address_family IS NULL OR address_sort_key IS NULL
  `).all();
  const findCanonical = db.prepare(`
    SELECT id FROM ip_addresses
    WHERE subnet_id = ? AND ip_address = ? AND id != ?
    LIMIT 1
  `);
  const updateAll = db.prepare(`
    UPDATE ip_addresses
    SET ip_address = ?, address_family = ?, address_sort_key = ?
    WHERE id = ?
  `);
  const updateIdentity = db.prepare(`
    UPDATE ip_addresses SET address_family = ?, address_sort_key = ? WHERE id = ?
  `);

  const apply = db.transaction(() => {
    let updated = 0;
    let conflicts = 0;
    for (const row of rows) {
      const parsed = parseIp(row.ip_address);
      if (!parsed) continue;
      const canonical = canonicalizeIp(row.ip_address);
      const family = parsed.bits === 32 ? 4 : 6;
      const key = sortKey(row.ip_address);
      if (canonical !== row.ip_address && findCanonical.get(row.subnet_id, canonical, row.id)) {
        updateIdentity.run(family, key, row.id);
        conflicts++;
      } else {
        updateAll.run(canonical, family, key, row.id);
        updated++;
      }
    }
    return { updated, conflicts };
  });

  return apply();
}

