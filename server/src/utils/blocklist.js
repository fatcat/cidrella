import fs from 'fs';
import path from 'path';
import { getDb } from '../db/init.js';
import { atomicWrite, signalDnsmasq } from './dnsmasq.js';
import { loadBlocklist } from './dns-proxy.js';
import { BLOCKLIST_CATEGORIES, getDefaultCategoryUrl } from './blocklist-categories.js';
import { DATA_DIR, BLOCKLIST_DOWNLOAD_TIMEOUT_MS } from '../config/defaults.js';
const CONF_DIR = path.join(DATA_DIR, 'dnsmasq', 'conf.d');
const BLOCKLIST_CONF = path.join(CONF_DIR, 'blocklist.conf');

// Domain validation
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isValidDomain(d) {
  return d.length > 0 && d.length <= 253 && DOMAIN_RE.test(d) && !IP_RE.test(d);
}

/**
 * Ensure all catalog categories exist in the database
 */
export function ensureCategoryRows(db) {
  // Create table if migration hasn't run yet
  db.exec(`CREATE TABLE IF NOT EXISTS blocklist_categories (
    slug TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    domain_count INTEGER NOT NULL DEFAULT 0,
    last_fetched_at TEXT,
    last_error TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS blocklist_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    category_slug TEXT NOT NULL REFERENCES blocklist_categories(slug) ON DELETE CASCADE,
    UNIQUE(domain, category_slug)
  )`);

  const insert = db.prepare(
    'INSERT OR IGNORE INTO blocklist_categories (slug) VALUES (?)'
  );
  for (const cat of BLOCKLIST_CATEGORIES) {
    insert.run(cat.slug);
  }
}

/**
 * Parse domain-per-line content (Block List Project "No IP" format)
 */
function parseDomainList(content) {
  const domains = new Set();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    // Strip inline comments
    const domain = line.split('#')[0].trim();
    if (domain && isValidDomain(domain) && domain !== 'localhost') {
      domains.add(domain);
    }
  }
  return Array.from(domains);
}

/**
 * Fetch and refresh a single category's domain list.
 * Returns { count, changed }
 */
export async function refreshCategory(db, slug) {
  // Use custom URL from DB if set, otherwise fall back to default
  const row = db.prepare('SELECT source_url FROM blocklist_categories WHERE slug = ?').get(slug);
  const url = row?.source_url || getDefaultCategoryUrl(slug);

  let response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BLOCKLIST_DOWNLOAD_TIMEOUT_MS);
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CIDRella-Blocklist/1.0' }
    });
    clearTimeout(timeout);
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Request timed out' : err.message;
    db.prepare("UPDATE blocklist_categories SET last_error = ? WHERE slug = ?")
      .run(msg, slug);
    throw new Error(msg);
  }

  if (!response.ok) {
    const msg = `HTTP ${response.status} ${response.statusText}`;
    db.prepare("UPDATE blocklist_categories SET last_error = ? WHERE slug = ?")
      .run(msg, slug);
    throw new Error(msg);
  }

  const content = await response.text();
  const domains = parseDomainList(content);
  const oldCount = db.prepare('SELECT domain_count FROM blocklist_categories WHERE slug = ?').get(slug)?.domain_count || 0;

  db.transaction(() => {
    db.prepare('DELETE FROM blocklist_domains WHERE category_slug = ?').run(slug);
    const insert = db.prepare('INSERT OR IGNORE INTO blocklist_domains (domain, category_slug) VALUES (?, ?)');
    for (const domain of domains) {
      insert.run(domain, slug);
    }
    db.prepare(`UPDATE blocklist_categories SET
      domain_count = ?,
      last_fetched_at = datetime('now'),
      last_error = NULL
      WHERE slug = ?`).run(domains.length, slug);
  })();

  return { count: domains.length, changed: domains.length !== oldCount };
}

/**
 * Refresh all enabled categories, regenerate config once at end
 */
export async function refreshAllEnabled(db) {
  const enabled = db.prepare('SELECT slug FROM blocklist_categories WHERE enabled = 1').all();
  let anyChanged = false;

  for (const row of enabled) {
    try {
      const result = await refreshCategory(db, row.slug);
      if (result.changed) anyChanged = true;
    } catch (err) {
      console.error(`Blocklist refresh failed for ${row.slug}:`, err.message);
    }
  }

  generateBlocklistConfig(db);
  return anyChanged;
}

/**
 * Reload blocklist — updates the proxy's in-memory Set and clears the old dnsmasq conf.
 * All blocking now happens in the DNS proxy, not via dnsmasq address= directives.
 */
export function generateBlocklistConfig(db) {
  // Reload the proxy's in-memory blocklist
  loadBlocklist();

  // Clean up legacy blocklist.conf — proxy handles blocking now
  try {
    const existing = fs.existsSync(BLOCKLIST_CONF) ? fs.readFileSync(BLOCKLIST_CONF, 'utf-8') : '';
    if (existing !== '') {
      atomicWrite(BLOCKLIST_CONF, '');
      signalDnsmasq();
    }
  } catch { /* ignore cleanup errors */ }
}

/**
 * Map schedule setting to interval in hours
 */
function scheduleToHours(schedule) {
  switch (schedule) {
    case '6h': return 6;
    case '12h': return 12;
    case 'daily': return 24;
    case 'weekly': return 168;
    default: return 0; // 'off'
  }
}

/**
 * Start the blocklist auto-update scheduler
 */
export function startBlocklistScheduler() {
  // Check every 15 minutes for categories that need refreshing
  const intervalId = setInterval(async () => {
    try {
      const db = getDb();

      const schedSetting = db.prepare("SELECT value FROM settings WHERE key = 'blocklist_update_schedule'").get();
      const schedule = schedSetting?.value || 'daily';
      if (schedule === 'off') return;

      const intervalHours = scheduleToHours(schedule);
      if (intervalHours === 0) return;

      const due = db.prepare(`
        SELECT slug FROM blocklist_categories
        WHERE enabled = 1
          AND (last_fetched_at IS NULL
               OR datetime(last_fetched_at, '+' || ? || ' hours') <= datetime('now'))
      `).all(intervalHours);

      if (due.length === 0) return;

      let anyChanged = false;
      for (const row of due) {
        try {
          const result = await refreshCategory(db, row.slug);
          if (result.changed) anyChanged = true;
        } catch (err) {
          console.error(`Scheduled blocklist refresh failed for ${row.slug}:`, err.message);
        }
      }

      if (anyChanged) {
        generateBlocklistConfig(db);
      }
    } catch (err) {
      console.error('Blocklist scheduler error:', err.message);
    }
  }, 15 * 60 * 1000);

  // Initial: ensure category rows + refresh enabled categories 10s after startup
  const timeoutId = setTimeout(async () => {
    try {
      const db = getDb();
      ensureCategoryRows(db);
      await refreshAllEnabled(db);
    } catch (err) {
      console.error('Initial blocklist refresh failed:', err.message);
    }
  }, 10_000);

  return { intervalId, timeoutId };
}
