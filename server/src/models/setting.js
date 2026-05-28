export function upsertSetting(db, key, value) {
  return upsertSettingWithConflict(db, key, value);
}

export function upsertSettings(db, pairs) {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const saveAll = db.transaction((items) => {
    for (const [key, value] of items) stmt.run(key, String(value));
  });
  return saveAll(pairs);
}

export function upsertSettingWithConflict(db, key, value) {
  return db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function deleteSetting(db, key) {
  return db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
