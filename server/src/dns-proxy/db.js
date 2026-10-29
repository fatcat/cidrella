/**
 * The DNS proxy's own SQLite connection. It is read-only and never waits on
 * the web app's write lock (`timeout: 0`): better-sqlite3 waits
 * synchronously, so a connection that waited would stop the proxy answering
 * for as long as a write held the lock. A read that cannot run now keeps the
 * last value it read.
 *
 * Settings come in two speeds. `setting` reads the table every call, for the
 * loaders a change runs. `cachedSetting` keeps a value for 2 s, for what a
 * query reads (DNSSEC, recursion off), so a busy resolver does not read the
 * settings table per query.
 *
 * With no database open the proxy keeps answering: settings read as their
 * defaults and filtering lets everything through.
 */
import Database from 'better-sqlite3';
import { settingValue } from '../models/setting-value.js';

const SETTING_CACHE_MS = 2000;

let db = null;
let dbFile = null;
let settingStmt = null;
let defaults = {};
const cache = new Map();

/** Open `file` read-only, closing any connection already open. */
export function openProxyDb(file) {
  closeProxyDb();
  db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
  dbFile = file;
  return db;
}

/** The open connection, or null. */
export function proxyDb() {
  return db;
}

/** The file the open connection reads, or null. */
export function proxyDbFile() {
  return dbFile;
}

export function closeProxyDb() {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  dbFile = null;
  settingStmt = null;
  cache.clear();
}

/** The defaults a setting reads as when nothing is stored (the web app's DEFAULTS). */
export function setSettingDefaults(next) {
  defaults = { ...next };
  cache.clear();
}

function readSetting(key) {
  if (!db) return { value: settingValue(key, undefined, defaults), read: false };
  try {
    settingStmt ??= db.prepare('SELECT value FROM settings WHERE key = ?');
    return { value: settingValue(key, settingStmt.get(key)?.value, defaults), read: true };
  } catch {
    return { value: undefined, read: false };
  }
}

/** Forget the cached settings: the next read of each goes to the table. */
export function clearSettingCache() {
  cache.clear();
}

/** A setting as stored now. */
export function setting(key, now = Date.now()) {
  const { value, read } = readSetting(key);
  if (read) {
    cache.set(key, { at: now, value });
    return value;
  }
  if (cache.has(key)) return cache.get(key).value;
  return value === undefined ? settingValue(key, undefined, defaults) : value;
}

/** A setting as stored at most 2 s ago. */
export function cachedSetting(key, now = Date.now()) {
  const hit = cache.get(key);
  if (hit && now - hit.at < SETTING_CACHE_MS) return hit.value;
  return setting(key, now);
}
