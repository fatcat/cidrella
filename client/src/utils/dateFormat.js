import { useAuthStore } from '../stores/auth.js';

function hourOption() {
  const fmt = useAuthStore().timeFormat;
  if (fmt === 'ampm') return { hour12: true };
  if (fmt === '24h') return { hour12: false };
  return {}; // locale default
}

/** Full date + time (replaces most formatDate functions) */
export function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr + (String(dateStr).includes('Z') ? '' : 'Z'));
    if (isNaN(d)) return '—';
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...hourOption() });
  } catch { return String(dateStr); }
}

/** Date only */
export function formatDateOnly(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr + (String(dateStr).includes('Z') ? '' : 'Z'));
    if (isNaN(d)) return '—';
    return d.toLocaleDateString();
  } catch { return String(dateStr); }
}

/** Time only (HH:MM) */
export function formatTimeOnly(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr + (String(dateStr).includes('Z') ? '' : 'Z'));
    if (isNaN(d)) return '—';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...hourOption() });
  } catch { return String(dateStr); }
}

/** Time with seconds (HH:MM:SS) — for debug panel */
export function formatTimeWithSeconds(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', ...hourOption() });
}

/** Short date + time for scan display (e.g. "Mar 5 - 14:30") */
export function formatScanDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + (String(dateStr).endsWith('Z') ? '' : 'Z'));
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
  if (range === '1h' || range === '4h' || range === '12h' || range === '24h') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...opts });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...opts });
}
