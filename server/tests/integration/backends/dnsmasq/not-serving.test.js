/**
 * dnsmasq while another backend (Kea) serves DHCP: it keeps sending the
 * Router Advertisements and answers no DHCP request. DHCPv6 ranges stay so
 * the RAs keep their M and O flags (a range is never rewritten as ra-only,
 * which dnsmasq still serves), DHCPv4 ranges go, and dhcp-ignore covers the
 * rest. Also the lease file a handover writes for dnsmasq to load.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTestDb, enableIpv6, setupTestDb } from '../../../helpers/test-db.js';
import { seedBackendEstate } from '../../../helpers/backend-estate.js';
import {
  parseLeaseFile,
  regenerateReservations,
  regenerateScopeConfigs,
} from '../../../../src/backends/dnsmasq/dhcp.js';
import { readServerDuid } from '../../../../src/backends/dnsmasq/lease-file.js';
import { createDnsmasqBackend } from '../../../../src/backends/dnsmasq/index.js';

let db;
let tmpDir;
let confDir;
let hostsDir;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  seedBackendEstate(db);
});
afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  confDir = fs.mkdtempSync(path.join(tmpDir, 'conf-'));
  hostsDir = fs.mkdtempSync(path.join(tmpDir, 'hosts-'));
});

const files = () =>
  Object.fromEntries(
    fs
      .readdirSync(confDir)
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(confDir, name), 'utf8')]),
  );
const ranges = (all) =>
  Object.values(all)
    .flatMap((text) => text.split('\n'))
    .filter((line) => line.startsWith('dhcp-range='));

describe('scope files while not serving', () => {
  it('keeps the DHCPv6 ranges, drops DHCPv4, and ignores every request', () => {
    regenerateScopeConfigs(db, { confDir });
    const serving = files();
    expect(serving['dhcp-not-serving.conf']).toBeUndefined();

    expect(regenerateScopeConfigs(db, { confDir, serving: false })).toBe(true);
    const quiet = files();
    expect(quiet['dhcp-not-serving.conf']).toContain('dhcp-ignore=tag:!nosuchtag');
    // IPv4: no range, so dnsmasq opens no DHCPv4 socket.
    expect(ranges(quiet).some((line) => /10\.60\.0\./.test(line))).toBe(false);
    // IPv6: every range as it was, so the RA flags do not change.
    const v6Ranges = ranges(serving).filter((line) => line.includes('fd00:'));
    expect(v6Ranges.length).toBeGreaterThan(0);
    expect(ranges(quiet)).toEqual(v6Ranges);
    // A stateful range is never turned into ra-only (which dnsmasq serves anyway).
    expect(ranges(quiet).filter((line) => /fd00:63::/.test(line))).not.toEqual([]);
    expect(ranges(quiet).some((line) => /fd00:63::.*ra-only/.test(line))).toBe(false);
  });

  it('goes back to serving with the same files it had', () => {
    regenerateScopeConfigs(db, { confDir });
    const serving = files();
    regenerateScopeConfigs(db, { confDir, serving: false });
    expect(regenerateScopeConfigs(db, { confDir })).toBe(true);
    expect(files()).toEqual(serving);
    expect(regenerateScopeConfigs(db, { confDir })).toBe(false);
  });

  it('empties the reservations, both families, and puts them back', () => {
    regenerateReservations(db, { hostsDir });
    const file = path.join(hostsDir, 'reservations.hosts');
    const serving = fs.readFileSync(file, 'utf8');
    expect(serving).toContain('10.60.0.50');
    expect(serving).toContain('[fd00:63::50]');
    expect(regenerateReservations(db, { hostsDir, serving: false })).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    expect(regenerateReservations(db, { hostsDir })).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(serving);
  });
});

describe('importLeases', () => {
  it('writes a lease file dnsmasq loads, with the server DUID', async () => {
    const leaseFile = path.join(tmpDir, 'handover.leases');
    const expiresAt = new Date(Math.floor(Date.now() / 1000 + 3600) * 1000).toISOString();
    const leases = [
      {
        ip: '10.60.0.120',
        mac: 'aa:bb:cc:00:00:09',
        hostname: 'laptop',
        clientId: null,
        expiresAt,
        dhcpVersion: 4,
        duid: null,
        iaid: null,
      },
      {
        ip: 'fd00:63::120',
        mac: null,
        hostname: null,
        clientId: '00:01:00:01:aa:bb:cc:dd:ee:ff:00:11:22:33',
        expiresAt: 'infinite',
        dhcpVersion: 6,
        duid: '00:01:00:01:aa:bb:cc:dd:ee:ff:00:11:22:33',
        iaid: 3,
        temporary: false,
      },
    ];
    const serverDuid = '00:01:00:01:2e:8f:11:22:52:54:00:aa:bb:cc';
    const result = await createDnsmasqBackend().dhcp.importLeases(leases, {
      serverDuid,
      leaseFile,
    });
    expect(result).toEqual({ added: 2, failed: [] });
    expect(readServerDuid({ leaseFile })).toBe(serverDuid);
    expect(parseLeaseFile(fs.readFileSync(leaseFile, 'utf8'))).toEqual([
      leases[0],
      { ...leases[1], mac: null },
    ]);
  });
});
