export function setCategoryEnabled(db, slug, enabled) {
  return db
    .prepare('UPDATE blocklist_categories SET enabled = ? WHERE slug = ?')
    .run(enabled ? 1 : 0, slug);
}

export function setCategorySourceUrl(db, slug, sourceUrl) {
  return db
    .prepare('UPDATE blocklist_categories SET source_url = ? WHERE slug = ?')
    .run(sourceUrl, slug);
}

export function addAllowlistEntry(db, domain, reason) {
  const result = db
    .prepare('INSERT INTO blocklist_allowlist (domain, reason) VALUES (?, ?)')
    .run(domain, reason || null);
  return result.lastInsertRowid;
}

export function deleteAllowlistEntry(db, entryId) {
  return db.prepare('DELETE FROM blocklist_allowlist WHERE id = ?').run(entryId);
}

// Empty the feeds and forget how they were fetched, keeping each category's
// settings: a backup's copy of the database (utils/backup.js). The etag and
// Last-Modified go too, so the next refresh downloads each feed in full
// instead of taking a 304 for a list this database no longer holds.
export function dropFeedDomains(db) {
  db.exec(`
    DELETE FROM blocklist_domains;
    DELETE FROM blocklist_stage;
    UPDATE blocklist_categories
      SET domain_count = 0, last_fetched_at = NULL, etag = NULL, last_modified = NULL;
  `);
}
