// The wording for instances: the controller, which owns the data, and the
// members, which hold a synced read-only copy of it. One place for the sync
// state words and tones, the header chip, and how far behind a member is, so
// the header and Settings > Instances say the same thing. Also which instance
// holds DHCP (exactly one, and an admin can move it) and what each instance's
// DNS and DHCP servers are doing. And a change of
// controller: a handover in progress, and a controller that was replaced.

import { formatDateTime, formatRelativeTime } from './dateFormat.js';
import { countOf, EMPTY_CELL } from './format.js';

// What a server that says nothing about instances is: one box, as before 0.7.0.
export function singleBox() {
  return {
    mode: 'controller',
    controller_name: null,
    controller_url: null,
    members: 0,
    sync: null,
    serves_dhcp: true,
    fenced: false,
    fenced_by: null,
    handover_to: null,
  };
}

/** A controller that takes no changes: replaced, or handing over to a member. */
export function isFrozen(instance) {
  if (instance?.fenced) return true;
  return instance?.mode !== 'member' && Boolean(instance?.handover_to);
}

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
  // A replaced controller reports as a member with no controller: ask this first.
  if (instance.fenced) {
    const label = replacedBy(instance.fenced_by);
    return {
      label,
      tone: 'err',
      state: 'Replaced',
      title: `${label}. This instance takes no changes.\nRejoin it as a member under Settings > System > Instances.`,
    };
  }
  if (instance.mode !== 'member' && instance.handover_to) {
    const label = `Handing over to ${instance.handover_to}`;
    return {
      label,
      tone: 'warn',
      state: 'Frozen',
      title: `${instance.handover_to} is becoming the controller. No changes can be made until it is done.`,
    };
  }
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

// What a row's DNS or DHCP server is doing, as GET /api/instances reports it
// (`dns_state`, `dhcp_state`): null when the server cannot vouch for it, a
// member out of contact or another instance seen from a member.
// One wording for DNS and DHCP on every instance: On or Off, Not running for
// a server that is on but whose daemon is down, and for DHCP, No interface
// when the instance holds it but has DHCP on for none of its interfaces.
const SERVER_STATES = {
  serving: { tone: 'ok', words: 'On' },
  off: { tone: 'muted', words: 'Off' },
  down: { tone: 'err', words: 'Not running' },
  no_interface: {
    tone: 'err',
    words: 'No interface',
    title:
      'DHCP is assigned to this instance, but none of its interfaces has DHCP switched on, ' +
      'so no client is answered. Switch one on under Settings > General > Interfaces there.',
  },
};
const NOT_SERVED_TITLE =
  'DHCP is assigned to this instance and switched off under Settings > General > ' +
  'Interfaces, so no instance serves it.';

/** `{ tone, words }` for a row's DNS server, or null when it is not known. */
export function dnsState(row) {
  const known = SERVER_STATES[row?.dns_state];
  return known ? { ...known } : null;
}

// One instance holds DHCP at a time; while it moves, the new one is starting
// and the old one still owes its final leases.
const DHCP_MOVES = {
  starting: {
    tone: 'warn',
    words: (from) => (from ? `Starting, waiting for ${from}` : 'Starting'),
  },
  handing_over: { tone: 'warn', words: () => 'Handing over' },
};

/**
 * `{ tone, words, title? }` for a row's DHCP, or null for nothing to say.
 * `row.dhcp` is the instance's part in DHCP (assigned: 'serving', or a move);
 * `row.dhcp_state` what its server does. Assigned and switched off, nobody
 * serves DHCP, and the row says Off rather than On. `handover` is the
 * list's `dhcp.handover`, which names what a starting instance waits for.
 */
