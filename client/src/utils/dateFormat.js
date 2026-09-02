import { useAuthStore } from '../stores/auth.js';
import { isIntradayRange } from './ranges.js';

function hourOption() {
  const fmt = useAuthStore().timeFormat;
  if (fmt === 'ampm') return { hour12: true };
  if (fmt === '24h') return { hour12: false };
  return {}; // locale default
}

/** True if the string already carries a timezone indicator (Z or ±HH:MM) */
const hasTZ = (s) => /Z|[+-]\d{2}:\d{2}$/.test(String(s));

/**
 * Elapsed time since an ISO timestamp, as "just now" / "5m ago" / "3h ago" / "2d ago".
 *
 * There were three copies of this: HeaderBar.vue, Anomalies.vue and (as
 * formatRelative) UpdatePanel.vue. Only HeaderBar's carried the finite guard, so
 * the other two rendered the literal string "NaNd ago" for a timestamp that does
 * not parse. That is reachable: Anomalies feeds this from daemon fields written
 * by the Python anomaly sidecar. The three also disagreed on the missing-value
 * placeholder, UpdatePanel returning an empty string where the others returned
 * the em-dash every other cell in the app uses.
 *
 * The em-dash here is the documented EMPTY_CELL placeholder, not prose.
 * See REVIEW.md, duplicate-logic audit #42.
 */
export function formatRelativeTime(dateStr) {
  if (!dateStr) return '—';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Full date + time (replaces most formatDate functions) */
export function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr + (hasTZ(dateStr) ? '' : 'Z'));
    if (isNaN(d)) return '—';
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...hourOption() });
  } catch { return String(dateStr); }
}

/** Date only */
export function formatDateOnly(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr + (hasTZ(dateStr) ? '' : 'Z'));
    if (isNaN(d)) return '—';
    return d.toLocaleDateString();
  } catch { return String(dateStr); }
}

/** Time only (HH:MM) */
export function formatTimeOnly(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr + (hasTZ(dateStr) ? '' : 'Z'));
    if (isNaN(d)) return '—';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...hourOption() });
  } catch { return String(dateStr); }
}

/** Time with seconds (HH:MM:SS), for debug panel */
export function formatTimeWithSeconds(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', ...hourOption() });
}

/** Short date + time for scan display (e.g. "Mar 5 - 14:30") */
export function formatScanDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + (hasTZ(dateStr) ? '' : 'Z'));
  if (isNaN(d)) return null;
  const mon = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...hourOption() });
  return `${mon} ${day} - ${time}`;
}

/** Epoch-based formatting for chart axes */
export function formatEpoch(epoch, range) {
  const d = new Date(epoch * 1000);
  const opts = hourOption();
  if (isIntradayRange(range)) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...opts });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...opts });
}
