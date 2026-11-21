/**
 * What a controller does with the facts a member sends up in its outbox
 * (sync/remote-sink.js): each goes to the same sink a fact observed on this
 * box goes to, as of the time the member observed it. A member's row is
 * untrusted input: every field is checked, lists are capped, what is not
 * known is ignored, and one bad entry never stops the rest.
 *
 *   'seen'         { seen: [{ ip, at, rogue?, mac? }] }
 *   'fingerprint'  { mac_address, dhcp_fingerprint, vendor_class,
 *                    dhcp_hostname, device_type, os_family, confidence, raw, at }
 *
 * `at` is epoch milliseconds on the member's clock. A time in the future is
 * taken as now.
 *
 * A member's sighting may flag an unknown host as rogue, as this box's own
 * DNS proxy does: the member's clients are the hosts at its site, and no one
 * else hears them. recordDnsQueryLiveness only does so for a sighting that is
 * still current, and only for an address inside a managed network.
 */
import { canonicalizeIp, parseIp } from '../utils/address.js';
import { isClientMac } from '../utils/ip.js';
import { sqlTime } from '../utils/sql-time.js';
import { localSink } from './local-sink.js';
import { FINGERPRINT_KIND, SEEN_KIND, SEEN_PER_ROW } from './remote-sink.js';

const macOrNull = (value) =>
  typeof value === 'string' && isClientMac(value) ? value.toLowerCase() : null;

// A string no longer than `max`, or null. Never cut short: half a value is
// not the value.
const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);

// New address rows one member's sightings may make in an hour. Every row is
// data of record and goes out to every member, and an IPv6 network never
// runs out of addresses to name.
export const NEW_ROWS_PER_HOUR = 2000;
const HOUR_MS = 3_600_000;
const budgets = new Map();

function mayAddRow(member, now = Date.now()) {
  let budget = budgets.get(member);
  if (!budget || now - budget.since >= HOUR_MS) {
    budget = { since: now, used: 0 };
    budgets.set(member, budget);
  }
  if (budget.used >= NEW_ROWS_PER_HOUR) {
    if (!budget.warned) {
      console.warn(`[sync] ${member} named more new addresses than an hour allows; the rest wait`);
      budget.warned = true;
    }
    return false;
  }
  budget.used++;
  return true;
}

/** Tests start each case with a full allowance. */
export const resetNewRowBudgets = () => budgets.clear();

function applySeen(db, payload, skew = 0, member = '') {
  const list = Array.isArray(payload?.seen) ? payload.seen.slice(0, SEEN_PER_ROW) : [];
  const known = db.prepare('SELECT 1 FROM ip_addresses WHERE ip_address = ? LIMIT 1');
  let applied = 0;
  db.transaction(() => {
    for (const entry of list) {
      try {
        const given = text(entry?.ip, 64);
        // No zone id: a link-local sighting has no meaning off its link.
        if (!given || !parseIp(given, { zoneId: false }) || !Number.isFinite(entry.at)) continue;
        const ip = canonicalizeIp(given);
        // An address the estate already knows always gets its sighting; one
        // it does not would become a new row, and those are rationed.
        if (!known.get(ip) && !mayAddRow(member)) continue;
        localSink.clientSeen(db, ip, {
          createRogue: entry.rogue === 1,
          source: 'passive',
          observedAt: entry.at + skew,
          mac: macOrNull(entry.mac),
        });
        applied++;
      } catch {
        /* this one is dropped, the rest go on */
      }
    }
  })();
  return applied;
}

function applyFingerprint(db, payload, skew = 0) {
  const mac = macOrNull(payload?.mac_address);
  if (!mac || !Number.isFinite(payload.at)) return 0;
  const confidence = Number.isInteger(payload.confidence) ? payload.confidence : 0;
  localSink.fingerprint(db, {
    mac_address: mac,
    dhcp_fingerprint: text(payload.dhcp_fingerprint, 255),
    vendor_class: text(payload.vendor_class, 255),
    dhcp_hostname: text(payload.dhcp_hostname, 255),
    device_type: text(payload.device_type, 64),
    os_family: text(payload.os_family, 64),
    confidence: Math.max(0, Math.min(100, confidence)),
    // Never 'manual': that is an operator's word, and it is sticky.
    source: 'dhcp',
    raw: text(payload.raw, 2000),
    observed_at: sqlTime(Math.min(payload.at + skew, Date.now())),
  });
  return 1;
}

const APPLY = { [SEEN_KIND]: applySeen, [FINGERPRINT_KIND]: applyFingerprint };

/** Is this outbox row a fact, by its kind? */
export const isMemberFact = (kind) => Object.hasOwn(APPLY, kind);

/** Apply one fact row. Returns how many observations it recorded; may throw. */
/** `skew`: how far the controller's clock is ahead of the member's, in ms. */
export function applyMemberFact(db, kind, payload, skew = 0, member = '') {
  return APPLY[kind](db, payload, skew, member);
}
