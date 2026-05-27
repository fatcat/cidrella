export function createFolder(db, fields) {
  const result = db.prepare(
    'INSERT INTO folders (name, description, sort_order) VALUES (?, ?, ?)'
  ).run(fields.name, fields.description || null, fields.sortOrder);
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(result.lastInsertRowid);
}

export function updateFolder(db, folder, fields) {
  db.prepare(`
    UPDATE folders SET name = ?, description = ?, sort_order = ? WHERE id = ?
  `).run(
    fields.name ?? folder.name,
    fields.description !== undefined ? fields.description : folder.description,
    fields.sortOrder !== undefined ? fields.sortOrder : folder.sort_order,
    folder.id
  );
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(folder.id);
}

export function deleteFolder(db, folderId) {
  return db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
}

export function seedDefaultFolder(db) {
  return db.prepare(
    "INSERT INTO folders (name, description, sort_order) VALUES ('Default', 'Default folder', 0)"
  ).run();
}