export function dhcpState(row, handover = null) {
  const move = DHCP_MOVES[row?.dhcp];
  if (move) return { tone: move.tone, words: move.words(handover?.from_name || '') };
  const known = SERVER_STATES[row?.dhcp_state];
  if (row?.dhcp === 'serving') {
    if (!known) return { tone: 'info', words: 'Assigned' };
    return row.dhcp_state === 'off' ? { ...known, title: NOT_SERVED_TITLE } : { ...known };
  }
  // Not assigned: off is the rule here, and serving would be a second server.
  if (row?.dhcp_state === 'serving') {
    return {
      tone: 'err',
      words: 'On, not assigned',
      title: 'This instance answers DHCP though another one holds it.',
    };
  }
  return row?.dhcp_state === 'off' ? { ...known } : null;
}

const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/**
 * The line saying which instances DHCP clients are given as DNS servers, from
 * GET /api/instances `dns_handed_out`; null while none is left out (or from a
 * server that does not say).
 */
export function dnsHandoutLine(handedOut) {
  const leftOut = handedOut?.left_out || [];
  if (leftOut.length === 0) return null;
  const served = handedOut.served || [];
  const verb = leftOut.length === 1 ? 'answers' : 'answer';
  return (
    `DHCP clients are given ${countOf(served.length, 'instance')} as DNS servers: ` +
    `${listFormat.format(served)}. ${listFormat.format(leftOut)} ${verb} DNS but ` +
    `${leftOut.length === 1 ? 'is' : 'are'} not handed out, since clients use only the first ` +
    `${handedOut.limit}.`
  );
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

/** "Replaced by ns2", or by a controller this instance cannot name. */
export function replacedBy(name) {
  return name ? `Replaced by ${name}` : 'Replaced by another controller';
}

/**
 * What happened to a controller that was replaced, and since when, from the
 * `promotion.fenced` of GET /api/instances. Two sentences, and a third naming
 * the instance that reported it when that is not the new controller itself.
 */
export function fencedText(fenced) {
  const who = fenced?.by_name || 'Another instance';
  const when = formatDateTime(fenced?.since);
  const since =
    when === EMPTY_CELL
      ? 'This instance takes no changes'
      : `This instance has taken no changes since ${when}`;
  const toldBy =
    fenced?.told_by && fenced.told_by !== fenced.by_name ? ` ${fenced.told_by} reported it.` : '';
  return `${who} replaced this instance as the controller. ${since}, and its data is out of date.${toldBy}`;
}

/**
 * What taking the controller back loses: the changes made on the controller
 * that replaced this one. '' when neither its name nor the time is known.
 */
export function takeBackLossText(fenced) {
  const when = formatDateTime(fenced?.since);
  const since = when === EMPTY_CELL ? '' : ` since ${when}`;
  if (!fenced?.by_name && !since) return '';
  return `Changes made on ${fenced?.by_name || 'the other controller'}${since} are lost unless it comes back and you enter them again.`;
}

/** "Handing over to ns2. Waiting for it to catch up and take over, 12 seconds so far." */
export function promotionText(handover, now = Date.now()) {
  const to = handover?.to_name || 'the new controller';
  return `Handing over to ${to}. Waiting for it to catch up and take over, ${waitedWords(handoverWaited(handover, now))} so far.`;
}

/** What the page says between a restart being asked for and the box answering again. */
export function restartingText(awaiting) {
  const role =
    awaiting?.mode === 'member'
      ? `a member${awaiting.name ? ` of ${awaiting.name}` : ''}`
      : 'the controller';
  return `Restarting as ${role}. The sign-in page opens when it is back.`;
}

// "45 seconds", then whole minutes.
function waitedWords(seconds) {
  return seconds < 60 ? countOf(seconds, 'second') : countOf(Math.floor(seconds / 60), 'minute');
}

/** Whole seconds a handover has waited at `now` (ms); 0 for a time ahead. */
export function handoverWaited(handover, now = Date.now()) {
  const since = Date.parse(handover?.since);
  return Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}

/** "DHCP is moving to ns2. Waiting for ns1 to hand over its leases, 45 seconds so far." */
export function handoverText(handover, rows, now = Date.now()) {
  const { from, to } = handoverNames(handover, rows);
  const waited = waitedWords(handoverWaited(handover, now));
  return `DHCP is moving to ${to}. Waiting for ${from} to hand over its leases, ${waited} so far.`;
}
