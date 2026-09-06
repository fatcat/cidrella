/**
 * Shared log-tail reader utility.
 * Used by metrics-aggregator.js and passive-liveness.js to tail dnsmasq.log.
 */

import fs from 'fs';

const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Read new bytes appended to a log file since the given offset.
 * Handles file truncation (e.g. log rotation / manual clear).
 *
 * @param {string} filePath - Absolute path to the log file.
 * @param {number} offset   - Byte offset to read from (0 = start of file).
 * @param {number} [maxBytes] - Maximum bytes to read per call (default 10MB).
 * @returns {{ lines: string[], newOffset: number }}
 */
export function readLogTail(filePath, offset, maxBytes = DEFAULT_MAX_READ_BYTES) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { lines: [], newOffset: 0 };
  }

  if (size < offset) offset = 0; // truncated, restart from beginning
  if (size === offset) return { lines: [], newOffset: offset };

  // Best-effort read: if the file exists but we can't open/read it (EACCES
  // because dnsmasq recreated the log as nobody:root 0640, EBUSY during
  // rotation, transient I/O error), swallow and return no lines. Callers
  // are pollers on a fixed interval, throwing here escapes the timer
  // callback and becomes an uncaughtException, which crashes the service.
  const bytesToRead = Math.min(size - offset, maxBytes);
  const buf = Buffer.alloc(bytesToRead);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return { lines: [], newOffset: offset };
  }
  try {
    fs.readSync(fd, buf, 0, buf.length, offset);
  } catch {
    return { lines: [], newOffset: offset };
  } finally {
    try { fs.closeSync(fd); } catch { /* fd may be invalid */ }
  }

  // Advance only through the last complete line. dnsmasq normally writes a
  // line in one operation, but a poll or the 10 MB cap can still land between
  // writes. Advancing over that fragment permanently loses it and is especially
  // damaging to multi-line DHCP fingerprints.
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) return { lines: [], newOffset: offset };
  const lines = buf.subarray(0, lastNewline).toString('utf-8').split('\n').filter(l => l.trim());
  return { lines, newOffset: offset + lastNewline + 1 };
}
