function normalizeDnsName(name) {
  return String(name || '').trim().replace(/\.$/, '').toLowerCase();
}

function bumpZoneSerial(db, zoneId) {
  db.prepare("UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?")
    .run(zoneId);
}

export function fqdnForRecordName(recordName, zoneName) {
  const raw = String(recordName || '').trim().toLowerCase();
  const normalized = raw.replace(/\.$/, '');
  const zone = normalizeDnsName(zoneName);
  if (normalized === '@' || normalized === zone) return zoneName;
  if (normalized.endsWith(`.${zone}`)) return normalized;
  if (normalized.includes('.')) return raw.endsWith('.') ? raw : normalized;
  return `${normalized}.${zoneName}`;
}

/**
 * A manual A record in an enabled forward zone is the operator declaring "this
 * address is in use", and that declaration is what makes an address NOT rogue.
 *
 * Three places need to know it: the scanner's bulk assignment map, the IP-view
 * static-DNS set, and the passive DNS-query path. Each used to carry its own
 * copy of this predicate and the passive path was missing it entirely, so a host
 * with a name in DNS got flagged rogue the moment it resolved anything. One
 * definition now, so the three cannot drift apart again.
 *
 * DHCP-sourced A records are excluded deliberately: those track a lease rather
 * than an operator decision, and restored lease history can leave one behind
 * after the lease itself is gone.
 */
const DNS_ASSIGNED_SELECT = `
  SELECT r.value AS ip_address, r.name, z.name AS zone_name
    FROM dns_records r
    JOIN dns_zones z ON z.id = r.zone_id
   WHERE r.type = 'A'
     AND r.enabled = 1
     AND z.enabled = 1
     AND z.type = 'forward'
     AND COALESCE(r.source, 'manual') = 'manual'
`;

/** Every address a manual forward A record claims, with the FQDN it claims it as. */
export function listDnsAssignedIps(db) {
  return db.prepare(DNS_ASSIGNED_SELECT).all().map(r => ({
    ip_address: r.ip_address,
    hostname: fqdnForRecordName(r.name, r.zone_name),
  }));
}

/** The set of addresses DNS claims. Cheap: bounded by operator-created records. */
export function dnsAssignedIpSet(db) {
  return new Set(db.prepare(DNS_ASSIGNED_SELECT).all().map(r => r.ip_address));
}

/** The FQDN DNS assigns to `ip`, or null when no manual A record claims it. */
export function dnsAssignedHostname(db, ip) {
  if (!ip) return null;
  const row = db.prepare(`${DNS_ASSIGNED_SELECT} AND r.value = ? LIMIT 1`).get(ip);
  return row ? fqdnForRecordName(row.name, row.zone_name) : null;
}

export function findReversePtrLocation(db, ip, { enabledOnly = false } = {}) {
  const octets = String(ip || '').split('.');
  if (octets.length !== 4) return null;
  const candidates = [
    { name: `${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`, ptrName: octets[3] },
    { name: `${octets[1]}.${octets[0]}.in-addr.arpa`, ptrName: `${octets[3]}.${octets[2]}` },
    { name: `${octets[0]}.in-addr.arpa`, ptrName: `${octets[3]}.${octets[2]}.${octets[1]}` }
  ];

  const enabledSql = enabledOnly ? 'AND enabled = 1' : '';
  for (const candidate of candidates) {
    const zone = db.prepare(`
      SELECT id, name FROM dns_zones
      WHERE type = 'reverse' AND name = ? ${enabledSql}
    `).get(candidate.name);
    if (zone) return { zone, ptrName: candidate.ptrName };
  }
  return null;
}

export function syncPtrForARecord(db, recordName, ip, forwardZoneName, { force = false } = {}) {
  const match = findReversePtrLocation(db, ip, { enabledOnly: true });
  if (!match) return { updated: false };

  const { zone, ptrName } = match;
  const fqdn = fqdnForRecordName(recordName, forwardZoneName);
  const existing = db.prepare(
    "SELECT * FROM dns_records WHERE zone_id = ? AND type = 'PTR' AND name = ?"
  ).get(zone.id, ptrName);

  if (existing) {
    if (!force && existing.value && existing.value !== ip) {
      const bareIp = /^\d+\.\d+\.\d+\.\d+$/.test(existing.value);
      if (!bareIp && existing.value.toLowerCase() !== fqdn.toLowerCase()) {
        if (!existing.value.toLowerCase().endsWith('.' + forwardZoneName.toLowerCase()) &&
            existing.value.toLowerCase() !== forwardZoneName.toLowerCase()) {
          return { conflict: { existing: existing.value, proposed: fqdn, reverseZone: zone.name } };
        }
      }
    }

    db.prepare("UPDATE dns_records SET value = ?, updated_at = datetime('now') WHERE id = ?")
      .run(fqdn, existing.id);
  } else {
    db.prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, ?, 'PTR', ?, 1)"
    ).run(zone.id, ptrName, fqdn);
  }

  bumpZoneSerial(db, zone.id);
  return { updated: true };
}

export function setPtrForIp(db, ip, hostname, { enabledOnly = false } = {}) {
  const match = findReversePtrLocation(db, ip, { enabledOnly });
  if (!match) return { updated: false };

  const fqdn = String(hostname || '').trim();
  const existing = db.prepare(
    "SELECT id FROM dns_records WHERE zone_id = ? AND type = 'PTR' AND name = ?"
  ).get(match.zone.id, match.ptrName);

  if (existing) {
    db.prepare("UPDATE dns_records SET value = ?, updated_at = datetime('now') WHERE id = ?")
      .run(fqdn, existing.id);
  } else if (fqdn) {
    db.prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, ?, 'PTR', ?, 1)"
    ).run(match.zone.id, match.ptrName, fqdn);
  } else {
    return { updated: false };
  }

  bumpZoneSerial(db, match.zone.id);
  return { updated: true };
}

