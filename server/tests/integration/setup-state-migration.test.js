/**
 * Migration 074 decides whether an existing database has already been set
 * up. Anything that shows the appliance was used marks setup done: a
 * network, a user who changed their password, or the classic network wizard's
 * flag. A database with only a freshly seeded admin (must_change_password = 1)
 * is a first run and stays unmarked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { databaseThrough } from '../helpers/migrations.js';

const tmpDirs = [];

const stateOf = (db) =>
  db.prepare("SELECT value FROM settings WHERE key = 'setup_state'").get()?.value ?? null;

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('migration 074: setup_state for existing databases', () => {
  it('leaves a fresh database unmarked', () => {
    const { db, migrate } = databaseThrough(73, { tmpDirs });
    migrate(74);
    expect(stateOf(db)).toBeNull();
  });

  it('leaves a database with only the seeded admin unmarked', () => {
    const { db, migrate } = databaseThrough(73, { tmpDirs });
    db.prepare(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', 'x', 'admin', 1)",
    ).run();
    migrate(74);
    expect(stateOf(db)).toBeNull();
  });

  it('marks a database with a network as done', () => {
    const { db, migrate } = databaseThrough(73, { tmpDirs });
    db.prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, status, depth) VALUES ('10.9.0.0/24', 'lan', '10.9.0.0', '10.9.0.255',
        24, 256, 'allocated', 0)`,
    ).run();
    migrate(74);
    expect(JSON.parse(stateOf(db))).toMatchObject({ done: true, source: 'upgrade' });
  });

  it('marks a database whose admin has changed their password as done', () => {
    const { db, migrate } = databaseThrough(73, { tmpDirs });
    db.prepare(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', 'x', 'admin', 0)",
    ).run();
    migrate(74);
    expect(JSON.parse(stateOf(db)).done).toBe(true);
  });

  it('marks a database that finished the classic network wizard as done', () => {
    const { db, migrate } = databaseThrough(73, { tmpDirs });
    db.prepare("INSERT INTO settings (key, value) VALUES ('setup_wizard_completed', '1')").run();
    migrate(74);
    expect(JSON.parse(stateOf(db)).done).toBe(true);
  });

  it('never overwrites a state that already exists', () => {
    const { db, migrate } = databaseThrough(73, { tmpDirs });
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('setup_state', '{\"done\":false}')",
    ).run();
    db.prepare(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', 'x', 'admin', 0)",
    ).run();
    migrate(74);
    expect(stateOf(db)).toBe('{"done":false}');
  });
});
