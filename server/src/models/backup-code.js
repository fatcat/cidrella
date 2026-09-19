// One-time backup codes for two-factor sign-in. Only hashes are stored; the
// plaintext exists once, in the response that hands the codes to the user.

export function replaceBackupCodes(db, userId, hashes) {
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM user_backup_codes WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO user_backup_codes (user_id, code_hash) VALUES (?, ?)');
    for (const hash of hashes) insert.run(userId, hash);
  });
  replace();
}

export function deleteBackupCodes(db, userId) {
  return db.prepare('DELETE FROM user_backup_codes WHERE user_id = ?').run(userId);
}

/** Spend the code if it is one of this user's unused codes. Returns true when it was. */
export function consumeBackupCode(db, userId, hash) {
  const result = db
    .prepare(
      `UPDATE user_backup_codes SET used_at = datetime('now')
       WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
    )
    .run(userId, hash);
  return result.changes === 1;
}

export function countUnusedBackupCodes(db, userId) {
  return db
    .prepare('SELECT COUNT(*) AS c FROM user_backup_codes WHERE user_id = ? AND used_at IS NULL')
    .get(userId).c;
}
