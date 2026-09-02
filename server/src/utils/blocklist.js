import fs from 'fs';
import path from 'path';
import readline from 'node:readline';
import { getDb, getSetting } from '../db/init.js';
import { atomicWrite, restartDnsmasq } from './dnsmasq.js';
import { loadBlocklist, loadWhitelist } from './dns-proxy.js';
import { BLOCKLIST_CATEGORIES, getDefaultCategoryUrl } from './blocklist-categories.js';
import { DATA_DIR, BLOCKLIST_DOWNLOAD_TIMEOUT_MS, BLOCKLIST_INSERT_BATCH } from '../config/defaults.js';
import { openPinnedOutboundStream, TOO_LARGE_CODE } from './url-guard.js';
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
  // No CREATE TABLE here. This used to re-declare blocklist_categories and
  // blocklist_domains "in case the migration hasn't run yet", which meant two
  // sources of truth for the same DDL, and the copy here had already drifted:
  // it omitted source_url and both indexes. Migrations own the schema.
  const insert = db.prepare(
    'INSERT OR IGNORE INTO blocklist_categories (slug) VALUES (?)'
  );
  for (const cat of BLOCKLIST_CATEGORIES) {
    insert.run(cat.slug);
  }
}

/**
 * Normalize one line of a domain-per-line feed (Block List Project "No IP"
 * format). Returns the domain, or null for blanks, comments and anything that
 * fails validation.
 *
 * Exported because it is the whole parser now that feeds are streamed rather
 * than split out of one big string, and it was previously untestable.
 */
export function parseDomainLine(rawLine) {
  const line = rawLine.trim().toLowerCase();
  if (!line || line.startsWith('#')) return null;
  // Strip inline comments
  const domain = line.split('#')[0].trim();
  if (!domain || domain === 'localhost' || !isValidDomain(domain)) return null;
  return domain;
}

/**
 * Operator-configured ceiling on a single feed download, in bytes. Read fresh
 * on every refresh, so changing it in the UI takes effect on the next fetch
 * with nothing to reload.
 */
export function getMaxFeedBytes() {
  const mb = parseInt(getSetting('blocklist_max_feed_mb') || '128', 10);
  const safe = Number.isFinite(mb) && mb > 0 ? mb : 128;
  return safe * 1024 * 1024;
}

