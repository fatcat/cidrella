import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { refreshSource, refreshAllSources, generateBlocklistConfig } from '../utils/blocklist.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// GET /api/blocklists/sources
router.get('/sources', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const sources = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(DISTINCT domain) FROM blocklist_entries WHERE source_id = s.id) as entry_count
    FROM blocklist_sources s
    ORDER BY s.name
  `).all();
  res.json(sources);
});

const VALID_CATEGORIES = ['ads', 'malware', 'tracking', 'adult', 'other'];

// POST /api/blocklists/sources
router.post('/sources', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const { name, url, format, enabled, auto_update, update_interval_hours, category } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL are required' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (category && !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  const existing = db.prepare('SELECT id FROM blocklist_sources WHERE url = ?').get(url);
  if (existing) {
    return res.status(409).json({ error: 'A source with this URL already exists' });
  }

  const result = db.prepare(`
    INSERT INTO blocklist_sources (name, url, format, enabled, auto_update, update_interval_hours, category)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, url,
    format || 'auto',
    enabled !== undefined ? (enabled ? 1 : 0) : 1,
    auto_update !== undefined ? (auto_update ? 1 : 0) : 1,
    update_interval_hours || 24,
    category || 'other'
  );

  audit(req.user.id, 'create', 'blocklist_source', result.lastInsertRowid, { name, url });
  res.status(201).json({ id: result.lastInsertRowid });
});

// PUT /api/blocklists/sources/:id
router.put('/sources/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const source = db.prepare('SELECT * FROM blocklist_sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Source not found' });

  const { name, url, format, enabled, auto_update, update_interval_hours, category } = req.body;

  if (url && url !== source.url) {
    try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    const dup = db.prepare('SELECT id FROM blocklist_sources WHERE url = ? AND id != ?').get(url, source.id);
    if (dup) return res.status(409).json({ error: 'A source with this URL already exists' });
  }

  if (category && !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  db.prepare(`UPDATE blocklist_sources SET
    name = ?, url = ?, format = ?, enabled = ?, auto_update = ?, update_interval_hours = ?,
    category = ?, updated_at = datetime('now')
    WHERE id = ?`).run(
    name || source.name,
    url || source.url,
    format || source.format,
    enabled !== undefined ? (enabled ? 1 : 0) : source.enabled,
    auto_update !== undefined ? (auto_update ? 1 : 0) : source.auto_update,
    update_interval_hours || source.update_interval_hours,
    category || source.category,
    source.id
  );

  // Regenerate config if enabled state changed
  if (enabled !== undefined && (enabled ? 1 : 0) !== source.enabled) {
    generateBlocklistConfig(db);
  }

  audit(req.user.id, 'update', 'blocklist_source', source.id, { name: name || source.name });
  res.json({ ok: true });
});

// DELETE /api/blocklists/sources/:id
router.delete('/sources/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const source = db.prepare('SELECT * FROM blocklist_sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Source not found' });

  db.prepare('DELETE FROM blocklist_sources WHERE id = ?').run(source.id);
  generateBlocklistConfig(db);

  audit(req.user.id, 'delete', 'blocklist_source', source.id, { name: source.name });
  res.json({ ok: true });
});

