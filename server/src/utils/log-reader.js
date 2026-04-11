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

  if (size < offset) offset = 0; // truncated — restart from beginning
  if (size === offset) return { lines: [], newOffset: offset };

  const bytesToRead = Math.min(size - offset, maxBytes);
  const buf = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
  return { lines, newOffset: offset + bytesToRead };
}
