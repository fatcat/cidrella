import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { BLOCKLIST_CATEGORIES, getDefaultCategoryUrl } from '../utils/blocklist-categories.js';
import { ensureCategoryRows, refreshCategory, refreshAllEnabled, generateBlocklistConfig } from '../utils/blocklist.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// GET /api/blocklists/categories — all categories with state
router.get('/categories', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  ensureCategoryRows(db);

  const rows = db.prepare('SELECT * FROM blocklist_categories ORDER BY slug').all();
  // Merge with catalog metadata
  const result = BLOCKLIST_CATEGORIES.map(cat => {
    const row = rows.find(r => r.slug === cat.slug) || {};
    return {
      slug: cat.slug,
      name: cat.name,
      description: cat.description,
      group: cat.group,
      enabled: !!row.enabled,
      domain_count: row.domain_count || 0,
      last_fetched_at: row.last_fetched_at || null,
      last_error: row.last_error || null,
      source_url: row.source_url || getDefaultCategoryUrl(cat.slug),
      is_custom_url: !!row.source_url
    };
  });
  res.json(result);
});

// PUT /api/blocklists/categories/:slug — enable/disable a category
router.put('/categories/:slug', requirePerm('dns:write'), async (req, res) => {
  const db = getDb();
  const { slug } = req.params;
  const { enabled } = req.body;

  const cat = BLOCKLIST_CATEGORIES.find(c => c.slug === slug);
  if (!cat) return res.status(404).json({ error: 'Unknown category' });
  if (enabled === undefined) return res.status(400).json({ error: 'enabled field is required' });

  ensureCategoryRows(db);
  db.prepare('UPDATE blocklist_categories SET enabled = ? WHERE slug = ?')
    .run(enabled ? 1 : 0, slug);

  audit(req.user.id, 'update', 'blocklist_category', null, { slug, enabled });

  // If enabling and never fetched, trigger initial download
  if (enabled) {
    const row = db.prepare('SELECT last_fetched_at FROM blocklist_categories WHERE slug = ?').get(slug);
    if (!row?.last_fetched_at) {
      try {
        const result = await refreshCategory(db, slug);
        generateBlocklistConfig(db);
        return res.json({ ok: true, domain_count: result.count, fetched: true });
      } catch (err) {
        return res.json({ ok: true, fetched: false, error: err.message });
      }
    }
  }

  generateBlocklistConfig(db);
  res.json({ ok: true });
});

// PUT /api/blocklists/categories/:slug/url — update source URL for a category
router.put('/categories/:slug/url', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const { slug } = req.params;
  const { source_url } = req.body;

  const cat = BLOCKLIST_CATEGORIES.find(c => c.slug === slug);
  if (!cat) return res.status(404).json({ error: 'Unknown category' });

  ensureCategoryRows(db);

  // Empty or null resets to default
  const urlValue = source_url?.trim() || null;
  if (urlValue && !/^https?:\/\//i.test(urlValue)) {
    return res.status(400).json({ error: 'Source URL must be an HTTP(S) URL' });
  }
  db.prepare('UPDATE blocklist_categories SET source_url = ? WHERE slug = ?')
    .run(urlValue, slug);

  audit(req.user.id, 'update', 'blocklist_category', null, { slug, source_url: urlValue || getDefaultCategoryUrl(slug) });
  res.json({ ok: true, source_url: urlValue || getDefaultCategoryUrl(slug), is_custom_url: !!urlValue });
});

// POST /api/blocklists/categories/:slug/refresh — manual refresh single category
router.post('/categories/:slug/refresh', requirePerm('dns:write'), async (req, res) => {
  const db = getDb();
  const { slug } = req.params;

  const cat = BLOCKLIST_CATEGORIES.find(c => c.slug === slug);
  if (!cat) return res.status(404).json({ error: 'Unknown category' });

  try {
    const result = await refreshCategory(db, slug);
    generateBlocklistConfig(db);
    const row = db.prepare('SELECT domain_count, last_fetched_at FROM blocklist_categories WHERE slug = ?').get(slug);
    res.json({ ok: true, domain_count: row?.domain_count, last_fetched_at: row?.last_fetched_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/blocklists/refresh — refresh all enabled categories
router.post('/refresh', requirePerm('dns:write'), async (req, res) => {
  const db = getDb();
  try {
    const changed = await refreshAllEnabled(db);
    res.json({ ok: true, changed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/blocklists/stats
router.get('/stats', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const enabledCount = db.prepare('SELECT COUNT(*) as c FROM blocklist_categories WHERE enabled = 1').get().c;
  const totalDomains = db.prepare(`
    SELECT COUNT(DISTINCT bd.domain) as c
    FROM blocklist_domains bd
    JOIN blocklist_categories bc ON bd.category_slug = bc.slug
    WHERE bc.enabled = 1
  `).get().c;
  const whitelistCount = db.prepare('SELECT COUNT(*) as c FROM blocklist_whitelist').get().c;
  const lastUpdate = db.prepare('SELECT MAX(last_fetched_at) as t FROM blocklist_categories WHERE enabled = 1').get().t;

  res.json({ enabled_categories: enabledCount, total_domains: totalDomains, whitelist_count: whitelistCount, last_update: lastUpdate });
});

// GET /api/blocklists/settings
router.get('/settings', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const keys = ['blocklist_enabled', 'blocklist_redirect_ip', 'blocklist_update_schedule'];
  const settings = {};
  for (const key of keys) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    settings[key] = row?.value || '';
  }
  res.json(settings);
});

// PUT /api/blocklists/settings
router.put('/settings', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const allowed = ['blocklist_enabled', 'blocklist_redirect_ip', 'blocklist_update_schedule'];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(req.body[key]), key);
    }
  }

  // Regenerate config in case enabled state changed
  generateBlocklistConfig(db);

  audit(req.user.id, 'update', 'blocklist_settings', null, req.body);
  res.json({ ok: true });
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

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * limitNum;
  const escaped = q.replace(/[%_]/g, '\\$&');
  const searchTerm = `%${escaped}%`;

  const total = db.prepare(`
    SELECT COUNT(DISTINCT bd.domain) as c
    FROM blocklist_domains bd
    JOIN blocklist_categories bc ON bd.category_slug = bc.slug
    WHERE bc.enabled = 1 AND bd.domain LIKE ? ESCAPE '\\'
  `).get(searchTerm).c;

  const items = db.prepare(`
    SELECT bd.domain, GROUP_CONCAT(bc.slug, ', ') as categories
    FROM blocklist_domains bd
    JOIN blocklist_categories bc ON bd.category_slug = bc.slug
    WHERE bc.enabled = 1 AND bd.domain LIKE ? ESCAPE '\\'
    GROUP BY bd.domain
    ORDER BY bd.domain
    LIMIT ? OFFSET ?
  `).all(searchTerm, limitNum, offset);

  const whitelisted = new Set(
    db.prepare('SELECT domain FROM blocklist_whitelist').all().map(r => r.domain)
  );

  for (const item of items) {
    item.whitelisted = whitelisted.has(item.domain);
  }

  res.json({ items, total, page: pageNum, limit: limitNum });
});

export default router;
