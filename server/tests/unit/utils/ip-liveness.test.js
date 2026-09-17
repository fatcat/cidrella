import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';

vi.mock('../../../src/utils/arp-cache.js', () => ({ lookupArpMac: vi.fn(() => 'aa:bb:cc:dd:ee:04') }));
vi.mock('../../../src/utils/nd-cache.js', () => ({
  lookupNdEntry: vi.fn((ip) => (ip === 'fd00:a::1600' ? { mac: 'aa:bb:cc:dd:ee:16', interface: 'eth0' } : null)),
}));

const { recordDnsQueryLiveness } = await import('../../../src/utils/ip-liveness.js');
const { invalidateSubnetCache } = await import('../../../src/utils/ip-sync.js');

let db;
let tmpDir;
let v6;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
  v6 = db
    .prepare(
      `INSERT INTO subnets (cidr, name, network_address, prefix_length, address_family, status)
       VALUES ('fd00:a::/64', 'v6', 'fd00:a::', 64, 6, 'allocated')`,
    )
    .run().lastInsertRowid;
  invalidateSubnetCache();
});

afterAll(() => cleanupTestDb(tmpDir));

describe('recordDnsQueryLiveness with IPv6 sources', () => {
  it('ignores loopback, unspecified, link-local and multicast sources', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'FE80::abcd', 'ff02::1', 'nope', '']) {
      expect(recordDnsQueryLiveness(db, ip)).toMatchObject({ ignored: true });
    }
  });

  it('records a unique-local source inside a managed network with its neighbor-table MAC', () => {
    const result = recordDnsQueryLiveness(db, 'fd00:a::1600', { createRogue: true });
    expect(result.ignored).toBeFalsy();
    const row = db.prepare("SELECT * FROM ip_addresses WHERE ip_address = 'fd00:a::1600'").get();
    expect(row).toMatchObject({ subnet_id: v6, is_online: 1, last_seen_mac: 'aa:bb:cc:dd:ee:16', address_family: 6 });
  });

  it('ignores a source outside every managed network', () => {
    expect(recordDnsQueryLiveness(db, 'fd00:b::1')).toMatchObject({ ignored: true });
  });
});
