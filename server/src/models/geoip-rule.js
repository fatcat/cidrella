export function addRules(db, countries) {
  const added = [];
  db.transaction(() => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO geoip_rules (country_code, country_name) VALUES (?, ?)'
    );
    for (const c of countries) {
      const result = insert.run(c.code, c.name || c.code);
      if (result.changes > 0) added.push(c.code);
    }
  })();
  return added;
}

export function setEnabled(db, ruleId, enabled) {
  return db.prepare('UPDATE geoip_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, ruleId);
}

export function deleteRule(db, ruleId) {
  return db.prepare('DELETE FROM geoip_rules WHERE id = ?').run(ruleId);
}
