export function createVlan(db, fields) {
  const result = db.prepare(
    'INSERT INTO vlans (vlan_id, name) VALUES (?, ?)'
  ).run(fields.vlanId, fields.name);
  return db.prepare('SELECT * FROM vlans WHERE id = ?').get(result.lastInsertRowid);
}

export function updateVlan(db, vlan, fields) {
  db.prepare('UPDATE vlans SET vlan_id = ?, name = ? WHERE id = ?')
    .run(fields.vlanId ?? vlan.vlan_id, fields.name ?? vlan.name, vlan.id);
  return db.prepare('SELECT * FROM vlans WHERE id = ?').get(vlan.id);
}

export function deleteVlan(db, vlanId) {
  return db.prepare('DELETE FROM vlans WHERE id = ?').run(vlanId);
}
