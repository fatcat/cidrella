import { addressToBig, bigToAddress } from '../utils/ip.js';
import { RANGE_ASSIGNED, RANGE_UNASSIGNED, insertRangeEvent } from './ip-events.js';

// Network Range Type history. A write snapshots the network's custom type
// coverage before and after and records only the difference, per type: a
// widened range records the addresses it gained, a retyped one the old type
// leaving and the new arriving, a description edit nothing. Functional system
// ranges (DHCP Scope, Gateway and the rest) are a separate layer, not history.
function customCoverage(db, subnetId) {
  return db
    .prepare(
      `
    SELECT r.id, r.start_ip, r.end_ip, rt.name AS type
    FROM ranges r JOIN range_types rt ON rt.id = r.range_type_id
    WHERE r.subnet_id = ? AND rt.is_system = 0
  `,
    )
    .all(subnetId)
    .map((row) => {
      const start = addressToBig(row.start_ip);
      return {
        id: row.id,
        type: row.type,
        family: start.family,
        start: start.value,
        end: addressToBig(row.end_ip).value,
      };
    });
}

// The parts of `interval` no interval in `others` covers.
function uncovered(interval, others) {
  let fragments = [{ start: interval.start, end: interval.end }];
  for (const other of others) {
    if (other.type !== interval.type || other.family !== interval.family) continue;
    const next = [];
    for (const fragment of fragments) {
      if (other.end < fragment.start || other.start > fragment.end) {
        next.push(fragment);
        continue;
      }
      if (fragment.start < other.start) next.push({ start: fragment.start, end: other.start - 1n });
      if (fragment.end > other.end) next.push({ start: other.end + 1n, end: fragment.end });
    }
    fragments = next;
  }
  return fragments.map((fragment) => ({ ...interval, ...fragment }));
}

function recordCoverageChange(db, subnetId, before, after) {
  const record = (interval, type) =>
    insertRangeEvent(db, {
      subnetId,
      rangeId: interval.id,
      rangeType: interval.type,
      startIp: bigToAddress(interval.start, interval.family),
      endIp: bigToAddress(interval.end, interval.family),
      type,
    });
  for (const interval of before) {
    for (const lost of uncovered(interval, after)) record(lost, RANGE_UNASSIGNED);
  }
  for (const interval of after) {
    for (const gained of uncovered(interval, before)) record(gained, RANGE_ASSIGNED);
  }
}

function withRangeHistory(db, subnetId, write) {
  const before = customCoverage(db, subnetId);
  const result = write();
  recordCoverageChange(db, subnetId, before, customCoverage(db, subnetId));
  return result;
}

/**
 * Record every Network Range Type in a network and the networks under it as
 * taken off its addresses. Called before the subtree's ranges are deleted
 * (deallocate, delete), since the rows go without passing through here.
 */
export function recordSubtreeRangesRemoved(db, subnetId) {
  const subnets = db
    .prepare(
      `
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM subnets WHERE id = ?
      UNION ALL SELECT s.id FROM subnets s JOIN tree ON s.parent_id = tree.id
    )
    SELECT id FROM tree
  `,
    )
    .all(subnetId);
  for (const { id } of subnets) recordCoverageChange(db, id, customCoverage(db, id), []);
}

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
      rt.is_system as range_type_is_system, ds.id as dhcp_scope_id,
      ds.address_family as dhcp_address_family, ds.v6_mode as dhcp_v6_mode
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
  const result = withRangeHistory(db, subnetId, () =>
    db
      .prepare(
        'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)',
      )
      .run(subnetId, rangeTypeId, startIp, endIp, description || null),
  );
  return findWithType(db, result.lastInsertRowid);
}

export function updateRange(db, range, fields) {
  withRangeHistory(db, range.subnet_id, () => updateRangeRow(db, range, fields));
  return findWithType(db, range.id);
}

function updateRangeRow(db, range, fields) {
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
}

export function deleteRange(db, rangeId) {
  const range = db.prepare('SELECT subnet_id FROM ranges WHERE id = ?').get(rangeId);
  if (!range) return { changes: 0 };
  return withRangeHistory(db, range.subnet_id, () =>
    db.prepare('DELETE FROM ranges WHERE id = ?').run(rangeId),
  );
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
 * intentionally left alone. A null `rangeTypeId` only removes the selection
 * from the labels around it.
 */
export function assignCustomRangeType(
  db,
  { subnetId, rangeTypeId, selections, description = null, excludeRangeId = null },
) {
  const apply = db.transaction(() =>
    withRangeHistory(db, subnetId, () => {
      const overlaps = listCustomRangeOverlaps(db, subnetId, selections, { excludeRangeId });

      if (excludeRangeId !== null) {
        db.prepare('DELETE FROM ranges WHERE id = ? AND subnet_id = ?').run(
          excludeRangeId,
          subnetId,
        );
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
      for (const selection of rangeTypeId === null ? [] : selections) {
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
    }),
  );

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
