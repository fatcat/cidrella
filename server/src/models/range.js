import { addressToBig, bigToAddress } from '../utils/ip.js';

export function findWithType(db, rangeId) {
  return db
    .prepare(
      `
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color
    FROM ranges r JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.id = ?
  `,
    )
    .get(rangeId);
}

export function listSubnetDetailRanges(db, subnetId) {
  return db
    .prepare(
      `
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color,
      rt.is_system as range_type_is_system, ds.id as dhcp_scope_id
    FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    LEFT JOIN dhcp_scopes ds ON ds.range_id = r.id
    WHERE r.subnet_id = ?
      AND (rt.name != 'DHCP Scope' OR ds.id IS NOT NULL)
    ORDER BY r.start_ip
  `,
    )
    .all(subnetId);
}

export function createRange(db, { subnetId, rangeTypeId, startIp, endIp, description }) {
  const result = db
    .prepare(
      'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)',
    )
    .run(subnetId, rangeTypeId, startIp, endIp, description || null);
  return findWithType(db, result.lastInsertRowid);
}

export function updateRange(db, range, fields) {
  db.prepare(
    `
    UPDATE ranges SET range_type_id = ?, start_ip = ?, end_ip = ?, description = ?, updated_at = datetime('now') WHERE id = ?
  `,
  ).run(
    fields.rangeTypeId ?? range.range_type_id,
    fields.startIp,
    fields.endIp,
    fields.description !== undefined ? fields.description : range.description,
    range.id,
  );
  return findWithType(db, range.id);
}

export function deleteRange(db, rangeId) {
  return db.prepare('DELETE FROM ranges WHERE id = ?').run(rangeId);
}

export function listCustomRangeOverlaps(db, subnetId, selections, { excludeRangeId = null } = {}) {
  const rows = db
    .prepare(
      `
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color
    FROM ranges r
    JOIN range_types rt ON rt.id = r.range_type_id
    WHERE r.subnet_id = ?
      AND rt.is_system = 0
      AND (? IS NULL OR r.id != ?)
    ORDER BY r.start_ip
  `,
    )
    .all(subnetId, excludeRangeId, excludeRangeId);

  // Selections and rows are BigInt intervals. A row of another family can
  // never overlap; its numeric value is simply unrelated.
  return rows.filter((row) => {
    const start = addressToBig(row.start_ip);
    const end = addressToBig(row.end_ip).value;
    return selections.some(
      (selection) =>
        selection.family === start.family && selection.start <= end && start.value <= selection.end,
    );
  });
}

/**
 * Apply one custom Network Range Type to one or more selected intervals.
 * Existing custom classifications are split around the selection so custom
 * ranges never overlap. Functional system ranges are a separate layer and are
 * intentionally left alone.
 */
export function assignCustomRangeType(
  db,
  { subnetId, rangeTypeId, selections, description = null, excludeRangeId = null },
) {
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
      const family = addressToBig(range.start_ip).family;
      let fragments = [
        { start: addressToBig(range.start_ip).value, end: addressToBig(range.end_ip).value },
      ];

      for (const selection of selections) {
        const next = [];
        for (const fragment of fragments) {
          if (selection.end < fragment.start || selection.start > fragment.end) {
            next.push(fragment);
            continue;
          }
          if (fragment.start < selection.start) {
            next.push({ start: fragment.start, end: selection.start - 1n });
          }
          if (fragment.end > selection.end) {
            next.push({ start: selection.end + 1n, end: fragment.end });
          }
        }
        fragments = next;
      }

      for (const fragment of fragments) {
        insert.run(
          subnetId,
          range.range_type_id,
          bigToAddress(fragment.start, family),
          bigToAddress(fragment.end, family),
          range.description,
        );
      }
    }

    const createdIds = [];
    for (const selection of selections) {
      const result = insert.run(
        subnetId,
        rangeTypeId,
        bigToAddress(selection.start, selection.family),
        bigToAddress(selection.end, selection.family),
        description || null,
      );
      createdIds.push(Number(result.lastInsertRowid));
    }

    return {
      created: createdIds.map((id) => findWithType(db, id)),
      replaced: overlaps.map((range) => ({
        id: range.id,
        type: range.range_type_name,
        start_ip: range.start_ip,
        end_ip: range.end_ip,
      })),
    };
  });

  return apply();
}

export function repairStaleGatewayRanges(db) {
  return db
    .prepare(
      `
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
  `,
    )
    .run();
}
