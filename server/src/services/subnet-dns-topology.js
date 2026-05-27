import { generateReverseNames } from '../utils/dnsmasq.js';

export function ensureForwardZone(db, domainName) {
  if (!domainName) return null;
  const existing = db.prepare(
    "SELECT id FROM dns_zones WHERE name = ? AND type = 'forward'"
  ).get(domainName);
  if (existing) return existing.id;

  return db.prepare(
    "INSERT INTO dns_zones (name, type, description, enabled) VALUES (?, 'forward', ?, 1)"
  ).run(domainName, `Forward zone for ${domainName}`).lastInsertRowid;
}

export function createReverseZonesForSubnet(db, subnet, parsed) {
  const reverseNames = generateReverseNames(subnet.cidr);
  const startIp = parsed.prefix >= 31 ? parsed.networkLong : parsed.networkLong + 1;
  const endIp = parsed.prefix >= 31 ? parsed.broadcastLong : parsed.broadcastLong - 1;

  const insertRecord = db.prepare(
    'INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, ?, ?, ?, 1)'
  );

  for (const reverseName of reverseNames) {
    const existingZone = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(reverseName);
    let zoneId;
    if (!existingZone) {
      const zoneResult = db.prepare(`
        INSERT INTO dns_zones (name, type, description) VALUES (?, 'reverse', ?)
      `).run(reverseName, `Reverse zone for ${subnet.cidr}`);
      zoneId = zoneResult.lastInsertRowid;
    } else {
      zoneId = existingZone.id;
    }

    const zoneParts = reverseName.replace('.in-addr.arpa', '').split('.').map(Number);
    const zoneThirdOctet = zoneParts.length === 3 ? zoneParts[0] : null;

    const existingPtrs = db.prepare('SELECT name FROM dns_records WHERE zone_id = ? AND type = ?').all(zoneId, 'PTR');
    const existingNames = new Set(existingPtrs.map(r => r.name));

    for (let ipLong = startIp; ipLong <= endIp; ipLong++) {
      if (zoneThirdOctet !== null && ((ipLong >>> 8) & 255) !== zoneThirdOctet) continue;

      const ptrName = zoneParts.length === 3
        ? String(ipLong & 255)
        : zoneParts.length === 2
          ? `${ipLong & 255}.${(ipLong >>> 8) & 255}`
          : `${ipLong & 255}.${(ipLong >>> 8) & 255}.${(ipLong >>> 16) & 255}`;

      if (!existingNames.has(ptrName)) {
        insertRecord.run(zoneId, ptrName, 'PTR', '');
      }
    }

    db.prepare("UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?").run(zoneId);
  }
}

export function ensureForwardZoneForDomainChange(db, domainChange) {
  if (domainChange?.autoCreate) {
    return ensureForwardZone(db, domainChange.newName);
  }
  return null;
}

export function deleteARecordsByIps(db, ips) {
  let removed = 0;
  const delRec = db.prepare("DELETE FROM dns_records WHERE type = 'A' AND value = ?");
  for (const ip of ips) {
    removed += delRec.run(ip).changes;
  }
  return removed;
}
