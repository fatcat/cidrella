/**
 * A member's Instances page shows what every instance's DNS and DHCP servers
 * are doing, as the controller vouches for it: the controller sends the states
 * with each answer to a member's sync (SERVICES_HEADER). Without it a member
 * showed the controller as "Assigned" for DHCP and nothing for DNS, so a
 * controller holding DHCP with its DHCP switched off looked fine from a member.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../src/db/init.js', async (importOriginal) =>
  (await import('../helpers/instances.js')).perInstanceDb(await importOriginal()),
);
vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { api, estate, useEstates } = await import('../helpers/instance-estate.js');
const { syncOnce } = await import('../../src/sync/member.js');
const { upsertSetting } = await import('../../src/models/setting.js');
const { CURRENT_MS } = await import('../../src/models/sync-instance.js');

useEstates();
afterEach(() => vi.useRealTimers());

const statesOn = async (one) =>
  Object.fromEntries(
    (await api(one).get('/api/instances')).body.instances.map((row) => [
      row.name,
      { dns: row.dns_state, dhcp: row.dhcp_state },
    ]),
  );

describe("a member's Instances page", () => {
  it("shows the controller's servers and the other members' as the controller sees them", async () => {
    const [c, a, b] = await estate('ctl-s1', 'alpha-s1', 'beta-s1');
    await syncOnce(b.db);
    await syncOnce(a.db);
    const onController = await statesOn(c);
    const onMember = await statesOn(a);
    for (const name of ['ctl-s1', 'beta-s1']) {
      expect(onController[name].dns, name).not.toBeNull();
      expect(onMember[name], name).toEqual(onController[name]);
    }
  });

  it('shows the controller holding DHCP with its switch off as off (the case that read Assigned)', async () => {
    const [c, a] = await estate('ctl-s2', 'alpha-s2');
    upsertSetting(c.db, 'dhcp_enabled', 'false');
    // The controller reads its own states at most every five seconds.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 });
    await syncOnce(a.db);
    const row = (await api(a).get('/api/instances')).body.instances.find((r) => r.is_controller);
    expect(row).toMatchObject({ dhcp: 'serving', dhcp_state: 'off' });
  });

  it('says nothing for the others once it has not heard from the controller for a while', async () => {
    const [, a, b] = await estate('ctl-s3', 'alpha-s3', 'beta-s3');
    await syncOnce(b.db);
    await syncOnce(a.db);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + CURRENT_MS + 1000 });
    const onMember = await statesOn(a);
    expect(onMember['ctl-s3']).toEqual({ dns: null, dhcp: null });
    expect(onMember['beta-s3']).toEqual({ dns: null, dhcp: null });
    // Its own it reads itself.
    expect(onMember['alpha-s3'].dns).not.toBeNull();
  });
});
