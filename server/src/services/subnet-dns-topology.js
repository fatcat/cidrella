import { generateReverseNames } from '../utils/dnsmasq.js';
import { reconcileManagedReverseDns } from '../models/dns-record.js';

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

export function createReverseZonesForSubnet(db, subnet) {
  const reverseNames = generateReverseNames(subnet.cidr);

  for (const reverseName of reverseNames) {
    const existingZone = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(reverseName);
    if (!existingZone) {
      db.prepare(`
        INSERT INTO dns_zones (name, type, description) VALUES (?, 'reverse', ?)
      `).run(reverseName, `Reverse zone for ${subnet.cidr}`);
    }
  }

  return reconcileManagedReverseDns(db, { subnetIds: [subnet.id] });
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
