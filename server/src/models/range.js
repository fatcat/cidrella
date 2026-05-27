export function findWithType(db, rangeId) {
  return db.prepare(`
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color
    FROM ranges r JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.id = ?
  `).get(rangeId);
}

export function listSubnetDetailRanges(db, subnetId) {
  return db.prepare(`
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color,
      rt.is_system as range_type_is_system, ds.id as dhcp_scope_id
    FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    LEFT JOIN dhcp_scopes ds ON ds.range_id = r.id
    WHERE r.subnet_id = ?
      AND (rt.name != 'DHCP Scope' OR ds.id IS NOT NULL)
    ORDER BY r.start_ip
  `).all(subnetId);
}

export function createRange(db, { subnetId, rangeTypeId, startIp, endIp, description }) {
  const result = db.prepare(
    'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)'
  ).run(subnetId, rangeTypeId, startIp, endIp, description || null);
  return findWithType(db, result.lastInsertRowid);
}

export function updateRange(db, range, fields) {
  db.prepare(`
    UPDATE ranges SET range_type_id = ?, start_ip = ?, end_ip = ?, description = ?, updated_at = datetime('now') WHERE id = ?
  `).run(
    fields.rangeTypeId ?? range.range_type_id,
    fields.startIp,
    fields.endIp,
    fields.description !== undefined ? fields.description : range.description,
    range.id
  );
  return findWithType(db, range.id);
}

export function deleteRange(db, rangeId) {
  return db.prepare('DELETE FROM ranges WHERE id = ?').run(rangeId);
}

export function repairStaleGatewayRanges(db) {
  return db.prepare(`
    UPDATE ranges
       SET start_ip = (SELECT gateway_address FROM subnets WHERE id = ranges.subnet_id),
           end_ip   = (SELECT gateway_address FROM subnets WHERE id = ranges.subnet_id),
           updated_at = datetime('now')
     WHERE range_type_id = (SELECT id FROM range_types WHERE name='Gateway' AND is_system=1)
       AND EXISTS (
         SELECT 1 FROM subnets WHERE id = ranges.subnet_id
                                AND gateway_address IS NOT NULL
                                AND gateway_address != ranges.start_ip
       )
  `).run();
}
