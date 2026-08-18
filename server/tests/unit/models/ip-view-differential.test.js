/**
 * Differential test: the server address classifier against the client one.
 *
 * `computeIpView` in server/src/models/ip-view.js and `ipLifecycleDisplay` in
 * client/src/utils/ipLifecycleDisplay.js decide the same thing: what an address
 * IS. Nine branches, identical in order and condition (duplicate-logic audit
 * #1). The client copy is a fallback for rows that reach the UI without passing
 * through `enrichIpViewRows`, which DhcpPanel and DnsPanel both do.
 *
 * They have drifted before, twice. The `&& !hasStaticDns` guard added
 * server-side in c3454b3 was missing from the client copy for days, and the
 * local-address branch had to be added to both by hand.
 *
 * Kept as a pair per docs/CROSS-TIER-DUPLICATION.md option 3: the client needs
 * this synchronously with no round trip, and extracting a shared module would
 * mean the client importing from server/src/models/, which drags in the DB
 * layer. The price of keeping a pair is this test.
 *
 * It lives in the SERVER suite because the client module is pure with zero
 * imports, so the server can import it, while ip-view.js pulls in the DB layer
 * and the client cannot.
 *
 * If this fails, do not edit the fixture table. Work out which side changed.
 */
import { describe, it, expect } from 'vitest';
import { computeIpView, ADDRESS_TYPE } from '../../../src/models/ip-view.js';
import { ipLifecycleDisplay } from '../../../../client/src/utils/ipLifecycleDisplay.js';

const future = new Date(Date.now() + 3600_000).toISOString();
const past = new Date(Date.now() - 3600_000).toISOString();

// Each row is fed to both implementations. Grouped by the branch it probes so a
// failure names the rule that broke.
const ROWS = [
  // system / gateway, decided by range_type_name
  { _: 'network', range_type_name: 'Network', status: 'available' },
  { _: 'broadcast', range_type_name: 'Broadcast', status: 'available' },
  { _: 'gateway', range_type_name: 'Gateway', status: 'locked' },
  // the appliance's own address, which must beat the rogue branch
  { _: 'local', is_local_address: 1, status: 'available', is_online: 1 },
  { _: 'local beats rogue', is_local_address: 1, is_rogue: 1, status: 'available' },
  // explicit rogue flag
  { _: 'rogue flag', is_rogue: 1, status: 'available', rogue_reason: 'mac mismatch' },
  // online + available + nothing claiming it
  { _: 'online unclaimed', is_online: 1, status: 'available' },
  // ... and each of the four things that DO claim it
  { _: 'claimed by reservation', is_online: 1, status: 'available', has_dhcp_reservation: 1 },
  { _: 'claimed by hostname', is_online: 1, status: 'available', hostname: 'nas' },
  { _: 'claimed by lease', is_online: 1, status: 'available', dhcp_expires_at: future },
  { _: 'claimed by static dns', is_online: 1, status: 'available', has_static_dns: 1 },
  // reservation and lease precedence
  { _: 'reservation', has_dhcp_reservation: 1, status: 'dhcp' },
  { _: 'reservation beats lease', has_dhcp_reservation: 1, dhcp_expires_at: future, status: 'dhcp' },
  { _: 'active lease', dhcp_expires_at: future, status: 'dhcp' },
  { _: 'infinite lease', dhcp_expires_at: 'infinite', status: 'dhcp' },
  { _: 'expired lease', dhcp_expires_at: past, status: 'dhcp' },
  // locked / assigned / static dns
  { _: 'locked', status: 'locked', reservation_note: 'printer' },
  { _: 'assigned', status: 'assigned' },
  { _: 'static dns flag', has_static_dns: 1, status: 'available' },
  { _: 'dns detection source', detection_source: 'dns', hostname: 'host.lan', status: 'available' },
  { _: 'dns source without hostname', detection_source: 'dns', status: 'available' },
  // online in a dhcp scope with nothing else
  { _: 'online dhcp status', is_online: 1, status: 'dhcp' },
  { _: 'offline available', is_online: 0, status: 'available' },
  // truthiness: SQLite and JSON both reach the UI, so '1' must behave as 1
  { _: 'string flags', is_online: '1', is_rogue: '1', status: 'available' },
  { _: 'string reservation', has_dhcp_reservation: '1', status: 'dhcp' },
];

// The client returns a rich object, the server a label string.
function clientType(row) {
  const out = ipLifecycleDisplay({ ...row });
  return out.addressType ? out.addressType.label : null;
}
function serverType(row) {
  return computeIpView({ ...row }).address_type ?? null;
}

describe('#1: the two address classifiers agree', () => {
  it.each(ROWS.map(r => [r._, r]))('%s', (_label, row) => {
    expect(clientType(row), `server said ${serverType(row)}`).toBe(serverType(row));
  });

  it('agrees on display status and severity too', () => {
    for (const row of ROWS) {
      const s = computeIpView({ ...row });
      const c = ipLifecycleDisplay({ ...row });
      expect(c.status, `${row._} status`).toBe(s.ip_display_status);
      expect(c.statusSeverity, `${row._} severity`).toBe(s.ip_status_severity);
    }
  });

  it('the fixture table reaches every address type, so agreement is not vacuous', () => {
    const seen = new Set(ROWS.map(serverType));
    for (const t of [ADDRESS_TYPE.SYSTEM, ADDRESS_TYPE.GATEWAY, ADDRESS_TYPE.ROGUE,
      ADDRESS_TYPE.RESERVED_DHCP, ADDRESS_TYPE.DYNAMIC_DHCP, ADDRESS_TYPE.LOCKED,
      ADDRESS_TYPE.STATIC_DNS]) {
      expect(seen, `no fixture produces ${t}`).toContain(t);
    }
    expect(seen, 'no fixture produces an unclassified row').toContain(null);
  });
});

describe('#1: the one known divergence, pinned deliberately', () => {
  it('disagrees only when a row carries NO status at all', () => {
    // computeIpView defaults a missing status to 'available'; the client leaves
    // it undefined and classifies nothing. Real rows always carry a status, so
    // this does not bite, and changing it would alter fallback behaviour.
    // Recorded here so it stays a decision rather than becoming a surprise.
    const row = { is_online: 1 };
    expect(serverType(row)).toBe(ADDRESS_TYPE.ROGUE);
    expect(clientType(row)).toBeNull();
  });

  it('and every fixture WITH a status agrees, which is the point', () => {
    for (const row of ROWS) {
      expect(row.status ?? row.ip_lifecycle_status, `${row._} needs a status`).toBeDefined();
    }
  });
});
