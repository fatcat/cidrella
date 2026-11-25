/**
 * A member the controller has not heard from for its contact window is not
 * given to DHCP clients as a DNS server until it is back (dnsInstances). The
 * flag is data of record, so a member that serves DHCP builds the same list.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/init.js', async (importOriginal) =>
  (await import('../helpers/instances.js')).perInstanceDb(await importOriginal()),
);
vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { api, estate, rowOf, useEstates } = await import('../helpers/instance-estate.js');
const { syncOnce } = await import('../../src/sync/member.js');
const { CURRENT_MS, dnsInstances, setDnsAddresses, withdrawnDnsInstances } =
  await import('../../src/models/sync-instance.js');
const { followMemberContact } = await import('../../src/services/instance-services.js');
const { instanceDnsServers } = await import('../../src/utils/instance-dns.js');

useEstates();

const names = (db) => dnsInstances(db).map((instance) => instance.name);
const audits = (db, action) =>
  db
    .prepare('SELECT details FROM audit_log WHERE action = ?')
    .all(action)
    .map((row) => JSON.parse(row.details).name);
const later = () => Date.now() + CURRENT_MS + 1000;

// Give each instance one address of each family, so the served list can be read.
function address(on, instances) {
  for (const [one, v4, v6] of instances) {
    setDnsAddresses(on.db, rowOf(on, one).id, [v4, v6]);
  }
}

describe('a member out of contact', () => {
  it('is taken off the DNS list on the controller and its members, and put back when it calls', async () => {
    const [c, a, b] = await estate('ctl-oc1', 'alpha-oc1', 'beta-oc1');
    address(c, [
      [c, '10.70.0.1', 'fd00:70::1'],
      [a, '10.70.0.2', 'fd00:70::2'],
      [b, '10.70.0.3', 'fd00:70::3'],
    ]);
    // alpha calls; beta has gone quiet.
    c.db
      .prepare('UPDATE sync_instances SET last_contact_at = ? WHERE instance_id = ?')
      .run(new Date(later()).toISOString(), a.id);
    followMemberContact(c.db, later());

    expect(names(c.db)).toEqual(['ctl-oc1', 'alpha-oc1']);
    expect(withdrawnDnsInstances(c.db)).toEqual(['beta-oc1']);
    expect(audits(c.db, 'instance_dns_withdrawn')).toEqual(['beta-oc1']);
    const served = (db, family, cidr, value) =>
      instanceDnsServers(value, { family, cidr, instances: dnsInstances(db) });
    expect(served(c.db, 4, '10.70.0.0/24', '10.70.0.1')).toBe('10.70.0.1,10.70.0.2');
    expect(served(c.db, 6, 'fd00:70::/64', 'fd00:70::1')).toBe('fd00:70::1,fd00:70::2');

    // A member (one that would serve DHCP) builds the same list from its copy.
    await syncOnce(a.db);
    expect(names(a.db)).toEqual(['ctl-oc1', 'alpha-oc1']);
    // (alpha's sync reported its own addresses, so compare with the controller's.)
    for (const [family, cidr, value] of [
      [4, '10.70.0.0/24', '10.70.0.1'],
      [6, 'fd00:70::/64', 'fd00:70::1'],
    ]) {
      expect(served(a.db, family, cidr, value)).toBe(served(c.db, family, cidr, value));
      expect(served(a.db, family, cidr, value)).not.toMatch(/10\.70\.0\.3|fd00:70::3/);
    }

    // The page names it.
    const { dns_handed_out: handedOut } = (await api(c).get('/api/instances')).body;
    expect(handedOut.withdrawn).toEqual(['beta-oc1']);

    // beta calls again: back at once, on the controller and then on alpha.
    await syncOnce(b.db);
    expect(names(c.db)).toEqual(['ctl-oc1', 'alpha-oc1', 'beta-oc1']);
    expect(audits(c.db, 'instance_dns_restored')).toEqual(['beta-oc1']);
    await syncOnce(a.db);
    expect(names(a.db)).toEqual(['ctl-oc1', 'alpha-oc1', 'beta-oc1']);
  });

  it('leaves the list alone while every member is in contact, and never takes the controller off', async () => {
    const [c] = await estate('ctl-oc2', 'alpha-oc2');
    followMemberContact(c.db);
    expect(names(c.db)).toEqual(['ctl-oc2', 'alpha-oc2']);
    expect(audits(c.db, 'instance_dns_withdrawn')).toEqual([]);

    // Far in the future: only the member lapses.
    followMemberContact(c.db, later());
    expect(names(c.db)).toEqual(['ctl-oc2']);
    // A second check changes nothing and writes no second row.
    followMemberContact(c.db, later());
    expect(audits(c.db, 'instance_dns_withdrawn')).toEqual(['alpha-oc2']);
  });

  it('counts a member that never called from when it was added', async () => {
    const [c, a] = await estate('ctl-oc3', 'alpha-oc3');
    c.db
      .prepare(
        "UPDATE sync_instances SET last_contact_at = NULL, created_at = datetime('now') WHERE instance_id = ?",
      )
      .run(a.id);
    followMemberContact(c.db);
    expect(names(c.db)).toEqual(['ctl-oc3', 'alpha-oc3']);
    followMemberContact(c.db, later());
    expect(names(c.db)).toEqual(['ctl-oc3']);
  });
});
