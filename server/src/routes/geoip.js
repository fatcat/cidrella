import { Router } from 'express';
import { getDb, getSetting, setSetting } from '../db/init.js';
import { recordAudit, settingsSnapshot } from '../services/audit.js';
import { requirePerm } from '../auth/require-perm.js';
import {
  getProxyStatus,
  loadMmdb,
  unloadMmdb,
  isGeoipLoaded,
  loadGeoipRules,
  loadGeoipAllowlist,
  downloadMmdb,
  resetStats,
} from '../utils/dns-proxy.js';
import * as GeoipRule from '../models/geoip-rule.js';
import * as GeoipAllowlist from '../models/geoip-ip-allowlist.js';
import { canonicalizeIpOrCidr } from '../utils/cidr-match.js';
import { GEOIP_MODES } from '../utils/validation.js';

const router = Router();

// GET /api/geoip/status
router.get('/status', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const status = getProxyStatus();
  const mode = getSetting('geoip_mode');
  const enabled = getSetting('geoip_enabled');
  const updateSchedule = getSetting('geoip_update_schedule');
  const ruleCount = db.prepare('SELECT COUNT(*) as c FROM geoip_rules WHERE enabled = 1').get().c;

  res.json({
    ...status,
    enabled: enabled === 'true',
    mode: mode || 'blocklist',
    updateSchedule: updateSchedule || 'monthly',
    ruleCount,
  });
});

// GET /api/geoip/rules
router.get('/rules', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const rules = db.prepare('SELECT * FROM geoip_rules ORDER BY country_name').all();
  res.json(rules);
});

// POST /api/geoip/rules: add one or more country rules
router.post('/rules', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const { countries } = req.body;

  if (!countries || !Array.isArray(countries) || countries.length === 0) {
    return res.status(400).json({ error: 'countries array is required' });
  }

  const CC_RE = /^[A-Z]{2}$/;

  // Validate all country codes before inserting. Guard the element type too:
  // a non-object entry (null, string, number) would throw on `.code` and turn
  // into a 500 instead of a clean 400.
  const invalid = countries.filter(
    (c) => !c || typeof c !== 'object' || !c.code || !CC_RE.test(c.code),
  );
  if (invalid.length > 0) {
    // c may be null/non-object here, so read `code` defensively for the message too.
    return res.status(400).json({
      error: `Invalid country codes: ${invalid.map((c) => (c && c.code) || '(empty)').join(', ')}`,
    });
  }

  // Check for duplicates
  const existing = countries.filter((c) => {
    return db.prepare('SELECT id FROM geoip_rules WHERE country_code = ?').get(c.code);
  });
  if (existing.length > 0 && existing.length === countries.length) {
    return res.status(409).json({
      error: `All specified country rules already exist: ${existing.map((c) => c.code).join(', ')}`,
    });
  }

  const added = GeoipRule.addRules(db, countries);

  if (added.length > 0) {
    loadGeoipRules();
    recordAudit({
      action: 'geoip_rules_created',
      entityType: 'geoip_rules',
      details: { countries: added },
    });
  }

  res.status(201).json({ added });
});

// PUT /api/geoip/rules/:id: toggle enabled
router.put('/rules/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const rule = db.prepare('SELECT * FROM geoip_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  const { enabled } = req.body;
  if (enabled === undefined) return res.status(400).json({ error: 'enabled field is required' });

  GeoipRule.setEnabled(db, rule.id, enabled);
  loadGeoipRules();
  recordAudit({
    action: 'geoip_rule_updated',
    entityType: 'geoip_rule',
    entityId: rule.id,
    before: { enabled: Boolean(rule.enabled) },
    after: { enabled: Boolean(enabled) },
    details: { country_code: rule.country_code },
  });
  res.json({ ok: true });
});

// DELETE /api/geoip/rules/:id
router.delete('/rules/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const rule = db.prepare('SELECT * FROM geoip_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  GeoipRule.deleteRule(db, rule.id);
  loadGeoipRules();
  recordAudit({
    action: 'geoip_rule_deleted',
    entityType: 'geoip_rule',
    entityId: rule.id,
    details: { country_code: rule.country_code },
  });
  res.json({ ok: true });
});

// ─── GeoIP IP/CIDR allowlist (IPs/ranges never GeoIP-blocked) ───────────────
// GET /api/geoip/allowlist
router.get('/allowlist', requirePerm('dns:read'), (req, res) => {
  res.json(GeoipAllowlist.listEntries(getDb()));
});

