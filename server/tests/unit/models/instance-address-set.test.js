/**
 * An offer from any instance of this CIDRella is its own DHCP: the rogue
 * probes trust every address an instance is known by, both families.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { setupTestDb, cleanupTestDb } = await import('../../helpers/test-db.js');
const { addMember, instanceAddressSet, setDnsAddresses } =
  await import('../../../src/models/sync-instance.js');
const { classifyOffer } = await import('../../../src/utils/dhcp-probe.js');

let db;
let tmpDir;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
});
afterAll(() => cleanupTestDb(tmpDir));

describe('instanceAddressSet', () => {
  it('holds the address a member paired from and the ones it serves on, IPv4 and IPv6', () => {
    addMember(db, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      name: 'member-a',
      address: '10.9.0.2',
      port: 443,
      fingerprint: 'a'.repeat(64),
      version: '0.7.0',
      schema: 1,
    });
    const row = db.prepare("SELECT id FROM sync_instances WHERE name = 'member-a'").get();
    setDnsAddresses(db, row.id, ['10.9.1.2', 'FD00:9::2']);

    const known = instanceAddressSet(db);

    expect([...known].sort()).toEqual(['10.9.0.2', '10.9.1.2', 'fd00:9::2']);
    expect(
      classifyOffer({ serverId: '10.9.1.2' }, { selfIps: known, authorized: new Set() }),
    ).toEqual({ rogue: false, reason: 'self' });
    expect(
      classifyOffer({ serverId: '10.9.1.99' }, { selfIps: known, authorized: new Set() }).rogue,
    ).toBe(true);
  });
});
