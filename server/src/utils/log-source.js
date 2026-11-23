/**
 * The DNS and DHCP daemon logs a viewer shows: which file a role's log is,
 * which of its lines are the role's, its tail and what was written since. Read
 * by the browser's viewer on this box (routes/logs.js) and by this box's
 * controller asking for a member's log (GET /api/sync/logs, routes/sync.js).
 */
import fs from 'fs';
import path from 'path';
import { getService } from '../backends/index.js';
import { readLogTail } from './log-reader.js';

export const LOG_ROLES = ['dns', 'dhcp'];
// The purpose a controller's call proof names to read a member's log
// (sync/identity-proof.js, GET /api/sync/logs).
export const LOG_PURPOSE = 'logs';

// The tail a viewer opens on. dnsmasq.log on a long-running install without
// rotation can be 1+ GB: reading it whole once cost ~3 GB of heap and an OOM
// kill every time the Logs page opened. 64 KB holds ~200 lines of dnsmasq
// output (~150-200 bytes a line) with headroom.
const BACKLOG_BYTES = 64 * 1024;
const BACKLOG_LINES = 200;

/**
 * The log to show for `role` (dns or dhcp), asked of the backend filling it
 * now, so a stack switch moves the viewer with it. `shared` when one log
 * serves both roles (dnsmasq): the role's lines are picked out of it. null
 * when the backend keeps no log.
 */
export function logFor(role) {
  const service = getService(role);
  const source = service.logSource();
  const file = source?.path ?? null;
  if (!file) return null;
  const shared = getService('dns') === getService('dhcp');
  return { source, file, label: service.label || service.name, shared };
}

export function noLog(role) {
  const service = getService(role);
  return {
    error: `${service.label || service.name} keeps no ${role.toUpperCase()} log to show`,
  };
}

/**
 * One entry per role: the backend filling it, whether it keeps a log to show
 * (and why not), and whether the log may be cleared here. A viewer builds its
 * tabs from these.
 */
export function logSources({ clearable = true } = {}) {
  return LOG_ROLES.map((role) => {
    const service = getService(role);
    const log = logFor(role);
    return {
      role,
      label: service.label || service.name,
      available: Boolean(log),
      clearable: clearable && Boolean(log) && log.source.clearable !== false,
      message: log ? null : noLog(role).error,
    };
  });
}

/** Whether `line` belongs in a view that shows `filter` ('all', 'dns' or 'dhcp'). */
export function matchesFilter(source, line, filter) {
  if (filter === 'all') return true;
  const isDhcp = source.isDhcpLine(line);
  if (filter === 'dhcp') return isDhcp;
  if (filter === 'dns') return !isDhcp;
  return true;
}

/** The filter that shows `role`'s lines of `log`: all of them unless the log is shared. */
export const roleFilter = (log, role) => (log.shared ? role : 'all');

/** Make the log file if missing, without truncating one the daemon started meanwhile. */
export function ensureLogFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', { flag: 'a' });
}

/**
 * The last BACKLOG_LINES lines of `file` that pass `filter`, read from its
 * last BACKLOG_BYTES only, and `offset`, its end, to read on from.
 */
export function readBacklog(log, filter) {
  const { file, source } = log;
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], offset: 0 };
  }
  const tailBytes = Math.min(BACKLOG_BYTES, size);
  const tailStart = size - tailBytes;
  const buf = Buffer.alloc(tailBytes);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, tailBytes, tailStart);
  } catch {
    return { lines: [], offset: size };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const text = buf.toString('utf-8');
  // A read that did not start at the file's start began mid-line: drop that part.
  const firstNewline = text.indexOf('\n');
  const usable = tailStart > 0 && firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  const lines = usable
    .split('\n')
    .filter((l) => l.trim())
    .slice(-BACKLOG_LINES)
    .filter((line) => matchesFilter(source, line, filter));
  return { lines, offset: size };
}

/**
 * The complete lines written to the log since `offset` that pass `filter`, at
 * most `maxBytes` of them, and the offset to read on from. A log cut shorter
 * than `offset` (cleared, rotated) is read from its start.
 */
export function readSince(log, offset, filter, maxBytes) {
  const tail = readLogTail(log.file, offset, maxBytes);
  return {
    lines: tail.lines.filter((line) => matchesFilter(log.source, line, filter)),
    offset: tail.newOffset,
  };
}
