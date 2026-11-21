/**
 * A time as SQLite's datetime('now') writes it: 'YYYY-MM-DD HH:MM:SS', UTC.
 * Takes anything Date does (epoch milliseconds, an ISO string, a Date); null
 * for what is not a time.
 */
export function sqlTime(value) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 19).replace('T', ' ');
}
