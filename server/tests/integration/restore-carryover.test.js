/**
 * The two-factor carry-over across a restore. collectRestoreCarryover reads
 * the restoring user's enrolment from the running database; the restore
 * parks it in the staged database; applyRestoreCarryover puts it on the
 * matching account at the first boot after the restore, once, and never
 * over an enrolment the backup already had.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../helpers/test-db.js';

const { collectRestoreCarryover, applyRestoreCarryover, RESTORE_CARRYOVER_KEY } =
  await import('../../src/utils/backup.js');

let tmpDir;
let db;
let adminId;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  adminId = Number(
    db
      .prepare(
        "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('carry-admin', 'x', 'admin', 0)",
      )
      .run().lastInsertRowid,
  );
});
afterAll(() => cleanupTestDb(tmpDir));

const park = (value) =>
  db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(RESTORE_CARRYOVER_KEY, JSON.stringify(value));
const parked = () =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(RESTORE_CARRYOVER_KEY);
const userRow = () =>
  db
    .prepare(
      "SELECT totp_enabled, totp_secret, totp_last_step FROM users WHERE username = 'carry-admin'",
    )
    .get();
const codeCount = () =>
  db
    .prepare('SELECT COUNT(*) AS c FROM user_backup_codes WHERE user_id = ? AND used_at IS NULL')
    .get(adminId).c;

describe('collectRestoreCarryover', () => {
  it('is null for an account without two-factor', () => {
    expect(collectRestoreCarryover(db, adminId)).toBeNull();
  });

  it('captures the enrolment and the unused backup codes', () => {
    db.prepare(
      "UPDATE users SET totp_secret = 'SECRET', totp_enabled = 1, totp_last_step = 42 WHERE id = ?",
    ).run(adminId);
    db.prepare(
      "INSERT INTO user_backup_codes (user_id, code_hash) VALUES (?, 'h1'), (?, 'h2')",
    ).run(adminId, adminId);
    db.prepare(
      "INSERT INTO user_backup_codes (user_id, code_hash, used_at) VALUES (?, 'used', datetime('now'))",
    ).run(adminId);
    expect(collectRestoreCarryover(db, adminId)).toEqual({
      totp: {
        username: 'carry-admin',
        secret: 'SECRET',
        last_step: 42,
        backup_code_hashes: ['h1', 'h2'],
      },
    });
  });
});

describe('applyRestoreCarryover', () => {
  it('does nothing and reports null when nothing is parked', () => {
    expect(applyRestoreCarryover(db)).toBeNull();
  });

  it('puts the enrolment on the matching account that has none, once', () => {
    db.prepare(
      'UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?',
    ).run(adminId);
    db.prepare('DELETE FROM user_backup_codes WHERE user_id = ?').run(adminId);
    park({
      totp: {
        username: 'carry-admin',
        secret: 'SECRET',
        last_step: 42,
        backup_code_hashes: ['h1', 'h2', 'h3'],
      },
    });
    expect(applyRestoreCarryover(db)).toEqual({ totp: 'applied' });
    expect(userRow()).toEqual({ totp_enabled: 1, totp_secret: 'SECRET', totp_last_step: 42 });
    expect(codeCount()).toBe(3);
    expect(parked()).toBeUndefined();
    const audit = db
      .prepare("SELECT details FROM audit_log WHERE action = 'totp_carried_over'")
      .get();
    expect(JSON.parse(audit.details)).toEqual({ backup_codes: 3 });
    expect(applyRestoreCarryover(db)).toBeNull();
  });

  it('never overwrites an enrolment the backup already had', () => {
    park({
      totp: { username: 'carry-admin', secret: 'OTHER', last_step: 1, backup_code_hashes: [] },
    });
    expect(applyRestoreCarryover(db)).toEqual({ totp: 'already_enabled' });
    expect(userRow().totp_secret).toBe('SECRET');
    expect(codeCount()).toBe(3);
  });

  it('drops the parked value when the account does not exist in the backup', () => {
    park({ totp: { username: 'nobody', secret: 'S', last_step: null, backup_code_hashes: [] } });
    expect(applyRestoreCarryover(db)).toEqual({ totp: 'no_such_user' });
    expect(parked()).toBeUndefined();
  });

  it('survives a corrupt parked value', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      RESTORE_CARRYOVER_KEY,
      'not json',
    );
    expect(applyRestoreCarryover(db)).toEqual({ totp: 'none' });
    expect(parked()).toBeUndefined();
  });
});
