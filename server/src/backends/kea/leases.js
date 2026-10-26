/**
 * Kea's leases through lease_cmds and stat_cmds, as BackendLeases
 * (backends/contract.js). Kea keeps them in its memfile; CIDRella only reads,
 * adds (a handover) and deletes (a release) them through the API.
 */
import fs from 'fs';
import { INFINITE_LIFETIME } from './render.js';

const PAGE_LIMIT = 1000;

// Kea lease states: 0 default (in use), 1 declined, 2 expired-reclaimed,
// 3 released. Only an address in use is a lease.
const STATE_DEFAULT = 0;

const lower = (value) => (value ? String(value).toLowerCase() : null);

function expiresAt(lease) {
  const valid = Number(lease['valid-lft']);
  if (valid === INFINITE_LIFETIME) return 'infinite';
  return new Date((Number(lease.cltt) + valid) * 1000).toISOString();
}

// Kea stores the client's name qualified, as an absolute name: with no
// qualifying suffix that is the bare name and a dot ("laptop."). CIDRella reads
// a trailing dot as absolute, which would put the name at the root, so take
// the name as the client gave it. A name Kea qualified with a real suffix
// keeps it and loses only the dot.
function leaseHostname(name) {
  return name ? String(name).replace(/\.$/, '') || null : null;
}

/** One Kea lease4 or lease6 as a BackendLease, or null for one not in use. */
export function backendLeaseFromKea(lease, family) {
  if (Number(lease.state ?? STATE_DEFAULT) !== STATE_DEFAULT) return null;
  if (family === 6) {
    // A delegated prefix is not an address on the network.
    if (lease.type && lease.type !== 'IA_NA' && lease.type !== 'IA_TA') return null;
    const duid = lower(lease.duid);
    return {
      ip: lease['ip-address'],
      mac: null,
      hostname: leaseHostname(lease.hostname),
      clientId: duid,
      expiresAt: expiresAt(lease),
      dhcpVersion: 6,
      duid,
      iaid: lease.iaid ?? null,
      temporary: lease.type === 'IA_TA',
    };
  }
  return {
    ip: lease['ip-address'],
    mac: lower(lease['hw-address']),
    hostname: leaseHostname(lease.hostname),
    clientId: lower(lease['client-id']),
    expiresAt: expiresAt(lease),
    dhcpVersion: 4,
    duid: null,
    iaid: null,
  };
}

// Every lease Kea holds of one family, in Kea's own shape, a page at a time
// ("from" is exclusive).
async function pageRawLeases(command, family) {
  const raw = [];
  let from = 'start';
  for (;;) {
    const reply = await command(`lease${family}-get-page`, { from, limit: PAGE_LIMIT });
    if (reply.empty) break;
    const page = reply.arguments?.leases || [];
    raw.push(...page);
    if (page.length < PAGE_LIMIT) break;
    from = page[page.length - 1]['ip-address'];
  }
  return raw;
}

/** Every lease of one family in use, as BackendLeases. */
export async function pageLeases(command, family) {
  return (await pageRawLeases(command, family))
    .map((raw) => backendLeaseFromKea(raw, family))
    .filter(Boolean);
}

// stat_cmds names an address handed out in "cumulative-assigned-addresses"
// (DHCPv4) and "cumulative-assigned-nas" (DHCPv6), per subnet and pool.
const ASSIGNED_RE = /cumulative-assigned-(addresses|nas)$/;
// A renewal moves none of the address counters, only the replies sent:
// pkt4-ack-sent and pkt6-reply-sent.
const WATCH_RE = /(assigned|declined|reclaimed|^pkt4-ack-sent$|^pkt6-reply-sent$)/;

async function statistics(command) {
  const reply = await command('statistic-get-all');
  return reply.arguments || {};
}

// A statistic is [[value, timestamp], ...], newest first.
const current = (stat) => (Array.isArray(stat?.[0]) ? Number(stat[0][0]) || 0 : 0);

function sumOf(stats, re) {
  let total = 0;
  for (const [name, stat] of Object.entries(stats)) if (re.test(name)) total += current(stat);
  return total;
}

/**
 * The leases of both daemons. A page scan is not atomic: a lease that moves
 * to an address the scan has already passed would be missing from it. Kea
 * counts every address it hands out, so a count that moved during the scan
 * means a lease may have, and the read reports unsettled to be tried again.
 * Without stat_cmds answering, the scan is taken as it is.
 */
export async function readKeaLeases(commands, families) {
  const leases = [];
  for (const family of families) {
    const command = commands[family];
    let before;
    try {
      before = sumOf(await statistics(command), ASSIGNED_RE);
    } catch {
      before = null;
    }
    const page = await pageLeases(command, family);
    if (before !== null) {
      let after = before;
      try {
        after = sumOf(await statistics(command), ASSIGNED_RE);
      } catch {
        /* keep the scan */
      }
      if (after !== before) return { leases: null, unsettled: true };
    }
    leases.push(...page);
  }
  return { leases };
}

/**
 * A fingerprint of the lease counters: changes when Kea hands out, renews,
 * declines or reclaims an address. watchLeases polls it.
 */
export async function leaseSignature(command) {
  const stats = await statistics(command);
  return Object.keys(stats)
    .filter((name) => WATCH_RE.test(name))
    .sort()
    .map((name) => `${name}=${current(stats[name])}`)
    .join(';');
}

/**
 * Release a lease (lease4-del / lease6-del). Never throws: the stale sweep
 * counts what failed and moves on.
 */
