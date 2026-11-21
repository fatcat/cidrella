/**
 * The facts sink of a member: what this box observes goes to its controller,
 * which owns the tables a fact is written to (docs/REDUNDANCY-PLAN.md,
 * sections 3 and 4). Nothing here writes the data of record. Facts wait in
 * sync_outbox, a table about this box alone, and sendOutbox (sync/member.js)
 * carries them up.
 *
 *   clientSeen   fires for every DNS query, so it is held in memory, one
 *                entry per address with the newest time it was heard, and
 *                written out every FLUSH_MS as one 'seen' row per
 *                SEEN_PER_ROW addresses.
 *   fingerprint  rare: one 'fingerprint' row each.
 *   leases       dropped. DHCP on a member comes in a later phase.
 *
 * What the controller does with a row is sync/member-facts.js.
 */
import net from 'net';
import { lookupArpMac } from '../utils/arp-cache.js';
import { lookupNdEntry } from '../utils/nd-cache.js';
import { isLocalAddress } from '../utils/local-addresses.js';

export const SEEN_KIND = 'seen';
export const FINGERPRINT_KIND = 'fingerprint';

const FLUSH_MS = 30_000;
// Addresses held between flushes. At the cap the held ones are written out
// early to make room, so none is lost; the cap on waiting rows below is what
// bounds a flood of made-up source addresses.
export const MAX_HELD = 5000;
// An observation is about 100 bytes of JSON at most, and sendOutbox sends a
// row of up to 60 KB: 500 fit with room to spare.
export const SEEN_PER_ROW = 500;
// 'seen' rows that wait while the controller is away, oldest dropped first.
// A flush is one row on all but the largest networks, so this is two hours of
// sightings. The controller takes one older than ten minutes as history only
// (it moves last_seen_at and nothing else), so older rows are worth little.
export const MAX_SEEN_ROWS = 240;
// Fingerprints are one row per DHCP exchange; the newest thousand wait.
export const MAX_FINGERPRINT_ROWS = 1000;

// address -> { at: epoch ms it was last heard, rogue: may it be an unknown host }
const held = new Map();
let timer = null;
let timerDb = null;

function queue(db, kind, payloads, cap) {
  const insert = db.prepare('INSERT INTO sync_outbox (kind, payload) VALUES (?, ?)');
  db.transaction(() => {
    for (const payload of payloads) insert.run(kind, JSON.stringify(payload));
    db.prepare(
      `DELETE FROM sync_outbox WHERE kind = ? AND id <= (
         SELECT id FROM sync_outbox WHERE kind = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    ).run(kind, kind, cap);
  })();
}

// The MAC this box has for an address it just heard from. The controller is
// on another link and cannot look it up.
const macOf = (ip) => (net.isIP(ip) === 6 ? lookupNdEntry(ip)?.mac || null : lookupArpMac(ip));

/**
 * Write the held sightings to the outbox, and forget them. Returns how many
 * addresses went. The timer calls it, sendOutbox calls it so a sync round
 * carries the newest, and a shutdown should.
 */
export function flushSeen(db) {
  if (held.size === 0) return 0;
  const observations = [];
  for (const [ip, { at, rogue }] of held) {
    const observation = { ip, at };
    // This box's own addresses are not unknown hosts, and only it knows them.
    if (rogue && !isLocalAddress(ip)) observation.rogue = 1;
    const mac = macOf(ip);
    if (mac) observation.mac = mac;
    observations.push(observation);
  }
  held.clear();
  const payloads = [];
  for (let i = 0; i < observations.length; i += SEEN_PER_ROW) {
    payloads.push({ seen: observations.slice(i, i + SEEN_PER_ROW) });
  }
  queue(db, SEEN_KIND, payloads, MAX_SEEN_ROWS);
  return observations.length;
}

function startTimer(db) {
  timerDb = db;
  if (timer) return;
  timer = setInterval(() => {
    try {
      flushSeen(timerDb);
    } catch (err) {
      console.warn(`[sync] could not queue the clients seen: ${err.message}`);
    }
  }, FLUSH_MS);
  timer.unref();
}

/** Stop the flush timer and forget what is held (tests, and a box leaving). */
export function stopRemoteSink() {
  clearInterval(timer);
  timer = null;
  timerDb = null;
  held.clear();
}

export const remoteSink = {
  leases: async () => ({ synced: 0, rejected: 0, blocking: [] }),

  // `source` does not travel: every caller says 'passive', and the controller
  // records a member's sighting as that. `createRogue` does, and it sticks for
  // the flush once any observer has said it.
  clientSeen(db, ip, { createRogue = false } = {}) {
    if (typeof ip !== 'string' || net.isIP(ip) === 0) return;
    const now = Date.now();
    const entry = held.get(ip);
    if (entry) {
      entry.at = now;
      entry.rogue ||= Boolean(createRogue);
      return;
    }
    if (held.size >= MAX_HELD) flushSeen(db);
    held.set(ip, { at: now, rogue: Boolean(createRogue) });
    startTimer(db);
  },

  fingerprint(db, fingerprint) {
    queue(db, FINGERPRINT_KIND, [{ ...fingerprint, at: Date.now() }], MAX_FINGERPRINT_ROWS);
  },
};