// POST /api/geoip/allowlist
router.post('/allowlist', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const { value, reason } = req.body || {};
  if (typeof value !== 'string' || !value.trim()) {
    return res.status(400).json({ error: 'An IP address or CIDR is required' });
  }
  // Store the canonical CIDR form (host bits masked, explicit prefix, IPv6
  // compressed) so dedup means "same network", not "same spelling".
  const v = canonicalizeIpOrCidr(value.trim());
  if (!v) {
    return res.status(400).json({ error: 'Invalid IP address or CIDR (IPv4 or IPv6)' });
  }
  if (reason != null && (typeof reason !== 'string' || reason.length > 200)) {
    return res.status(400).json({ error: 'reason must be a string up to 200 chars' });
  }
  if (GeoipAllowlist.getByValue(db, v)) {
    return res.status(409).json({ error: 'Already in the allowlist' });
  }
  const id = GeoipAllowlist.addEntry(db, v, reason);
  loadGeoipAllowlist();
  recordAudit({
    action: 'geoip_ip_allowlist_created',
    entityType: 'geoip_ip_allowlist',
    entityId: id,
    details: { value: v },
  });
  res.status(201).json({ id, value: v });
});

// DELETE /api/geoip/allowlist/:id
router.delete('/allowlist/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM geoip_ip_allowlist WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Allowlist entry not found' });
  GeoipAllowlist.deleteEntry(db, entry.id);
  loadGeoipAllowlist();
  recordAudit({
    action: 'geoip_ip_allowlist_deleted',
    entityType: 'geoip_ip_allowlist',
    entityId: entry.id,
    details: { value: entry.value },
  });
  res.json({ ok: true });
});

// PUT /api/geoip/settings: update GeoIP settings
router.put('/settings', requirePerm('dns:write'), async (req, res) => {
  const { geoip_enabled, geoip_mode, geoip_update_schedule } = req.body;

  if (geoip_enabled !== undefined && typeof geoip_enabled !== 'boolean') {
    return res.status(400).json({ error: 'geoip_enabled must be a boolean' });
  }

  if (geoip_mode !== undefined && !GEOIP_MODES.has(geoip_mode)) {
    return res.status(400).json({ error: 'Mode must be blocklist or allowlist' });
  }

  if (
    geoip_update_schedule !== undefined &&
    !['off', 'weekly', 'biweekly', 'monthly'].includes(geoip_update_schedule)
  ) {
    return res
      .status(400)
      .json({ error: 'Update schedule must be off, weekly, biweekly, or monthly' });
  }

  const GEOIP_KEYS = ['geoip_enabled', 'geoip_mode', 'geoip_update_schedule'];
  const before = settingsSnapshot(GEOIP_KEYS);
  const wasEnabled = getSetting('geoip_enabled') === 'true';

  // Update settings
  if (geoip_mode !== undefined) {
    setSetting('geoip_mode', geoip_mode);
  }
  if (geoip_update_schedule !== undefined) {
    setSetting('geoip_update_schedule', geoip_update_schedule);
  }

  const nowEnabled = geoip_enabled !== undefined ? geoip_enabled : wasEnabled;
  if (geoip_enabled !== undefined) {
    setSetting('geoip_enabled', nowEnabled ? 'true' : 'false');
  }

  // The proxy always runs. The loaded reader is what blocks, so it follows the
  // setting both ways: loaded while on, dropped the moment GeoIP goes off.
  try {
    loadGeoipRules();
    loadGeoipAllowlist();
    if (!nowEnabled) unloadMmdb();
    else if (!isGeoipLoaded()) await loadMmdb();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load GeoIP database: ' + err.message });
  }

  recordAudit({
    action: 'geoip_settings_updated',
    entityType: 'geoip_settings',
    before,
    after: settingsSnapshot(GEOIP_KEYS),
  });

  res.json({ ok: true });
});

// POST /api/geoip/db/refresh: manual MMDB download
router.post('/db/refresh', requirePerm('dns:write'), async (req, res) => {
  try {
    await downloadMmdb();
    const status = getProxyStatus();
    recordAudit({
      action: 'geoip_db_refreshed',
      entityType: 'geoip_db',
      details: { db_updated_at: status.dbLastUpdated ?? null },
    });
    res.json({ ok: true, dbLastUpdated: status.dbLastUpdated, dbLoaded: status.dbLoaded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/geoip/stats
router.get('/stats', requirePerm('dns:read'), (req, res) => {
  const status = getProxyStatus();
  res.json({
    total: status.statsTotal,
    blocked: status.statsBlocked,
    allowed: status.statsAllowed,
  });
});

// POST /api/geoip/stats/reset
router.post('/stats/reset', requirePerm('dns:write'), (req, res) => {
  resetStats();
  recordAudit({ action: 'geoip_stats_reset', entityType: 'geoip_settings' });
  res.json({ ok: true });
});

// Note: the domain allowlist is a single global allowlist shared with category
// blocking, managed via /api/blocklists/allowlist (one list, applies to both).

export default router;
