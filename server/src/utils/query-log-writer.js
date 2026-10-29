/**
 * Appends the DNS proxy's query lines (utils/query-log-line.js) to one file,
 * the DNS backend's log. Which file, or none, is the caller's: the web app
 * works it out from the backend (utils/query-log.js) and the proxy process is
 * told it. This module imports nothing of CIDRella's but the line format, so
 * the proxy process can carry it.
 *
 * The file is opened for append, so the daemons writing into the same file
 * and a truncation (Clear, logrotate's copytruncate) leave whole lines. It is
 * checked every few seconds and reopened when it was replaced or removed.
 * A write never throws into the proxy: an error is logged once and the
 * writer stays quiet until the next check.
 */
import fs from 'fs';
import path from 'path';
import { formatQueryLine } from './query-log-line.js';

const RECHECK_MS = 10_000;
// Past this much unwritten, lines are dropped rather than held in memory.
const MAX_PENDING_BYTES = 1024 * 1024;

let target = null; // the log path, or null when the backend logs its own queries
let stream = null;
let inode = null;
let lastCheck = 0;
let failed = false;

function close() {
  if (stream) stream.end();
  stream = null;
  inode = null;
}

function open() {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Opened here, not by the stream, so the file exists before it is checked.
    const fd = fs.openSync(target, 'a', 0o640);
    inode = fs.fstatSync(fd).ino;
    const opened = fs.createWriteStream(target, { fd });
    opened.on('error', (err) => {
      if (stream !== opened) return; // an error from a stream already replaced
      if (!failed) console.warn('[query-log] cannot write', { path: target, error: err.message });
      failed = true;
      stream = null;
      inode = null;
    });
    stream = opened;
    failed = false;
  } catch (err) {
    if (!failed) console.warn('[query-log] cannot open', { path: target, error: err.message });
    failed = true;
    stream = null;
  }
}

/** The file to write the query lines to, or null for none. */
export function setQueryLogPath(file) {
  if (file === target) return;
  close();
  target = file || null;
  lastCheck = 0;
}

// Reopen when the file was removed or replaced since it was opened.
function check(now) {
  lastCheck = now;
  let current = null;
  try {
    current = fs.statSync(target).ino;
  } catch {
    /* removed */
  }
  if (!stream || current !== inode) {
    close();
    open();
  }
}

/** Append one query, given the fields the proxy hands to logDnsQuery. */
export function writeQueryLine(entry, now = Date.now()) {
  if (!target) return;
  if (now - lastCheck >= RECHECK_MS) check(now);
  if (!stream || stream.writableLength > MAX_PENDING_BYTES) return;
  stream.write(formatQueryLine(entry, new Date(now)));
}

/** Tests: close the file and forget it. */
export function resetQueryLogWriter() {
  close();
  target = null;
  failed = false;
  lastCheck = 0;
}
