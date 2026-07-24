// Shared localStorage helpers

export function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

/**
 * One-time migration from ipam_ / ipam- prefixed keys to cidrella_ / cidrella-.
 * Safe to call on every app start. Only runs once (sets a migration flag).
 */
export function migrateStorageKeys() {
  if (localStorage.getItem('cidrella_storage_migrated')) return;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('ipam_') || key?.startsWith('ipam-')) {
        const newKey = key.replace(/^ipam[_-]/, (m) => m === 'ipam_' ? 'cidrella_' : 'cidrella-');
        localStorage.setItem(newKey, localStorage.getItem(key));
        localStorage.removeItem(key);
        i--; // adjust index after removal
      }
    }
    localStorage.setItem('cidrella_storage_migrated', '1');
  } catch { /* storage access may fail in private browsing */ }
}