export async function releaseKeaLease(commands, lease) {
  if (!lease?.ip) return { released: false, skipped: 'invalid-identity' };
  const family = lease.dhcpVersion === 6 || lease.ip.includes(':') ? 6 : 4;
  try {
    const reply = await commands[family](`lease${family}-del`, { 'ip-address': lease.ip });
    return reply.empty ? { released: false, skipped: 'not-found' } : { released: true };
  } catch (err) {
    return { released: false, error: err.message };
  }
}

/**
 * The lease4-add / lease6-add arguments for a BackendLease, for a handover.
 * Kea derives a lease's start time from `expire - valid-lft`, so the
 * remaining time is the valid lifetime and the start is now. An infinite
 * lease goes in with no lifetime, so Kea gives it its subnet's, starting now:
 * dnsmasq hands every reserved host an infinite lease, and carried over as
 * infinite it would hold the address from the reservation's next client for
 * good.
 */
export function keaLeaseArguments(lease, { now = Date.now() } = {}) {
  const family = lease.dhcpVersion === 6 ? 6 : 4;
  const timing =
    lease.expiresAt === 'infinite'
      ? {}
      : (() => {
          const expire = Math.floor(Date.parse(lease.expiresAt) / 1000);
          const valid = Math.max(1, expire - Math.floor(now / 1000));
          return { 'valid-lft': valid, expire };
        })();
  const name = lease.hostname ? { hostname: lease.hostname } : {};
  if (family === 6) {
    return {
      'ip-address': lease.ip,
      duid: lease.duid || lease.clientId,
      iaid: Number(lease.iaid ?? 0),
      type: lease.temporary ? 'IA_TA' : 'IA_NA',
      ...(timing.expire ? { 'preferred-lft': timing['valid-lft'] } : {}),
      ...timing,
      ...name,
    };
  }
  return {
    'ip-address': lease.ip,
    'hw-address': lease.mac,
    ...(lease.clientId ? { 'client-id': lease.clientId } : {}),
    ...timing,
    ...name,
  };
}

/**
 * Replace Kea's leases with BackendLeases (a handover). What Kea held before
 * goes first, in every state: leases from an earlier time Kea served would
 * hold addresses another server has handed out since. Returns
 * { added, failed: [{ ip, error }] }; a lease Kea refuses (outside every
 * subnet, a clashing address) is reported, not thrown, so one bad lease does
 * not stop the rest.
 */
export async function importKeaLeases(commands, leases, { families = [4, 6], ...opts } = {}) {
  for (const family of families) {
    for (const raw of await pageRawLeases(commands[family], family)) {
      await commands[family](`lease${family}-del`, { 'ip-address': raw['ip-address'] });
    }
  }
  let added = 0;
  const failed = [];
  for (const lease of leases) {
    const family = lease.dhcpVersion === 6 ? 6 : 4;
    try {
      await commands[family](`lease${family}-add`, keaLeaseArguments(lease, opts));
      added++;
    } catch (err) {
      failed.push({ ip: lease.ip, error: err.message });
    }
  }
  return { added, failed };
}

/**
 * DHCP packets received and sent since each daemon started, per family
 * served: { 4: { received, sent }, 6: { received, sent } }, a family missing
 * when not served. The metrics aggregator turns the totals into per-minute
 * counts.
 */
export async function keaPacketCounters(commands, families) {
  const counters = {};
  for (const family of families) {
    const stats = await statistics(commands[family]);
    counters[family] = {
      received: current(stats[`pkt${family}-received`]),
      sent: current(stats[`pkt${family}-sent`]),
    };
  }
  return counters;
}

// Kea's memfile lease types (lease6 "lease_type").
const MEMFILE_LEASE_TYPES = { 0: 'IA_NA', 1: 'IA_TA', 2: 'IA_PD' };

// Kea escapes each byte it will not store as is (a comma, "&", control and
// non-ASCII bytes) as "&#x" and two hex digits, with no closing semicolon.
// Everything else is ASCII, so the bytes go back together as UTF-8.
const unescapeField = (value) =>
  Buffer.from(
    value.replace(/&#x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  ).toString('utf8');

/**
 * The leases in Kea's memfile, read straight from the CSV with no daemon
 * running: boot uses it to carry the leases of an install Kea served to
 * dnsmasq. The files are read oldest first (a finished cleanup, then one in
 * progress, then the live file), and Kea appends a row for every change, so
 * the last row for an address is its lease. Rows not in use or already
 * expired are dropped. `files` lists the paths for one family.
 */
export function readMemfileLeases(files, family, { now = Date.now() } = {}) {
  const byAddress = new Map();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const [header, ...rows] = text.split(/\r?\n/);
    const columns = header.split(',');
    for (const row of rows) {
      if (!row.trim()) continue;
      const cells = row.split(',');
      const field = Object.fromEntries(columns.map((name, i) => [name, cells[i] ?? '']));
      if (field.address) byAddress.set(field.address, field);
    }
  }
  const leases = [];
  for (const field of byAddress.values()) {
    const valid = Number(field.valid_lifetime);
    const expire = Number(field.expire);
    // Kea marks a deleted lease with a zero lifetime.
    if (valid === 0 || (valid !== INFINITE_LIFETIME && !(expire * 1000 > now))) continue;
    const lease = backendLeaseFromKea(
      {
        'ip-address': field.address,
        'hw-address': field.hwaddr || null,
        'client-id': field.client_id || null,
        'valid-lft': valid,
        cltt: valid === INFINITE_LIFETIME ? expire : expire - valid,
        state: Number(field.state || 0),
        hostname: unescapeField(field.hostname || ''),
        duid: field.duid || null,
        iaid: field.iaid === undefined || field.iaid === '' ? null : Number(field.iaid),
        type: family === 6 ? MEMFILE_LEASE_TYPES[field.lease_type] || 'IA_NA' : undefined,
      },
      family,
    );
    if (lease) leases.push(lease);
  }
  return leases;
}