function describeMb(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * Only one refresh may be in flight per process. blocklist_stage is a single
 * shared table, so a manual refresh landing on top of a scheduled one would
 * mix two feeds together and sweep the wrong rows. Same shape as the
 * probeInProgress guard in dhcp-probe.js: reject rather than queue, so an HTTP
 * caller gets a clear answer instead of hanging behind a long download.
 */
let refreshInProgress = null;

/** Yield to the event loop so the DNS proxy can answer between write batches. */
function yieldToLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

// Quote the field's real label, verbatim. An operator who searches the UI for
// the phrase in this error has to find it: the label is "Max Feed Size (MB)"
// in Blocklists.vue. Keep the two in sync if either changes.
const RAISE_HINT = 'Raise "Max Feed Size (MB)" under Settings > Filtering > Categories, '
  + 'or point this category at a smaller source.';

function tooLargeMessage(cause, maxBytes) {
  const limit = describeMb(maxBytes);
  if (cause?.actualBytes) {
    // Say "compressed" when that is what we measured. We advertise gzip, so
    // Content-Length is the transfer size, and reporting a bare "16 MB" for a
    // feed the operator knows as 51 MB reads like a bug in us.
    const size = cause.compressed
      ? `${describeMb(cause.actualBytes)} compressed (larger once expanded)`
      : describeMb(cause.actualBytes);
    return `Feed is ${size}, over the ${limit} limit. ${RAISE_HINT}`;
  }
  const where = cause?.stage === 'decompressed' ? ' once decompressed' : '';
  return `Feed exceeded the ${limit} limit${where} before it finished downloading. ${RAISE_HINT}`;
}

/**
 * Fetch and refresh a single category's domain list.
 * Returns { count, changed, notModified }
 *
 * Feeds are streamed, not buffered. The malware category alone is ~51MB and
 * 2.65M entries, which used to mean a 50MB string plus two 2.65M-element
 * arrays in memory at once, and a single transaction issuing 2.65M inserts
 * that froze DNS for about four seconds.
 *
 * Shape now:
 *   1. conditional GET, so an unchanged feed costs a 304 and nothing else
 *   2. stream lines into blocklist_stage in batches, yielding between them.
 *      blocklist_domains is NOT touched yet, so a download that fails halfway
 *      leaves the live blocklist exactly as it was.
 *   3. apply: insert staged rows into blocklist_domains in chunks, THEN sweep
 *      what is no longer present. Inserts before deletes means a domain in
 *      both the old and new feed is never momentarily missing, so the resolver
 *      can briefly over-block but never under-block.
 */
export async function refreshCategory(db, slug) {
  if (refreshInProgress) {
    throw new Error(`Blocklist refresh already in progress (${refreshInProgress}), try again shortly`);
  }
  refreshInProgress = slug;
  try {
    return await runRefresh(db, slug);
  } finally {
    refreshInProgress = null;
  }
}

async function runRefresh(db, slug) {
  const row = db.prepare(
    'SELECT source_url, etag, last_modified, domain_count FROM blocklist_categories WHERE slug = ?'
  ).get(slug);
  const url = row?.source_url || getDefaultCategoryUrl(slug);
  const maxBytes = getMaxFeedBytes();

  const fail = (msg) => {
    db.prepare('UPDATE blocklist_categories SET last_error = ? WHERE slug = ?').run(msg, slug);
    throw new Error(msg);
  };

  const headers = { 'User-Agent': 'CIDRella-Blocklist/1.0' };
  // Validators are per Content-Encoding and we always request gzip, so the
  // stored pair always matches what we ask for. A mismatch would only cost us
  // a 200 instead of a 304.
  if (row?.etag) headers['If-None-Match'] = row.etag;
  if (row?.last_modified) headers['If-Modified-Since'] = row.last_modified;

  let res;
  try {
    res = await openPinnedOutboundStream(url, {
      timeout: BLOCKLIST_DOWNLOAD_TIMEOUT_MS,
      maxBytes,
      headers,
    });
  } catch (err) {
    fail(err.message);
  }

  if (res.status === 304) {
    db.prepare(
      "UPDATE blocklist_categories SET last_fetched_at = datetime('now'), last_error = NULL WHERE slug = ?"
    ).run(slug);
    return { count: row?.domain_count || 0, changed: false, notModified: true };
  }

  if (!res.ok) {
    if (res.cause?.code === TOO_LARGE_CODE) fail(tooLargeMessage(res.cause, maxBytes));
    fail(res.error || `HTTP ${res.status} ${res.statusText}`);
  }

  const stageInsert = db.prepare('INSERT OR IGNORE INTO blocklist_stage (domain) VALUES (?)');
  const clearStage = () => db.exec('DELETE FROM blocklist_stage');

  // Defensive: a crash mid-refresh could have left rows behind.
  clearStage();

  try {
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const rows = batch;
      batch = [];
      db.transaction(() => { for (const d of rows) stageInsert.run(d); })();
    };

    const rl = readline.createInterface({ input: res.stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const domain = parseDomainLine(line);
      if (!domain) continue;
      batch.push(domain);
      if (batch.length >= BLOCKLIST_INSERT_BATCH) {
        flush();
        await yieldToLoop();
      }
    }
    flush();
  } catch (err) {
    clearStage();
    if (err?.code === TOO_LARGE_CODE) fail(tooLargeMessage(err, maxBytes));
    fail(err.message);
  }

  // Count from the table, not from lines read: feeds repeat domains and the
  // staging insert dedupes them. The old code deduped via a Set for the same
  // reason.
  const staged = db.prepare('SELECT COUNT(*) AS c FROM blocklist_stage').get().c;

  // A feed that parsed to nothing is a broken feed, not an instruction to
  // unblock everything. Refuse it rather than sweeping the category empty.
  if (staged === 0) {
    clearStage();
    fail('Feed downloaded but contained no valid domains. Check the source URL format: '
      + 'this parser expects one bare domain per line, not hosts-file lines like "0.0.0.0 example.com".');
  }

  // Apply. Inserts first, in chunks, so there is never a window where a
  // still-listed domain is absent from the table.
  //
  // The whole write phase needs the same last_error treatment as the download
  // phase, statement preparation included. Without it a failure here (disk
  // full, SQLITE_BUSY, anything the driver throws) propagated uncaught: the
  // refresh was genuinely broken but the category still showed its previous
  // last_error, or none at all, so the UI and the status endpoint both claimed
  // everything was fine.
  try {
    const applyChunk = db.prepare(`
      INSERT OR IGNORE INTO blocklist_domains (domain, category_slug)
      SELECT domain, ? FROM blocklist_stage WHERE domain > ? ORDER BY domain LIMIT ?
    `);
    const nextCursor = db.prepare(
      'SELECT domain FROM blocklist_stage WHERE domain > ? ORDER BY domain LIMIT 1 OFFSET ?'
    ).pluck();

    let cursor = '';
    for (;;) {
      const boundary = nextCursor.get(cursor, BLOCKLIST_INSERT_BATCH - 1);
      applyChunk.run(slug, cursor, BLOCKLIST_INSERT_BATCH);
      if (!boundary) break;
      cursor = boundary;
      await yieldToLoop();
    }

    // Sweep. One statement, so it is atomic with respect to readers.
    db.prepare(
      'DELETE FROM blocklist_domains WHERE category_slug = ? AND domain NOT IN (SELECT domain FROM blocklist_stage)'
    ).run(slug);
  } catch (err) {
    // Leave staging alone rather than clearing it: the next refresh clears it
    // defensively anyway, and on a disk-full failure a DELETE is another write
    // that would just throw again and mask this message.
    fail(`Storing the feed failed after it downloaded: ${err.message}. `
      + 'The previously stored domains for this category are still in place.');
  }
  clearStage();

  db.prepare(`UPDATE blocklist_categories SET
    domain_count = ?,
    last_fetched_at = datetime('now'),
    last_error = NULL,
    etag = ?,
    last_modified = ?
    WHERE slug = ?`).run(
    staged,
    res.headers?.etag || null,
    res.headers?.['last-modified'] || null,
    slug
  );

  // We got a 200 rather than a 304, so the feed changed. The old test compared
  // domain counts, which reported "unchanged" whenever a feed swapped one
  // domain for another.
  return { count: staged, changed: true, notModified: false };
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
 * Reload blocklist, updates the proxy's in-memory Set and clears the old dnsmasq conf.
 * All blocking now happens in the DNS proxy, not via dnsmasq address= directives.
 */
export function generateBlocklistConfig(_db) {
  // Reload the proxy's in-memory blocklist + the global allowlist (the latter
  // is also consulted by the GeoIP path, so any whitelist change applies there).
  loadBlocklist();
  loadWhitelist();

  // Clean up legacy blocklist.conf, proxy handles blocking now
  try {
    const existing = fs.existsSync(BLOCKLIST_CONF) ? fs.readFileSync(BLOCKLIST_CONF, 'utf-8') : '';
    if (existing !== '') {
      atomicWrite(BLOCKLIST_CONF, '');
      restartDnsmasq();
    }
  } catch { /* ignore cleanup errors */ }
}

/**
 * The one place the blocklist refresh-schedule vocabulary lives. The settings
 * route validates against these keys and the scheduler maps them to hours,  * add new options here and both stay in sync (the client's scheduleOptions in
 * Blocklists.vue is a separate package and still needs a matching entry).
 * Ordered as presented in the UI. 0 hours = disabled.
 */
export const SCHEDULE_HOURS = {
  off: 0,
  '6h': 6,
  '12h': 12,
  daily: 24,
  weekly: 168,
};

function scheduleToHours(schedule) {
  return SCHEDULE_HOURS[schedule] ?? 0;
}

/**
 * Start the blocklist auto-update scheduler
 */
export function startBlocklistScheduler() {
  // Check every 15 minutes for categories that need refreshing
  const intervalId = setInterval(async () => {
    try {
      const db = getDb();

      const schedule = getSetting('blocklist_update_schedule') || 'daily';
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
