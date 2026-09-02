import { Router } from 'express';
import { getDb, audit, getSetting } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { BLOCKLIST_CATEGORIES, getDefaultCategoryUrl } from '../utils/blocklist-categories.js';
import { ensureCategoryRows, refreshCategory, refreshAllEnabled, generateBlocklistConfig, SCHEDULE_HOURS } from '../utils/blocklist.js';
import { validateOutboundUrl } from '../utils/url-guard.js';
import { isValidIpv4, isValidDomain } from '../utils/ip.js';
import { isIntInRangeCoercing } from '../utils/validation.js';
import * as Setting from '../models/setting.js';
import * as BlocklistStore from '../models/blocklist-store.js';

const router = Router();

// GET /api/blocklists/categories: all categories with state
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

// PUT /api/blocklists/categories/:slug: enable/disable a category
router.put('/categories/:slug', requirePerm('dns:write'), async (req, res) => {
  const db = getDb();
  const { slug } = req.params;
  const { enabled } = req.body;

  const cat = BLOCKLIST_CATEGORIES.find(c => c.slug === slug);
  if (!cat) return res.status(404).json({ error: 'Unknown category' });
  // Require a real boolean. The old check accepted any truthy value, so
  // {"enabled":{...}} enabled the category and kicked off a live download.
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });

  ensureCategoryRows(db);
  BlocklistStore.setCategoryEnabled(db, slug, enabled);

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

// PUT /api/blocklists/categories/:slug/url: update source URL for a category
router.put('/categories/:slug/url', requirePerm('dns:write'), async (req, res) => {
  const db = getDb();
  const { slug } = req.params;
  const { source_url } = req.body || {};

  const cat = BLOCKLIST_CATEGORIES.find(c => c.slug === slug);
  if (!cat) return res.status(404).json({ error: 'Unknown category' });

  if (source_url !== undefined && source_url !== null && typeof source_url !== 'string') {
    return res.status(400).json({ error: 'source_url must be a string or null' });
  }

  ensureCategoryRows(db);

  // Empty or null resets to default
  const urlValue = source_url?.trim() || null;
  if (urlValue) {
    // v0.4.15: run the full SSRF guard here so a bad URL is rejected at
    // save-time rather than at refresh-time. Refresh validates again in
    // case DNS moves later, but storing a bogus URL is itself undesirable.
    const check = await validateOutboundUrl(urlValue);
    if (!check.ok) return res.status(400).json({ error: `Source URL refused: ${check.reason}` });
  }
  BlocklistStore.setCategorySourceUrl(db, slug, urlValue);

  audit(req.user.id, 'update', 'blocklist_category', null, { slug, source_url: urlValue || getDefaultCategoryUrl(slug) });
  res.json({ ok: true, source_url: urlValue || getDefaultCategoryUrl(slug), is_custom_url: !!urlValue });
});

