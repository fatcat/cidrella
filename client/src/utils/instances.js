// The wording for instances: the controller, which owns the data, and the
// members, which hold a synced read-only copy of it. One place for the sync
// state words and tones, the header chip, and how far behind a member is, so
// the header and Settings > Instances say the same thing.

import { formatRelativeTime } from './dateFormat.js';
import { countOf, EMPTY_CELL } from './format.js';

// A member's sync state, from GET /api/features and GET /api/instances.
const SYNC_STATES = {
  starting: {
    value: 'Starting',
    tone: 'muted',
    words: 'Taking its first copy from the controller',
  },
  current: { value: 'Current', tone: 'ok', words: 'Current with the controller' },
  behind: { value: 'Behind', tone: 'warn', words: 'Behind the controller' },
  offline: { value: 'Offline', tone: 'err', words: 'Cannot reach the controller' },
  paused: {
    value: 'Paused',
    tone: 'warn',
    words: 'Sync is paused: this instance and the controller run different versions',
  },
};
const UNKNOWN_SYNC = { value: 'Unknown', tone: 'muted', words: 'Sync state unknown' };

/** `{ value, tone, words }` for a member's sync report; unknown when absent. */
export function syncState(sync) {
  return SYNC_STATES[sync?.state] || UNKNOWN_SYNC;
}

/** "Last sync 3m ago", or that there has been none. */
export function lastSyncText(sync) {
  const when = formatRelativeTime(sync?.last_sync_at);
  return when === EMPTY_CELL ? 'No sync yet' : `Last sync ${when}`;
}

/**
 * The header chip naming this instance's mode: `{ label, tone, state, title }`
 * (`state` is the short word for the dot), or
 * null on a controller with no members, where a single box shows nothing.
 */
export function instanceChip(instance) {
  if (!instance) return null;
  if (instance.mode === 'member') {
    const state = syncState(instance.sync);
    const label = instance.controller_name ? `Member of ${instance.controller_name}` : 'Member';
    const lines = [`${label}: ${state.words}`, lastSyncText(instance.sync)];
    if (instance.sync?.last_error) lines.push(instance.sync.last_error);
    return { label, tone: state.tone, state: state.value, title: lines.join('\n') };
  }
  if (!(instance.members > 0)) return null;
  return {
    label: 'Controller',
    tone: 'info',
    state: 'Controller',
    title: `Controller of ${countOf(instance.members, 'member')}`,
  };
}

/** How far an instance is behind the controller, in words. */
export function behindText(row) {
  if (row.is_controller) return EMPTY_CELL;
  if (row.behind === 0) return 'Current';
  if (row.behind > 0) return `${countOf(row.behind, 'change')} behind`;
  // No figure: a member that has not called yet, or the list a member holds.
  return row.last_contact_at ? 'Unknown' : 'Not heard from yet';
}
