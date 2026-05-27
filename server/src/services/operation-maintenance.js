export function deleteAllTableData(db, tables) {
  db.pragma('foreign_keys = OFF');
  try {
    const deleteAll = db.transaction(() => {
      for (const table of tables) {
        db.prepare(`DELETE FROM "${table}"`).run();
      }
    });
    deleteAll();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
