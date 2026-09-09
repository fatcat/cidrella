export function enqueueGeneration(db, hookName) {
  db.prepare(`
    INSERT INTO configuration_generations
      (hook_name, desired_generation, status, requested_at, updated_at)
    VALUES (?, 1, 'pending', datetime('now'), datetime('now'))
    ON CONFLICT(hook_name) DO UPDATE SET
      desired_generation = desired_generation + 1,
      status = 'pending', last_error = NULL,
      requested_at = datetime('now'), updated_at = datetime('now')
  `).run(hookName);
  return findGeneration(db, hookName);
}

export function findGeneration(db, hookName) {
  return db.prepare('SELECT * FROM configuration_generations WHERE hook_name = ?').get(hookName);
}

export function listGenerations(db) {
  return db.prepare('SELECT * FROM configuration_generations ORDER BY hook_name').all();
}

export function markApplying(db, hookName) {
  db.prepare(`
    UPDATE configuration_generations
    SET status = 'applying', last_error = NULL, updated_at = datetime('now')
    WHERE hook_name = ?
  `).run(hookName);
  return findGeneration(db, hookName);
}

export function markApplied(db, hookName, generation) {
  db.prepare(`
    UPDATE configuration_generations
    SET applied_generation = MAX(applied_generation, ?),
      status = CASE WHEN desired_generation > ? THEN 'pending' ELSE 'applied' END,
      last_error = NULL, applied_at = datetime('now'), updated_at = datetime('now')
    WHERE hook_name = ?
  `).run(generation, generation, hookName);
}

export function markFailed(db, hookName, error) {
  db.prepare(`
    UPDATE configuration_generations
    SET status = 'failed', last_error = ?, updated_at = datetime('now')
    WHERE hook_name = ?
  `).run(String(error || 'Unknown apply failure').slice(0, 2048), hookName);
}
