import fs from 'fs';
import path from 'path';
import { getDb } from '../db/init.js';
import { atomicWrite, signalDnsmasq } from './dnsmasq.js';

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
const CONF_DIR = path.join(DATA_DIR, 'dnsmasq', 'conf.d');
const BLOCKLIST_CONF = path.join(CONF_DIR, 'blocklist.conf');

// Domain validation: must have a dot, only valid chars, not an IP
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isValidDomain(d) {
  return d.length > 0 && d.length <= 253 && DOMAIN_RE.test(d) && !IP_RE.test(d);
}

/**
 * Detect blocklist format from content sample
 */
function detectFormat(content) {
  const lines = content.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
    .slice(0, 30);

  let hostsCount = 0;
  let adblockCount = 0;

  for (const line of lines) {
    if (/^(0\.0\.0\.0|127\.0\.0\.1)\s+\S/.test(line)) hostsCount++;
    if (/^\|\|[a-z0-9].*\^/.test(line)) adblockCount++;
  }

  if (hostsCount > lines.length * 0.5) return 'hosts';
  if (adblockCount > lines.length * 0.3) return 'adblock';
  return 'domains';
}

/**
 * Parse blocklist content into array of domains
 */
export function parseBlocklist(content, format = 'auto') {
  if (format === 'auto') format = detectFormat(content);

  const domains = new Set();
  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    let domain = null;

    if (format === 'hosts') {
      // Format: 0.0.0.0 domain.com or 127.0.0.1 domain.com
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && (parts[0] === '0.0.0.0' || parts[0] === '127.0.0.1')) {
        domain = parts[1].toLowerCase();
      }
    } else if (format === 'adblock') {
      // Format: ||domain.com^
      const match = line.match(/^\|\|([a-z0-9][a-z0-9.-]+)\^/i);
      if (match) {
        domain = match[1].toLowerCase();
      }
    } else {
      // domains: one per line
      const stripped = line.split('#')[0].trim().toLowerCase();
      if (stripped) domain = stripped;
    }

    if (domain && isValidDomain(domain) && domain !== 'localhost') {
      domains.add(domain);
    }
  }

  return Array.from(domains);
}

/**
 * Fetch and refresh a single blocklist source
 * Returns true if entries changed
 */
export async function refreshSource(db, sourceId) {
  const source = db.prepare('SELECT * FROM blocklist_sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error('Source not found');

  let response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    response = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'IPAM-Blocklist/1.0' }
    });
    clearTimeout(timeout);
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Request timed out' : err.message;
    db.prepare("UPDATE blocklist_sources SET last_error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(msg, sourceId);
    throw new Error(msg);
  }

  if (!response.ok) {
    const msg = `HTTP ${response.status} ${response.statusText}`;
    db.prepare("UPDATE blocklist_sources SET last_error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(msg, sourceId);
    throw new Error(msg);
  }

  const content = await response.text();
  const domains = parseBlocklist(content, source.format);

  const oldCount = source.last_entry_count;

  // Replace entries in a transaction
  db.transaction(() => {
    db.prepare('DELETE FROM blocklist_entries WHERE source_id = ?').run(sourceId);
    const insert = db.prepare('INSERT OR IGNORE INTO blocklist_entries (domain, source_id) VALUES (?, ?)');
    for (const domain of domains) {
      insert.run(domain, sourceId);
    }
    db.prepare(`UPDATE blocklist_sources SET
      last_fetched_at = datetime('now'),
      last_entry_count = ?,
      last_error = NULL,
      updated_at = datetime('now')
      WHERE id = ?`).run(domains.length, sourceId);
  })();

  return domains.length !== oldCount;
}

/**
 * Refresh all enabled sources, regenerate config if any changed
 */
export async function refreshAllSources(db) {
  const sources = db.prepare('SELECT id FROM blocklist_sources WHERE enabled = 1').all();
  let anyChanged = false;

  for (const source of sources) {
    try {
      const changed = await refreshSource(db, source.id);
      if (changed) anyChanged = true;
    } catch (err) {
      console.error(`Blocklist refresh failed for source ${source.id}:`, err.message);
    }
  }

  if (anyChanged) {
    generateBlocklistConfig(db);
  }

  return anyChanged;
}

/**
 * Generate /data/dnsmasq/conf.d/blocklist.conf from all enabled entries minus whitelist
 */
export function generateBlocklistConfig(db) {
  const enabled = db.prepare("SELECT value FROM settings WHERE key = 'blocklist_enabled'").get();
  if (!enabled || enabled.value !== 'true') {
    // Blocklist disabled — write empty file
    const existing = fs.existsSync(BLOCKLIST_CONF) ? fs.readFileSync(BLOCKLIST_CONF, 'utf-8') : '';
    if (existing !== '') {
      atomicWrite(BLOCKLIST_CONF, '');
      signalDnsmasq();
    }
    return;
  }

  const redirectIp = db.prepare("SELECT value FROM settings WHERE key = 'blocklist_redirect_ip'").get();
  const targetIp = redirectIp?.value || '';

  // Get all unique blocked domains from enabled sources, minus whitelist
  const domains = db.prepare(`
    SELECT DISTINCT be.domain
    FROM blocklist_entries be
    JOIN blocklist_sources bs ON be.source_id = bs.id
    WHERE bs.enabled = 1
      AND be.domain NOT IN (SELECT domain FROM blocklist_whitelist)
    ORDER BY be.domain
  `).all();

  const lines = ['# Auto-generated blocklist — do not edit manually'];
  for (const row of domains) {
    if (targetIp) {
      lines.push(`address=/${row.domain}/${targetIp}`);
    } else {
      lines.push(`address=/${row.domain}/`);
    }
  }
  lines.push('');

  const newContent = lines.join('\n');
  const existing = fs.existsSync(BLOCKLIST_CONF) ? fs.readFileSync(BLOCKLIST_CONF, 'utf-8') : '';

  if (newContent !== existing) {
    atomicWrite(BLOCKLIST_CONF, newContent);
    signalDnsmasq();
    console.log(`Blocklist config updated: ${domains.length} domains blocked`);
  }
}

/**
 * Start the blocklist auto-update scheduler
 */
export function startBlocklistScheduler() {
  // Check every 15 minutes for sources that need refreshing
  setInterval(async () => {
    const db = getDb();
    const due = db.prepare(`
      SELECT id FROM blocklist_sources
      WHERE enabled = 1 AND auto_update = 1
        AND (last_fetched_at IS NULL
             OR datetime(last_fetched_at, '+' || update_interval_hours || ' hours') <= datetime('now'))
    `).all();

    if (due.length === 0) return;

    let anyChanged = false;
    for (const source of due) {
      try {
        const changed = await refreshSource(db, source.id);
        if (changed) anyChanged = true;
      } catch (err) {
        console.error(`Scheduled blocklist refresh failed for source ${source.id}:`, err.message);
      }
    }

    if (anyChanged) {
      generateBlocklistConfig(db);
    }
  }, 15 * 60 * 1000);

  // Initial refresh 10s after startup
  setTimeout(async () => {
    try {
      const db = getDb();
      await refreshAllSources(db);
    } catch (err) {
      console.error('Initial blocklist refresh failed:', err.message);
    }
  }, 10_000);
}
