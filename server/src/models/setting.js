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
  return db
    .prepare(
      `
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `,
    )
    .run(key, String(value));
}

export function deleteSetting(db, key) {
  return db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// First-run setup state: one marker per wizard step so an interrupted setup
// resumes where it stopped. Shape: { password, deployment, import, done }.
export const SETUP_STATE_KEY = 'setup_state';
const SETUP_STATE_DEFAULT = {
  password: false,
  totp: null,
  deployment: null,
  import: null,
  done: false,
};

export function getSetupState(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETUP_STATE_KEY);
  let parsed;
  try {
    parsed = row?.value ? JSON.parse(row.value) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  return { ...SETUP_STATE_DEFAULT, ...parsed, done: parsed.done === true };
}

export function setSetupState(db, patch) {
  const next = { ...getSetupState(db), ...patch };
  upsertSettingWithConflict(db, SETUP_STATE_KEY, JSON.stringify(next));
  return next;
}

export function isSetupRequired(db) {
  return !getSetupState(db).done;
}
