export function setCategoryEnabled(db, slug, enabled) {
  return db.prepare('UPDATE blocklist_categories SET enabled = ? WHERE slug = ?').run(enabled ? 1 : 0, slug);
}

export function setCategorySourceUrl(db, slug, sourceUrl) {
  return db.prepare('UPDATE blocklist_categories SET source_url = ? WHERE slug = ?').run(sourceUrl, slug);
}

export function addWhitelistEntry(db, domain, reason) {
  const result = db.prepare('INSERT INTO blocklist_whitelist (domain, reason) VALUES (?, ?)').run(domain, reason || null);
  return result.lastInsertRowid;
}

export function deleteWhitelistEntry(db, entryId) {
  return db.prepare('DELETE FROM blocklist_whitelist WHERE id = ?').run(entryId);
}