// GET /api/blocklists/categories — list categories with source counts and enabled state
router.get('/categories', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT category,
      COUNT(*) as source_count,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_count,
      SUM(last_entry_count) as total_entries
    FROM blocklist_sources
    GROUP BY category
    ORDER BY category
  `).all();
  res.json(rows);
});

// PUT /api/blocklists/categories/:name — enable/disable all sources in a category
router.put('/categories/:name', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const { name } = req.params;
  const { enabled } = req.body;

  if (!VALID_CATEGORIES.includes(name)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }
  if (enabled === undefined) {
    return res.status(400).json({ error: 'enabled field is required' });
  }

  const result = db.prepare('UPDATE blocklist_sources SET enabled = ?, updated_at = datetime(\'now\') WHERE category = ?')
    .run(enabled ? 1 : 0, name);

  if (result.changes > 0) {
    generateBlocklistConfig(db);
  }

  audit(req.user.id, 'update', 'blocklist_category', null, { category: name, enabled });
  res.json({ ok: true, updated: result.changes });
});

// POST /api/blocklists/sources/:id/refresh
router.post('/sources/:id/refresh', requirePerm('dns:write'), async (req, res) => {
  const db = getDb();
  try {
    await refreshSource(db, parseInt(req.params.id, 10));
    generateBlocklistConfig(db);
    const source = db.prepare('SELECT last_entry_count, last_fetched_at FROM blocklist_sources WHERE id = ?').get(req.params.id);
    res.json({ ok: true, entry_count: source?.last_entry_count, last_fetched_at: source?.last_fetched_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/blocklists/refresh
router.post('/refresh', requirePerm('dns:write'), async (req, res) => {
  const db = getDb();
  try {
    const changed = await refreshAllSources(db);
    res.json({ ok: true, changed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/blocklists/stats
router.get('/stats', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const totalSources = db.prepare('SELECT COUNT(*) as c FROM blocklist_sources').get().c;
  const enabledSources = db.prepare('SELECT COUNT(*) as c FROM blocklist_sources WHERE enabled = 1').get().c;
  const totalDomains = db.prepare(`
    SELECT COUNT(DISTINCT be.domain) as c
    FROM blocklist_entries be
    JOIN blocklist_sources bs ON be.source_id = bs.id
    WHERE bs.enabled = 1
  `).get().c;
  const whitelistCount = db.prepare('SELECT COUNT(*) as c FROM blocklist_whitelist').get().c;
  const lastUpdate = db.prepare('SELECT MAX(last_fetched_at) as t FROM blocklist_sources WHERE enabled = 1').get().t;

  res.json({ total_sources: totalSources, enabled_sources: enabledSources, total_domains: totalDomains, whitelist_count: whitelistCount, last_update: lastUpdate });
});

// GET /api/blocklists/whitelist
router.get('/whitelist', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const items = db.prepare('SELECT * FROM blocklist_whitelist ORDER BY domain').all();
  res.json(items);
});

// POST /api/blocklists/whitelist
router.post('/whitelist', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const { domain, reason } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain is required' });

  const normalized = domain.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM blocklist_whitelist WHERE domain = ?').get(normalized);
  if (existing) return res.status(409).json({ error: 'Domain already whitelisted' });

  const result = db.prepare('INSERT INTO blocklist_whitelist (domain, reason) VALUES (?, ?)').run(normalized, reason || null);
  generateBlocklistConfig(db);

  audit(req.user.id, 'create', 'blocklist_whitelist', result.lastInsertRowid, { domain: normalized });
  res.status(201).json({ id: result.lastInsertRowid });
});

// DELETE /api/blocklists/whitelist/:id
router.delete('/whitelist/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM blocklist_whitelist WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Whitelist entry not found' });

  db.prepare('DELETE FROM blocklist_whitelist WHERE id = ?').run(entry.id);
  generateBlocklistConfig(db);

  audit(req.user.id, 'delete', 'blocklist_whitelist', entry.id, { domain: entry.domain });
  res.json({ ok: true });
});

// GET /api/blocklists/search
router.get('/search', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const { q, page = 1, limit = 50 } = req.query;
  if (!q || q.length < 2) return res.json({ items: [], total: 0 });

  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const searchTerm = `%${q}%`;

  const total = db.prepare(`
    SELECT COUNT(DISTINCT be.domain) as c
    FROM blocklist_entries be
    JOIN blocklist_sources bs ON be.source_id = bs.id
    WHERE bs.enabled = 1 AND be.domain LIKE ?
  `).get(searchTerm).c;

  const items = db.prepare(`
    SELECT be.domain, GROUP_CONCAT(bs.name, ', ') as sources
    FROM blocklist_entries be
    JOIN blocklist_sources bs ON be.source_id = bs.id
    WHERE bs.enabled = 1 AND be.domain LIKE ?
    GROUP BY be.domain
    ORDER BY be.domain
    LIMIT ? OFFSET ?
  `).all(searchTerm, parseInt(limit, 10), offset);

  const whitelisted = new Set(
    db.prepare('SELECT domain FROM blocklist_whitelist').all().map(r => r.domain)
  );

  for (const item of items) {
    item.whitelisted = whitelisted.has(item.domain);
  }

  res.json({ items, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
});

export default router;
