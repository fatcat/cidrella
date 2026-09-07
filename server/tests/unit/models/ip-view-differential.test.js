/**
 * Contract test: the server address projection consumed by the client.
 *
 * `computeIpView` in server/src/models/ip-view.js decides what an address is.
 * `ipLifecycleDisplay` in client/src/utils/ipLifecycleDisplay.js only formats
 * that projection. The client must not independently reclassify raw lifecycle
 * facts because that would recreate a second ownership authority.
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

// Each raw row is classified by the server, then its projection is formatted by
// the client. Grouped by the server branch it probes so a failure names the
// rule that broke.
const ROWS = [
  { _: 'system', allocation_state: 'system' },
  { _: 'gateway', allocation_state: 'gateway' },
  { _: 'reserved', allocation_state: 'reserved', reservation_note: 'printer' },
  { _: 'static DNS', allocation_state: 'static_dns' },
  { _: 'static DHCP', allocation_state: 'static_dhcp' },
  { _: 'dynamic DHCP', allocation_state: 'dynamic_dhcp' },
  { _: 'SLAAC', allocation_state: 'slaac' },
  { _: 'quarantined', allocation_state: 'quarantined', address_conflict_reason: 'overlap' },
  { _: 'rogue flag', allocation_state: 'unassigned', is_rogue: 1, rogue_reason: 'mac mismatch' },
  { _: 'online unassigned', allocation_state: 'unassigned', is_online: 1 },
  { _: 'offline unassigned', allocation_state: 'unassigned', is_online: 0 },
  { _: 'dynamic pool', allocation_state: 'unassigned', in_dynamic_pool: 1 },
  // Protocol-shaped data cannot override canonical allocation.
  { _: 'legacy facts ignored', allocation_state: 'unassigned', has_dhcp_reservation: 1, has_static_dns: 1 },
  // truthiness: SQLite and JSON both reach the UI, so '1' must behave as 1
  { _: 'string flags', allocation_state: 'unassigned', is_online: '1', is_rogue: '1' },
];

// The client returns a rich object, while the server projects label strings.
function clientType(row) {
  const out = ipLifecycleDisplay({ ...row, ...computeIpView({ ...row }) });
  return out.addressType ? out.addressType.label : null;
}
function serverType(row) {
  return computeIpView({ ...row }).address_type ?? null;
}

describe('#1: the client preserves the server address projection', () => {
  it.each(ROWS.map(r => [r._, r]))('%s', (_label, row) => {
    expect(clientType(row), `server said ${serverType(row)}`).toBe(serverType(row));
  });

  it('agrees on display status and severity too', () => {
    for (const row of ROWS) {
      const s = computeIpView({ ...row });
      const c = ipLifecycleDisplay({ ...row, ...s });
      expect(c.status, `${row._} status`).toBe(s.ip_display_status);
      expect(c.statusSeverity, `${row._} severity`).toBe(s.ip_status_severity);
    }
  });

  it('the fixture table reaches every address type, so agreement is not vacuous', () => {
    const seen = new Set(ROWS.map(serverType));
    for (const t of [ADDRESS_TYPE.SYSTEM, ADDRESS_TYPE.GATEWAY, ADDRESS_TYPE.ROGUE,
      ADDRESS_TYPE.RESERVED_DHCP, ADDRESS_TYPE.DYNAMIC_DHCP, ADDRESS_TYPE.RESERVED,
      ADDRESS_TYPE.STATIC_DNS]) {
      expect(seen, `no fixture produces ${t}`).toContain(t);
    }
    expect(seen, 'no fixture produces an unclassified row').toContain(null);
  });
});
