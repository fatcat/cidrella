// The wording for instances: the controller, which owns the data, and the
// members, which hold a synced read-only copy of it. One place for the sync
// state words and tones, the header chip, and how far behind a member is, so
// the header and Settings > Instances say the same thing. Also which instance
// serves DHCP: exactly one does, and an admin can move it.

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

// A member that DHCP was moved to says so in the header chip's title.
const SERVES_DHCP_HERE = 'This instance serves DHCP';

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
    if (instance.serves_dhcp) lines.push(SERVES_DHCP_HERE);
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

// The DHCP state of a row of GET /api/instances. One instance serves DHCP at
// a time; while it moves, the new one is starting and the old one still owes
// its final leases.
const DHCP_STATES = {
  serving: { tone: 'ok', words: () => 'Serving' },
  starting: {
    tone: 'warn',
    words: (from) => (from ? `Starting, waiting for ${from}` : 'Starting'),
  },
  handing_over: { tone: 'warn', words: () => 'Handing over' },
};

/**
 * `{ tone, words }` for a row's DHCP state, or null for an instance that has
 * no part in DHCP (and for every row from a server that does not say).
 * `handover` is the list's `dhcp.handover`, which names what a starting
 * instance waits for.
 */
export function dhcpState(row, handover = null) {
  const known = DHCP_STATES[row?.dhcp];
  if (!known) return null;
  return { tone: known.tone, words: known.words(handover?.from_name || '') };
}

/** The row serving DHCP now, of a list of instances; null when none says so. */
export function dhcpServer(rows) {
  return rows.find((row) => row.dhcp === 'serving') || null;
}

/**
 * The two ends of a pending handover, by name: `{ from, to }`. The old one is
 * named by the handover itself, and the new one is the row that is starting.
 */
export function handoverNames(handover, rows) {
  const old = rows.find((row) => row.dhcp === 'handing_over');
  const next = rows.find((row) => row.dhcp === 'starting');
  return {
    from: handover?.from_name || old?.name || 'the previous instance',
    to: next?.name || 'the new instance',
  };
}

/** Whole seconds a handover has waited at `now` (ms); 0 for a time ahead. */
export function handoverWaited(handover, now = Date.now()) {
  const since = Date.parse(handover?.since);
  return Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}

/** "DHCP is moving to ns2. Waiting for ns1 to hand over its leases, 45 seconds so far." */
export function handoverText(handover, rows, now = Date.now()) {
  const { from, to } = handoverNames(handover, rows);
  const seconds = handoverWaited(handover, now);
  const waited =
    seconds < 60 ? countOf(seconds, 'second') : countOf(Math.floor(seconds / 60), 'minute');
  return `DHCP is moving to ${to}. Waiting for ${from} to hand over its leases, ${waited} so far.`;
}
