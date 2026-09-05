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

/**
 * Persist the one-time lifecycle reconciliation after the schema-54 upgrade
 * inventory has proved there are no ambiguous claims. Keeping these raw
 * writes beside the canonical identity backfill preserves the model ownership
 * rule while avoiding an init.js <-> ip-address.js import cycle.
 */
export function writeMigratedIpLifecycleRows(db, rows) {
  const find = db.prepare(`
    SELECT id FROM ip_addresses
    WHERE subnet_id = ? AND ip_address = ? AND COALESCE(interface_id, '') = ''
  `);
  const insert = db.prepare(`
    INSERT INTO ip_addresses (
      subnet_id, ip_address, allocation_state, allocation_source_type,
      allocation_source_id, address_family, address_sort_key, dhcp_version,
      is_rogue, rogue_reason, reservation_note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
  `);
  const update = db.prepare(`
    UPDATE ip_addresses
    SET allocation_state = ?, allocation_source_type = ?,
        allocation_source_id = ?, address_family = ?, address_sort_key = ?,
        dhcp_version = ?,
        is_rogue = CASE WHEN ? = 'unassigned' THEN is_rogue ELSE 0 END,
        rogue_reason = CASE WHEN ? = 'unassigned' THEN rogue_reason ELSE NULL END,
        detection_source = CASE
          WHEN ? = 'unassigned' AND detection_source IN ('dns', 'dhcp_lease', 'dhcp_reservation')
            THEN NULL
          ELSE detection_source
        END,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  return db.transaction(() => {
    let inserted = 0;
    let updated = 0;
    const stateCounts = {};
    for (const row of rows) {
      const parsed = parseIp(row.ip);
      const family = parsed.bits === 32 ? 4 : 6;
      const key = sortKey(row.ip);
      const existing = find.get(row.subnetId, row.ip);
      if (existing) {
        update.run(
          row.state, row.sourceType, row.sourceId,
          family, key, row.dhcpVersion,
          row.state, row.state, row.state, existing.id
        );
        updated++;
      } else {
        insert.run(
          row.subnetId, row.ip, row.state, row.sourceType,
          row.sourceId, family, key, row.dhcpVersion, row.note
        );
        inserted++;
      }
      stateCounts[row.state] = (stateCounts[row.state] || 0) + 1;
    }
    return { inserted, updated, state_counts: stateCounts };
  })();
}
