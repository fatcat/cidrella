const USER_COLS = 'id, username, role, kind, must_change_password, created_at, updated_at';

export function createUser(db, fields) {
  const result = db
    .prepare(
      'INSERT INTO users (username, password_hash, role, kind, must_change_password) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      fields.username,
      fields.passwordHash,
      fields.role,
      fields.kind === 'service' ? 'service' : 'person',
      fields.mustChangePassword ? 1 : 0,
    );
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(result.lastInsertRowid);
}

export function updateRole(db, userId, role) {
  db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(
    role,
    userId,
  );
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(userId);
}

export function deleteUser(db, userId) {
  const del = db.transaction(() => {
    db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  return del();
}

export function resetPassword(db, userId, passwordHash) {
  return db
    .prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?",
    )
    .run(passwordHash, userId);
}

export function changePassword(db, userId, passwordHash) {
  db.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 0, password_reset_by = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(passwordHash, userId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

export function bumpTokenVersion(db, userId) {
  return db
    .prepare("UPDATE users SET updated_at = datetime('now','+1 second') WHERE id = ?")
    .run(userId);
}

export function updatePreferences(db, userId, preferences) {
  return db
    .prepare("UPDATE users SET preferences = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(preferences), userId);
}

// Two-factor. None of these touch updated_at: the middleware treats a bump
// as "every token before this instant is dead", and the wizard enabling TOTP
// mid-session must keep its session.
export function setPendingTotpSecret(db, userId, secret) {
  return db
    .prepare(
      'UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_step = NULL WHERE id = ?',
    )
    .run(secret, userId);
}

export function enableTotp(db, userId, lastStep) {
  return db
    .prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?')
    .run(lastStep, userId);
}

export function disableTotp(db, userId) {
  return db
    .prepare(
      'UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?',
    )
    .run(userId);
}

export function recordTotpStep(db, userId, step) {
  return db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
}

/** Put a saved enrolment back on an account that has none (restore carry-over). */
export function restoreTotp(db, userId, { secret, lastStep = null }) {
  return db
    .prepare(
      'UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_last_step = ? WHERE id = ? AND totp_enabled = 0',
    )
    .run(secret, lastStep, userId);
}
