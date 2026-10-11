/**
 * readMemfileLeases: Kea's lease files read with Kea stopped, for an install
 * moving from Kea back to dnsmasq at boot. Column names are Kea 3's
 * (src/lib/dhcpsrv/csv_lease_file4.cc and csv_lease_file6.cc).
 */
import '../../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readMemfileLeases } from '../../../../src/backends/kea/leases.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const T = NOW / 1000;
const V4_HEADER =
  'address,hwaddr,client_id,valid_lifetime,expire,subnet_id,fqdn_fwd,fqdn_rev,hostname,state,user_context,pool_id';
const V6_HEADER =
  'address,duid,valid_lifetime,expire,subnet_id,pref_lifetime,lease_type,iaid,prefix_len,fqdn_fwd,fqdn_rev,hostname,hwaddr,state,user_context,hwtype,hwaddr_source,pool_id';

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-memfile-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name, lines) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
};

describe('readMemfileLeases', () => {
  it('reads DHCPv4 leases, the last row for an address winning', () => {
    const older = write('v4.csv.2', [
      V4_HEADER,
      `10.60.0.120,aa:bb:cc:00:00:09,,3600,${T + 100},1,0,0,old-name,0,,0`,
    ]);
    const live = write('v4.csv', [
      V4_HEADER,
      `10.60.0.120,aa:bb:cc:00:00:09,01:aa:bb:cc:00:00:09,3600,${T + 1800},1,0,0,laptop&#x2cwork,0,,0`,
      `10.60.0.121,aa:bb:cc:00:00:0a,,3600,${T + 60},1,0,0,,1,,0`,
      `10.60.0.122,aa:bb:cc:00:00:0b,,3600,${T - 60},1,0,0,gone,0,,0`,
      `10.60.0.123,aa:bb:cc:00:00:0c,,0,${T},1,0,0,deleted,0,,0`,
      `10.60.0.124,aa:bb:cc:00:00:0d,,4294967295,${T - 999},1,0,0,caf&#xc3&#xa9,0,,0`,
    ]);
    const leases = readMemfileLeases([path.join(dir, 'missing.csv'), older, live], 4, { now: NOW });
    expect(leases).toEqual([
      {
        ip: '10.60.0.120',
        mac: 'aa:bb:cc:00:00:09',
        hostname: 'laptop,work',
        clientId: '01:aa:bb:cc:00:00:09',
        expiresAt: new Date((T + 1800) * 1000).toISOString(),
        dhcpVersion: 4,
        duid: null,
        iaid: null,
      },
      {
        ip: '10.60.0.124',
        mac: 'aa:bb:cc:00:00:0d',
        hostname: 'café',
        clientId: null,
        expiresAt: 'infinite',
        dhcpVersion: 4,
        duid: null,
        iaid: null,
      },
    ]);
  });

  it('reads DHCPv6 addresses and leaves delegated prefixes out', () => {
    const duid = '00:01:00:01:aa:bb:cc:dd:ee:ff:00:11:22:33';
    const live = write('v6.csv', [
      V6_HEADER,
      `fd00:63::120,${duid},3600,${T + 1800},2,1800,0,3,128,0,0,phone,,0,,0,0,0`,
      `fd00:63::121,${duid},3600,${T + 1800},2,1800,1,4,128,0,0,,,0,,0,0,0`,
      `fd00:64::,${duid},3600,${T + 1800},2,1800,2,5,56,0,0,,,0,,0,0,0`,
    ]);
    const leases = readMemfileLeases([live], 6, { now: NOW });
    expect(leases).toEqual([
      expect.objectContaining({ ip: 'fd00:63::120', duid, iaid: 3, hostname: 'phone' }),
      expect.objectContaining({ ip: 'fd00:63::121', temporary: true, iaid: 4 }),
    ]);
    expect(leases[0]).toMatchObject({ dhcpVersion: 6, mac: null, temporary: false });
  });

  it('reads nothing when no lease file exists', () => {
    expect(readMemfileLeases([path.join(dir, 'none.csv')], 4, { now: NOW })).toEqual([]);
  });
});
