/**
 * The audit row for a version change, written at the first boot of the new
 * version. An update from the UI has its own update_started row, but one run
 * from the shell (cidrella-update, cidrella-rollback, or update.sh rolling
 * itself back) changes nothing in the database CIDRella could see, so boot
 * compares the version it runs with the one it ran last time.
 *
 * How the change happened comes from the updater's event log (events.jsonl,
 * scripts/lib/log.sh), which bash appends to; nothing here needs sqlite in
 * bash. Docker has no event log: a new image is a change of unknown cause.
 */
import fs from 'fs';
import path from 'path';
import { readSetting, upsertSetting } from '../models/setting.js';
import { recordAudit } from './audit.js';

export const LAST_VERSION_KEY = 'last_running_version';
// The newest updater run already accounted for, by its start time.
const LAST_RUN_KEY = 'last_updater_run_at';
const EVENT_LOG = 'events.jsonl';
const TAIL_BYTES = 64 * 1024;
// An updater run older than this did not cause this boot.
const RECENT_MS = 6 * 60 * 60 * 1000;

function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The newest updater run in the event log text: { how: 'update' | 'rollback',
 * from, to, at } or null. Walks back from the end to the newest `update start`
 * or `rollback start`; an update's versions come from the events after its
 * start (preflight's from_version, the release's version).
 */
export function lastUpdaterRun(text, { now = Date.now() } = {}) {
  const lines = text.split('\n').filter(Boolean).reverse();
  let from = null;
  let to = null;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // the first line of a tail is usually cut
    }
    const data = event.data || {};
    if (event.phase === 'preflight' && data.from_version) from = from ?? data.from_version;
    if (event.phase === 'verify' && data.release_json_version) to = to ?? data.release_json_version;
    if (event.phase === 'download' && data.tag) to = to ?? String(data.tag).replace(/^v/, '');
    const start =
      event.event === 'start' && (event.phase === 'update' || event.phase === 'rollback');
    if (!start) continue;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at) || now - at > RECENT_MS) return null;
    if (event.phase === 'rollback') {
      return { how: 'rollback', from: data.from || null, to: data.to || null, at: event.ts };
    }
    return { how: 'update', from, to, at: event.ts };
  }
  return null;
}

/**
 * Write the row when the running version differs from the last one, or when
 * an updater run this boot has not seen rolled back to it, then remember both.
 * The second case is update.sh rolling itself back: it restores the database
 * from before the update, which still names the old version as the last one.
 * Returns the row's details, or null when nothing was written.
 */
export function recordVersionChange(db, { version, dataDir }) {
  const last = readSetting(db, LAST_VERSION_KEY);
  let run = lastUpdaterRun(tail(path.join(dataDir, EVENT_LOG)));
  if (run && readSetting(db, LAST_RUN_KEY) === run.at) run = null;
  if (last !== version) upsertSetting(db, LAST_VERSION_KEY, version);
  if (run) upsertSetting(db, LAST_RUN_KEY, run.at);

  // Only a run that ended on this version explains it (an older one, say for
  // a pre-release, does not).
  if (run && run.to !== version) run = null;
  const rolledBackHere = run?.how === 'rollback' && run.to === version;
  // The first boot of the release that started keeping the version has no
  // last one; only an updater run says what it came from.
  const changed = last !== version && (last || run);
  if (!changed && !rolledBackHere) return null;

  // An update the UI started has its own row, naming who.
  const started = db
    .prepare(
      `SELECT actor, user_id, details FROM audit_log
       WHERE action = 'update_started' ORDER BY id DESC LIMIT 1`,
    )
    .get();
  let fromUi = null;
  try {
    const details = started ? JSON.parse(started.details || '{}') : {};
    if (started && details.to_version === version && run?.how !== 'rollback') fromUi = started;
  } catch {
    // An unreadable row says nothing about this update.
  }

  const details = {
    from: run?.how === 'rollback' ? run.from || last || null : last || run?.from || null,
    to: version,
    how: run ? run.how : 'unknown',
  };
  // A run that started and ended on this version moved nothing.
  if (details.from === version) return null;
  recordAudit({
    action: 'version_changed',
    entityType: 'system',
    db,
    ...(fromUi
      ? { actor: fromUi.actor, userId: fromUi.user_id, origin: 'ui' }
      : { source: run?.how || 'boot', origin: run ? 'cli' : 'system' }),
    details,
  });
  return details;
}
