export function createRangeType(db, fields) {
  const result = db.prepare(
    'INSERT INTO range_types (name, color, is_system, description) VALUES (?, ?, ?, ?)'
  ).run(fields.name, fields.color || '#6b7280', fields.isSystem ? 1 : 0, fields.description || null);
  return db.prepare('SELECT * FROM range_types WHERE id = ?').get(result.lastInsertRowid);
}

export function updateRangeType(db, type, fields) {
  db.prepare(`
    UPDATE range_types SET name = ?, color = ?, description = ?, updated_at = datetime('now') WHERE id = ?
  `).run(
    fields.name ?? type.name,
    fields.color ?? type.color,
    fields.description !== undefined ? fields.description : type.description,
    type.id
  );
  return db.prepare('SELECT * FROM range_types WHERE id = ?').get(type.id);
}

export function deleteRangeType(db, typeId) {
  return db.prepare('DELETE FROM range_types WHERE id = ?').run(typeId);
}

export function seedSystemRangeTypes(db) {
  return db.prepare(`INSERT INTO range_types (name, color, is_system, description) VALUES
    ('Network',   '#6b7280', 1, 'Network address (not assignable)'),
    ('Gateway',   '#f59e0b', 1, 'Default gateway address'),
    ('Broadcast', '#6b7280', 1, 'Broadcast address (not assignable)'),
    ('DHCP Scope', '#3b82f6', 1, 'Dynamic DHCP allocation scope'),
    ('Static',    '#10b981', 1, 'Statically assigned addresses')
  `).run();
}
