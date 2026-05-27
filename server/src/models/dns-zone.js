export function createZone(db, fields, soaDefaults) {
  const result = db.prepare(`
    INSERT INTO dns_zones (name, type, description,
      soa_primary_ns, soa_admin_email, soa_refresh, soa_retry, soa_expire, soa_minimum_ttl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.name,
    fields.type,
    fields.description || null,
    fields.soa_primary_ns || soaDefaults.soa_primary_ns,
    fields.soa_admin_email || soaDefaults.soa_admin_email,
    fields.soa_refresh ?? soaDefaults.soa_refresh,
    fields.soa_retry ?? soaDefaults.soa_retry,
    fields.soa_expire ?? soaDefaults.soa_expire,
    fields.soa_minimum_ttl ?? soaDefaults.soa_minimum_ttl
  );

  return db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(result.lastInsertRowid);
}

export function updateZone(db, zone, fields) {
  const update = db.transaction(() => {
    const renaming = fields.name && fields.name !== zone.name;
    const newSerial = (zone.soa_serial || 0) + 1;

    db.prepare(`
      UPDATE dns_zones SET name = ?, description = ?, enabled = ?,
        soa_primary_ns = ?, soa_admin_email = ?, soa_serial = ?,
        soa_refresh = ?, soa_retry = ?, soa_expire = ?, soa_minimum_ttl = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      fields.name ?? zone.name,
      fields.description !== undefined ? fields.description : zone.description,
      fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : zone.enabled,
      fields.soa_primary_ns !== undefined ? fields.soa_primary_ns : zone.soa_primary_ns,
      fields.soa_admin_email !== undefined ? fields.soa_admin_email : zone.soa_admin_email,
      newSerial,
      fields.soa_refresh !== undefined ? fields.soa_refresh : zone.soa_refresh,
      fields.soa_retry !== undefined ? fields.soa_retry : zone.soa_retry,
      fields.soa_expire !== undefined ? fields.soa_expire : zone.soa_expire,
      fields.soa_minimum_ttl !== undefined ? fields.soa_minimum_ttl : zone.soa_minimum_ttl,
      zone.id
    );

    if (renaming && zone.type === 'forward') {
      db.prepare(
        "UPDATE subnets SET domain_name = ?, updated_at = datetime('now') WHERE domain_name = ?"
      ).run(fields.name, zone.name);
    }

    return db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(zone.id);
  });

  return update();
}

export function deleteZone(db, zone) {
  const del = db.transaction(() => {
    if (zone.type === 'forward') {
      db.prepare(
        "UPDATE subnets SET domain_name = NULL, updated_at = datetime('now') WHERE domain_name = ?"
      ).run(zone.name);
    }
    db.prepare('DELETE FROM dns_zones WHERE id = ?').run(zone.id);
  });

  del();
}
