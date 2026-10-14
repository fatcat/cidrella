/**
 * Migration 089: audit rows gain actor, origin, source and source_ip; old rows
 * get their actor from the user, the bare verbs become <entity>_<verb>, and the
 * old 7 day retention becomes 90.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { databaseThrough } from '../helpers/migrations.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function seeded() {
  const made = databaseThrough(88);
  dirs.push(made.tmpDir);
  const { db } = made;
  const userId = db
    .prepare("INSERT INTO users (username, password_hash, role) VALUES ('ops', 'x', 'admin')")
    .run().lastInsertRowid;
  const insert = db.prepare(
    'INSERT INTO audit_log (user_id, action, entity_type, details) VALUES (?, ?, ?, ?)',
  );
  insert.run(userId, 'create', 'vlan', '{"vlan_id":10}');
  insert.run(userId, 'update', 'dns_zone', null);
  insert.run(userId, 'delete', 'subnet', null);
  insert.run(userId, 'configure', 'dhcp', null);
  insert.run(userId, 'restore', 'backup', null);
  insert.run(null, 'zone_updated', 'dns_zone', null);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('audit_log_retention_days', ?)",
  ).run('7');
  return made;
}

describe('migration 089', () => {
  it('names the actor of each old row and renames the bare verbs', () => {
    const { db, migrate } = seeded();
    migrate(89);
    const rows = db.prepare('SELECT actor, origin, action FROM audit_log ORDER BY id').all();
    expect(rows).toEqual([
      { actor: 'ops', origin: null, action: 'vlan_created' },
      { actor: 'ops', origin: null, action: 'dns_zone_updated' },
      { actor: 'ops', origin: null, action: 'subnet_deleted' },
      { actor: 'ops', origin: null, action: 'dhcp_updated' },
      { actor: 'ops', origin: null, action: 'backup_restored' },
      { actor: null, origin: null, action: 'zone_updated' },
    ]);
  });

  it('moves the old default retention to 90 and keeps a chosen one', () => {
    const { db, migrate } = seeded();
    migrate(89);
    const read = () =>
      db.prepare("SELECT value FROM settings WHERE key = 'audit_log_retention_days'").get().value;
    expect(read()).toBe('90');

    const other = databaseThrough(88);
    dirs.push(other.tmpDir);
    other.db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('audit_log_retention_days', '30')",
      )
      .run();
    other.migrate(89);
    expect(
      other.db.prepare("SELECT value FROM settings WHERE key = 'audit_log_retention_days'").get()
        .value,
    ).toBe('30');
  });
});
