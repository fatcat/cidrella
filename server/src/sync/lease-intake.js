/**
 * The controller's side of a member's lease report (POST /api/sync/leases):
 * who may report, what a lease in the body must look like, and what the
 * member is told. The leases are kept by ingestLeases, the same function the
 * controller's own leases go through, so nothing here decides what a lease
 * means (docs/ARCHITECTURE.md, Canonical IP Model). Everything in the body is
 * untrusted: a field of the wrong type or size drops that lease, and unknown
 * fields are ignored.
 */
import { ingestLeases } from '../services/dhcp-lease-ingest.js';
import { addressFamily, canonicalizeIp } from '../utils/address.js';
import { isValidRecordName } from '../utils/config-value-validation.js';
import { normalizeDuid } from '../utils/duid.js';
import { isLeaseHardwareAddress } from '../utils/mac.js';
import { clearHandover, dhcpState } from './dhcp-active.js';
import { releasesFor } from './dhcp-release-queue.js';
import { NOT_DHCP_ACTIVE } from './lease-wire.js';

// A /16 of leases in each family, with room. More is refused whole.
export const MAX_LEASES = 150_000;

// A client id as the DHCP servers spell it: printable, no spaces. It is
// written into a lease file when the leases move to another server.
const CLIENT_ID = /^[\x21-\x7e]{1,512}$/;
// An expiry as the adapters write it (Date.toISOString).
const EXPIRY = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

/** One lease of a report as a BackendLease (backends/contract.js), or null when it is not one. */
export function cleanLease(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.ip !== 'string' || raw.ip.length > 64) return null;
  const ip = canonicalizeIp(raw.ip);
  if (!ip) return null;
  const family = addressFamily(ip);
  const dhcpVersion = raw.dhcpVersion ?? family;
  // A DHCPv4 lease has an IPv4 address and a DHCPv6 lease an IPv6 one.
  if (dhcpVersion !== family) return null;

  // The name a client asked for is its own choice of words. One that could
  // not be a DNS name is not taken; the lease is still a lease.
  let hostname = null;
  if (raw.hostname !== null && raw.hostname !== undefined) {
    if (typeof raw.hostname !== 'string') return null;
    if (isValidRecordName(raw.hostname) && raw.hostname !== '@') hostname = raw.hostname;
  }
  let clientId = null;
  if (raw.clientId !== null && raw.clientId !== undefined) {
    if (typeof raw.clientId !== 'string' || !CLIENT_ID.test(raw.clientId)) return null;
    clientId = raw.clientId;
  }

  // A DHCPv4 lease is the client's hardware address: one without it is not a
  // lease, and could not be written into a lease file at a handover. The
  // forms are the adapters' own (utils/mac.js). A DHCPv6 lease is keyed by
  // its DUID and carries no MAC.
  let mac = null;
  if (raw.mac !== null && raw.mac !== undefined) {
    if (!isLeaseHardwareAddress(raw.mac)) return null;
    mac = raw.mac.toLowerCase();
  } else if (dhcpVersion === 4) {
    return null;
  }
  let duid = null;
  if (raw.duid !== null && raw.duid !== undefined) {
    duid = normalizeDuid(raw.duid);
    if (!duid) return null;
  }
  let iaid = null;
  if (raw.iaid !== null && raw.iaid !== undefined) {
    if (!Number.isInteger(raw.iaid) || raw.iaid < 0 || raw.iaid > 0xffffffff) return null;
    iaid = raw.iaid;
  }
  if (typeof raw.expiresAt !== 'string') return null;
  if (raw.expiresAt !== 'infinite') {
    if (!EXPIRY.test(raw.expiresAt) || Number.isNaN(Date.parse(raw.expiresAt))) return null;
  }

  const lease = { ip, mac, hostname, clientId, expiresAt: raw.expiresAt, dhcpVersion, duid, iaid };
  if (typeof raw.temporary === 'boolean') lease.temporary = raw.temporary;
  return lease;
}

const refusal = (status, code, error) => ({ status, body: { error, code } });

/**
 * Take one report from `member` (its sync_instances row). Returns
 * `{ status, body, cleared }`: 200 with what ingestLeases kept, the leases to
 * release (`blocking` hold another client's reservation, `release` are ones
 * the controller asked for) and how many were not leases at all (`invalid`);
 * 409 `not_dhcp_active` when this member is not the one whose leases count at
 * that term. `cleared` is true when a final report ended a handover: the
 * caller lets the new instance start (services/dhcp-follow.js).
 *
 * A running report is taken from the active instance at the current term,
 * with no handover pending. A final report is taken from the instance that
 * is handing over, at the term before; `unserved: true` in place of leases
 * says it never served at that term and has nothing to add.
 */
export function acceptLeaseReport(db, member, body) {
  const state = dhcpState(db);
  if (!body || !Number.isSafeInteger(body.term)) {
    return refusal(400, 'bad_request', 'The lease report is malformed.');
  }
  const final = body.final === true;
  const allowed = final
    ? state.handoverFrom === member.instance_id && body.term === state.term - 1
    : state.active === member.instance_id && !state.handoverFrom && body.term === state.term;
  if (!allowed) {
    return refusal(
      409,
      NOT_DHCP_ACTIVE,
      final
        ? `${member.name} is not handing DHCP over at term ${body.term}.`
        : `${member.name} does not serve DHCP at term ${body.term}. Its leases were not kept.`,
    );
  }

  let result = { synced: 0, rejected: 0, blocking: [] };
  let invalid = 0;
  let leases = [];
  if (!(final && body.unserved === true)) {
    if (!Array.isArray(body.leases) || body.leases.length > MAX_LEASES) {
      return refusal(400, 'bad_request', 'The lease report is malformed.');
    }
    for (const raw of body.leases) {
      const lease = cleanLease(raw);
      if (lease) leases.push(lease);
      else invalid++;
    }
    result = ingestLeases(db, leases);
  } else {
    leases = null;
  }
  if (invalid > 0) {
    console.warn(`[sync] ${invalid} lease(s) from ${member.name} were malformed and not kept`);
  }

  if (final) {
    clearHandover(db);
    // The instance has stopped: there is nothing left for it to release.
    return { status: 200, body: { ...result, blocking: [], release: [], invalid }, cleared: true };
  }
  return {
    status: 200,
    body: { ...result, release: releasesFor(leases), invalid },
    cleared: false,
  };
}