export function clearPtrForIp(db, ip) {
  return setPtrForIp(db, ip, ip, { enabledOnly: true });
}

export function clearPtrForARecord(db, recordName, ip, forwardZoneName) {
  const match = findReversePtrLocation(db, ip, { enabledOnly: true });
  if (!match) return { updated: false };

  const fqdn = fqdnForRecordName(recordName, forwardZoneName).toLowerCase();
  const existing = db.prepare(
    "SELECT value FROM dns_records WHERE zone_id = ? AND type = 'PTR' AND name = ?"
  ).get(match.zone.id, match.ptrName);

  if (!existing || String(existing.value || '').toLowerCase() !== fqdn) {
    return { updated: false };
  }

  return clearPtrForIp(db, ip);
}

export function createRecord(db, zone, fields, { forcePtr = false } = {}) {
  const insert = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, priority, weight, port, ttl, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      zone.id,
      fields.name,
      fields.type,
      fields.value,
      fields.priority ?? null,
      fields.weight ?? null,
      fields.port ?? null,
      fields.ttl ?? null,
      fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : 1
    );

    bumpZoneSerial(db, zone.id);

    let ptrResult = null;
    const enabled = fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : 1;
    if (enabled && fields.type === 'A' && zone.type === 'forward') {
      ptrResult = syncPtrForARecord(db, fields.name, fields.value, zone.name, { force: forcePtr });
      if (ptrResult?.conflict) {
        const err = new Error('PTR conflict');
        err.code = 'PTR_CONFLICT';
        err.conflict = ptrResult.conflict;
        throw err;
      }
    }

    return {
      record: db.prepare('SELECT * FROM dns_records WHERE id = ?').get(result.lastInsertRowid),
      ptrResult
    };
  });

  return insert();
}

export function updateRecord(db, zone, record, fields) {
  const update = db.transaction(() => {
    const oldEnabledA = record.enabled !== 0 && record.type === 'A' && zone.type === 'forward';
    const newEnabled = fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : record.enabled;
    const newEnabledA = newEnabled !== 0 && fields.type === 'A' && zone.type === 'forward';

    db.prepare(`
      UPDATE dns_records SET name = ?, type = ?, value = ?, priority = ?, weight = ?, port = ?, ttl = ?,
        enabled = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      fields.name,
      fields.type,
      fields.value,
      fields.priority,
      fields.weight,
      fields.port,
      fields.ttl,
      newEnabled,
      record.id
    );

    bumpZoneSerial(db, zone.id);

    if (oldEnabledA && (!newEnabledA || record.value !== fields.value)) {
      clearPtrForARecord(db, record.name, record.value, zone.name);
    }
    if (newEnabledA) {
      syncPtrForARecord(db, fields.name, fields.value, zone.name);
    }

    return db.prepare('SELECT * FROM dns_records WHERE id = ?').get(record.id);
  });

  return update();
}

export function deleteRecord(db, zone, record) {
  const del = db.transaction(() => {
    db.prepare('DELETE FROM dns_records WHERE id = ?').run(record.id);
    bumpZoneSerial(db, zone.id);

    if (record.enabled !== 0 && record.type === 'A' && zone.type === 'forward') {
      clearPtrForARecord(db, record.name, record.value, zone.name);
    }
  });

  del();
}

export function importRecords(db, zone, records) {
  const importTxn = db.transaction(() => {
    const existingExact = new Set();
    const existingByNameType = new Map();
    for (const r of db.prepare('SELECT id, type, name, value FROM dns_records WHERE zone_id = ?').all(zone.id)) {
      existingExact.add(`${r.type}|${r.name}|${r.value}`);
      existingByNameType.set(`${r.type}|${r.name}`, { id: r.id, value: r.value });
    }

    const insertRecord = db.prepare(
      'INSERT INTO dns_records (zone_id, name, type, value) VALUES (?, ?, ?, ?)'
    );
    const updateRecordValue = db.prepare(
      "UPDATE dns_records SET value = ?, updated_at = datetime('now') WHERE id = ?"
    );

    const results = {
      A: { created: 0, updated: 0, skipped: 0, failed: 0 },
      CNAME: { created: 0, updated: 0, skipped: 0, failed: 0 }
    };
    const aRecordsToSync = [];
    let changed = false;

    for (const r of records) {
      if (!results[r.type]) {
        continue;
      }

      const exactKey = `${r.type}|${r.name}|${r.value}`;
      if (existingExact.has(exactKey)) {
        results[r.type].skipped++;
        continue;
      }

      const nameKey = `${r.type}|${r.name}`;
      const existing = existingByNameType.get(nameKey);
      try {
        if (existing) {
          updateRecordValue.run(r.value, existing.id);
          existingExact.delete(`${r.type}|${r.name}|${existing.value}`);
          existingExact.add(exactKey);
          existingByNameType.set(nameKey, { id: existing.id, value: r.value });
          results[r.type].updated++;
        } else {
          const result = insertRecord.run(zone.id, r.name, r.type, r.value);
          existingExact.add(exactKey);
          existingByNameType.set(nameKey, { id: result.lastInsertRowid, value: r.value });
          results[r.type].created++;
        }
        changed = true;
        if (r.type === 'A') {
          aRecordsToSync.push({ name: r.name, value: r.value });
        }
      } catch {
        results[r.type].failed++;
      }
    }

    if (changed) {
      bumpZoneSerial(db, zone.id);
    }

    return { results, aRecordsToSync, changed };
  });

  return importTxn();
}
