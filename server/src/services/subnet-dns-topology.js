import { generateReverseNames, reverseZoneNetwork } from '../utils/dnsmasq.js';
import { ipForPtrRecord, reconcileManagedReverseDns } from '../models/dns-record.js';
import { networkContains, networksOverlap } from '../utils/ip.js';

// Record sources the app writes on its own. A deallocated network takes these
// with it; anything a person typed stays. 'dns' PTRs mirror manual A records,
// so they stay too.
const GENERATED_PTR_SOURCES = ['placeholder', 'dhcp', 'reservation'];
const GENERATED_ADDRESS_SOURCES = ['dhcp', 'reservation'];

export function ensureForwardZone(db, domainName) {
  if (!domainName) return null;
  const existing = db
    .prepare("SELECT id FROM dns_zones WHERE name = ? AND type = 'forward'")
    .get(domainName);
  if (existing) return existing.id;

  return db
    .prepare("INSERT INTO dns_zones (name, type, description, enabled) VALUES (?, 'forward', ?, 1)")
    .run(domainName, `Forward zone for ${domainName}`).lastInsertRowid;
}

export function createReverseZonesForSubnet(db, subnet) {
  const reverseNames = generateReverseNames(subnet.cidr);

  for (const reverseName of reverseNames) {
    const existingZone = db
      .prepare('SELECT id, enabled FROM dns_zones WHERE name = ?')
      .get(reverseName);
    if (!existingZone) {
      db.prepare(
        `
        INSERT INTO dns_zones (name, type, description) VALUES (?, 'reverse', ?)
      `,
      ).run(reverseName, `Reverse zone for ${subnet.cidr}`);
    } else if (!existingZone.enabled) {
      // Deallocating the block disabled the zone; allocating it again brings
      // the zone back before the reconcile below refills its PTRs.
      db.prepare("UPDATE dns_zones SET enabled = 1, updated_at = datetime('now') WHERE id = ?").run(
        existingZone.id,
      );
    }
  }

  return reconcileManagedReverseDns(db, { subnetIds: [subnet.id] });
}

/**
 * What deallocating a network would take out of DNS, computed read-only so the
 * confirmation dialog and the cleanup itself work from the same selection.
 *
 * - generatedPtrIds: PTRs the app wrote (placeholder, lease, reservation) in the
 *   block's reverse zones, for addresses inside the block.
 * - generatedAddressRecords: A/AAAA records written from leases and
 *   reservations whose address is inside the block. Manual records stay.
 * - reverseZones: every existing reverse zone the block maps to, with
 *   willDisable false when another allocated network with reverse DNS still
 *   overlaps the zone. `excludeSubnetIds` names networks going away in the
 *   same operation (the subtree of a delete), so a zone two of them share is
 *   not kept alive by each other.
 */
export function dnsDeallocationImpact(db, subnet, { excludeSubnetIds = [] } = {}) {
  const zones = generateReverseNames(subnet.cidr)
    .map((name) => db.prepare('SELECT id, name, enabled FROM dns_zones WHERE name = ?').get(name))
    .filter(Boolean);

  const generatedPtrIds = [];
  if (zones.length) {
    const rows = db
      .prepare(
        `SELECT r.id, r.name, z.name AS zone_name FROM dns_records r
         JOIN dns_zones z ON z.id = r.zone_id
         WHERE r.type = 'PTR' AND r.zone_id IN (${zones.map(() => '?').join(',')})
           AND r.source IN (${GENERATED_PTR_SOURCES.map(() => '?').join(',')})`,
      )
      .all(...zones.map((z) => z.id), ...GENERATED_PTR_SOURCES);
    for (const row of rows) {
      const ip = ipForPtrRecord(row.name, row.zone_name);
      if (ip && networkContains(subnet.cidr, ip)) generatedPtrIds.push(row.id);
    }
  }

  const generatedAddressRecords = db
    .prepare(
      `SELECT id, value, zone_id FROM dns_records
       WHERE type IN ('A', 'AAAA')
         AND source IN (${GENERATED_ADDRESS_SOURCES.map(() => '?').join(',')})`,
    )
    .all(...GENERATED_ADDRESS_SOURCES)
    .filter((row) => networkContains(subnet.cidr, row.value))
    .map(({ id, zone_id }) => ({ id, zoneId: zone_id }));

  const excluded = [subnet.id, ...excludeSubnetIds];
  const otherReverseNetworks = db
    .prepare(
      `SELECT cidr FROM subnets WHERE status = 'allocated' AND has_reverse_dns = 1
         AND id NOT IN (${excluded.map(() => '?').join(',')})`,
    )
    .all(...excluded)
    .map((row) => row.cidr);
  const reverseZones = zones.map((zone) => {
    const covered = reverseZoneNetwork(zone.name);
    const stillUsed =
      covered !== null && otherReverseNetworks.some((cidr) => networksOverlap(cidr, covered));
    return {
      id: zone.id,
      name: zone.name,
      enabled: Boolean(zone.enabled),
      willDisable: !stillUsed,
    };
  });

  return { generatedPtrIds, generatedAddressRecords, reverseZones };
}

/**
 * Remove the DNS a network wrote for itself while it was allocated. Runs inside
 * the caller's transaction. Forward zones and manual records are not touched.
 */
export function cleanupDnsForDeallocatedSubnet(db, subnet, options = {}) {
  const impact = dnsDeallocationImpact(db, subnet, options);
  const deleteRecord = db.prepare('DELETE FROM dns_records WHERE id = ?');
  const touchZone = db.prepare(
    "UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?",
  );
  const disableZone = db.prepare(
    "UPDATE dns_zones SET enabled = 0, updated_at = datetime('now') WHERE id = ?",
  );

  for (const id of impact.generatedPtrIds) deleteRecord.run(id);
  const forwardZoneIds = new Set();
  for (const record of impact.generatedAddressRecords) {
    deleteRecord.run(record.id);
    forwardZoneIds.add(record.zoneId);
  }
  for (const zoneId of forwardZoneIds) touchZone.run(zoneId);
  const disabled = [];
  for (const zone of impact.reverseZones) {
    touchZone.run(zone.id);
    if (zone.willDisable) {
      disableZone.run(zone.id);
      disabled.push(zone.name);
    }
  }
  return {
    ptr_removed: impact.generatedPtrIds.length,
    address_records_removed: impact.generatedAddressRecords.length,
    zones_disabled: disabled,
  };
}

export function ensureForwardZoneForDomainChange(db, domainChange) {
  if (domainChange?.autoCreate) {
    return ensureForwardZone(db, domainChange.newName);
  }
  return null;
}

export function deleteARecordsByIps(db, ips) {
  let removed = 0;
  const delRec = db.prepare("DELETE FROM dns_records WHERE type IN ('A', 'AAAA') AND value = ?");
  for (const ip of ips) {
    removed += delRec.run(ip).changes;
  }
  return removed;
}

export function deleteARecordByIdentity(db, id, ip) {
  return db
    .prepare("DELETE FROM dns_records WHERE id = ? AND type IN ('A', 'AAAA') AND value = ?")
    .run(id, ip);
}