// POST /api/blocklists/categories/:slug/refresh: manual refresh single category
router.post('/categories/:slug/refresh', requirePerm('dns:write'), async (req, res) => {
  const db = getDb();
  const { slug } = req.params;

  const cat = BLOCKLIST_CATEGORIES.find(c => c.slug === slug);
  if (!cat) return res.status(404).json({ error: 'Unknown category' });

  try {
    await refreshCategory(db, slug);
    generateBlocklistConfig(db);
    const row = db.prepare('SELECT domain_count, last_fetched_at FROM blocklist_categories WHERE slug = ?').get(slug);
    res.json({ ok: true, domain_count: row?.domain_count, last_fetched_at: row?.last_fetched_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/blocklists/refresh: refresh all enabled categories
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
  const keys = ['blocklist_enabled', 'blocklist_redirect_ip', 'blocklist_update_schedule', 'blocklist_max_feed_mb'];
  const settings = {};
  for (const key of keys) {
    settings[key] = getSetting(key) || '';
  }
  res.json(settings);
});

// PUT /api/blocklists/settings
router.put('/settings', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const allowed = ['blocklist_enabled', 'blocklist_redirect_ip', 'blocklist_update_schedule', 'blocklist_max_feed_mb'];

  // Settings are stored as strings, so the toggle arrives as 'true'/'false'.
  // The enum checks also reject non-string types (arrays, objects, booleans).
  if (req.body.blocklist_enabled !== undefined && !['true', 'false'].includes(req.body.blocklist_enabled)) {
    return res.status(400).json({ error: "blocklist_enabled must be 'true' or 'false'" });
  }

  const validSchedules = Object.keys(SCHEDULE_HOURS);
  if (req.body.blocklist_update_schedule !== undefined && !validSchedules.includes(req.body.blocklist_update_schedule)) {
    return res.status(400).json({ error: `blocklist_update_schedule must be one of: ${validSchedules.join(', ')}` });
  }

  // redirect IP becomes the A-record for every blocked domain, so it must be
  // a real IPv4 (or empty = NXDOMAIN). An object persisted as "[object Object]"
  // and drove a garbage answer IP.
  if (req.body.blocklist_redirect_ip !== undefined
      && req.body.blocklist_redirect_ip !== ''
      && (typeof req.body.blocklist_redirect_ip !== 'string' || !isValidIpv4(req.body.blocklist_redirect_ip))) {
    return res.status(400).json({ error: 'blocklist_redirect_ip must be a valid IPv4 address or empty' });
  }

  // Per-feed download ceiling. Coercing variant because this surface is
  // string-typed end to end (the UI posts "128", not 128). The upper bound is
  // a sanity rail, not a capability claim: a feed that big would take minutes
  // to import and gigabytes of disk.
  if (req.body.blocklist_max_feed_mb !== undefined
      && !isIntInRangeCoercing(req.body.blocklist_max_feed_mb, 1, 2048)) {
    return res.status(400).json({ error: 'blocklist_max_feed_mb must be an integer 1-2048' });
  }

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      Setting.upsertSetting(db, key, req.body[key]);
    }
  }

  // Reload blocklist in proxy (proxy always runs, just loads/clears data)
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
  // Type guard before the string methods below: a non-string domain (number,
  // array, object) would throw on .trim()/.toLowerCase() and 500.
  if (typeof domain !== 'string' || !domain) return res.status(400).json({ error: 'Domain is required' });

  // Shape and the 253-char cap come from the shared validator. This route used
  // to inline its own regex with NO length bound at all, so a 300-character
  // name was accepted here and rejected everywhere else.
  //
  // The extra TLD requirement is deliberate and stays: this is a public-domain
  // allowlist, so a single-label name like "intranet" is not meaningful here
  // even though isValidDomain accepts it. See REVIEW.md, duplicate-logic audit #21.
  const trimmed = domain.trim();
  if (!isValidDomain(trimmed)) {
    return res.status(400).json({ error: 'Invalid domain name' });
  }
  if (!/\.[a-zA-Z]{2,}$/.test(trimmed)) {
    return res.status(400).json({ error: 'Domain must include a top-level domain' });
  }

  const normalized = domain.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM blocklist_whitelist WHERE domain = ?').get(normalized);
  if (existing) return res.status(409).json({ error: 'Domain already whitelisted' });

  const id = BlocklistStore.addWhitelistEntry(db, normalized, reason);
  generateBlocklistConfig(db);

  audit(req.user.id, 'create', 'blocklist_whitelist', id, { domain: normalized });
  res.status(201).json({ id });
});

// DELETE /api/blocklists/whitelist/:id
router.delete('/whitelist/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM blocklist_whitelist WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Whitelist entry not found' });

  BlocklistStore.deleteWhitelistEntry(db, entry.id);
  generateBlocklistConfig(db);

  audit(req.user.id, 'delete', 'blocklist_whitelist', entry.id, { domain: entry.domain });
  res.json({ ok: true });
});

// GET /api/blocklists/search
router.get('/search', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const { q, page = 1, limit = 50 } = req.query;
  if (typeof q !== 'string' || q.length < 2) return res.json({ items: [], hasMore: false, page: 1, limit: 50 });

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * limitNum;
  const escaped = q.replace(/[\\%_]/g, '\\$&');
  const searchTerm = `%${escaped}%`;

  // No COUNT here, deliberately.
  //
  // `LIKE '%...%'` cannot use the primary key, so every query is a full scan of
  // blocklist_domains, which migration 053 sized at 2.65 million rows for the
  // malware category alone. The paged SELECT below survives that because the
  // table is WITHOUT ROWID keyed on (domain, category_slug): it streams in
  // domain order with no temp b-tree, so LIMIT lets it stop as soon as it has a
  // page. A COUNT can never stop early, so it scanned all 2.65M rows on every
  // search regardless of how quickly the page filled.
  //
  // Measured on a synthetic 2.65M-row table: COUNT 148ms + page 3ms for a
  // narrow match, and 110ms + 117ms for a search that matches nothing. Dropping
  // the COUNT removes a whole scan from every request.
  //
  // One extra row is fetched instead. Its presence is all the UI needs to
  // decide whether a Next button should be live, and it costs nothing: the scan
  // was already going to produce it or hit the end of the table.
  const rows = db.prepare(`
    SELECT bd.domain, GROUP_CONCAT(bc.slug, ', ') as categories
    FROM blocklist_domains bd
    JOIN blocklist_categories bc ON bd.category_slug = bc.slug
    WHERE bc.enabled = 1 AND bd.domain LIKE ? ESCAPE '\\'
    GROUP BY bd.domain
    ORDER BY bd.domain
    LIMIT ? OFFSET ?
  `).all(searchTerm, limitNum + 1, offset);

  const hasMore = rows.length > limitNum;
  const items = hasMore ? rows.slice(0, limitNum) : rows;

  const whitelisted = new Set(
    db.prepare('SELECT domain FROM blocklist_whitelist').all().map(r => r.domain)
  );

  for (const item of items) {
    item.whitelisted = whitelisted.has(item.domain);
  }

  // `hasMore` rather than a total. An exact count of matches across 2.65M rows
  // cannot be produced without a second full scan, and the UI only ever used it
  // to decide whether Next was clickable.
  res.json({ items, hasMore, page: pageNum, limit: limitNum });
});

export default router;
