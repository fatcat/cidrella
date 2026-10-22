/**
 * dnsmasq's side of a stack switch: the lease file a handover writes for it
 * to load, and the file 0.5.2's mixed mode (Kea serving DHCP beside dnsmasq)
 * left behind, which would make dnsmasq ignore every DHCP request.
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
describe('the 0.5.2 not-serving file', () => {
  it('is removed, and the scope files are the same as without it', () => {
    regenerateScopeConfigs(db, { confDir });
    const serving = files();
    fs.writeFileSync(path.join(confDir, 'dhcp-not-serving.conf'), 'dhcp-ignore=tag:!nosuchtag\n');
    expect(regenerateScopeConfigs(db, { confDir })).toBe(true);
    expect(files()).toEqual(serving);
    expect(regenerateScopeConfigs(db, { confDir })).toBe(false);
  });

  it('keeps the reservations of both families', () => {
    regenerateReservations(db, { hostsDir });
    const text = fs.readFileSync(path.join(hostsDir, 'reservations.hosts'), 'utf8');
    expect(text).toContain('10.60.0.50');
    expect(text).toContain('[fd00:63::50]');
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
