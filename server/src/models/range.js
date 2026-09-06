import { ipToLong, longToIp } from '../utils/ip.js';

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

export function listCustomRangeOverlaps(db, subnetId, selections, { excludeRangeId = null } = {}) {
  const rows = db.prepare(`
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color
    FROM ranges r
    JOIN range_types rt ON rt.id = r.range_type_id
    WHERE r.subnet_id = ?
      AND rt.is_system = 0
      AND (? IS NULL OR r.id != ?)
    ORDER BY r.start_ip
  `).all(subnetId, excludeRangeId, excludeRangeId);

  return rows.filter(row => {
    const start = ipToLong(row.start_ip);
    const end = ipToLong(row.end_ip);
    return selections.some(selection => selection.start <= end && start <= selection.end);
  });
}

/**
 * Apply one custom Network Range Type to one or more selected intervals.
 * Existing custom classifications are split around the selection so custom
 * ranges never overlap. Functional system ranges are a separate layer and are
 * intentionally left alone.
 */
export function assignCustomRangeType(db, {
  subnetId,
  rangeTypeId,
  selections,
  description = null,
  excludeRangeId = null
}) {
  const apply = db.transaction(() => {
    const overlaps = listCustomRangeOverlaps(db, subnetId, selections, { excludeRangeId });

    if (excludeRangeId !== null) {
      db.prepare('DELETE FROM ranges WHERE id = ? AND subnet_id = ?').run(excludeRangeId, subnetId);
    }

    const insert = db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const range of overlaps) {
      db.prepare('DELETE FROM ranges WHERE id = ?').run(range.id);
      let fragments = [{ start: ipToLong(range.start_ip), end: ipToLong(range.end_ip) }];

      for (const selection of selections) {
        const next = [];
        for (const fragment of fragments) {
          if (selection.end < fragment.start || selection.start > fragment.end) {
            next.push(fragment);
            continue;
          }
          if (fragment.start < selection.start) {
            next.push({ start: fragment.start, end: selection.start - 1 });
          }
          if (fragment.end > selection.end) {
            next.push({ start: selection.end + 1, end: fragment.end });
          }
        }
        fragments = next;
      }

      for (const fragment of fragments) {
        insert.run(
          subnetId,
          range.range_type_id,
          longToIp(fragment.start),
          longToIp(fragment.end),
          range.description
        );
      }
    }

    const createdIds = [];
    for (const selection of selections) {
      const result = insert.run(
        subnetId,
        rangeTypeId,
        longToIp(selection.start),
        longToIp(selection.end),
        description || null
      );
      createdIds.push(Number(result.lastInsertRowid));
    }

    return {
      created: createdIds.map(id => findWithType(db, id)),
      replaced: overlaps.map(range => ({
        id: range.id,
        type: range.range_type_name,
        start_ip: range.start_ip,
        end_ip: range.end_ip
      }))
    };
  });

  return apply();
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
