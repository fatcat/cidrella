// Which instance answers DHCP (src/sync/dhcp-active.js): one rule, asked by
// the backend registry through roleSwitchedOff('dhcp'). Every combination of
// single box, controller and member; active here or elsewhere; a handover
// pending; the leases loaded or not; the host switch.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { setupTestDb, cleanupTestDb } = await import('../../helpers/test-db.js');
const { makeMember, makeController } = await import('../../helpers/member-mode.js');
const { dhcpState, holdsDhcp, markDhcpReady, quiesceDhcp, servesDhcpHere } =
  await import('../../../src/sync/dhcp-active.js');
const { roleSwitchedOff } = await import('../../../src/utils/role-switches.js');
const { ownInstanceId } = await import('../../../src/models/sync-instance.js');
const { deleteSetting, upsertSetting } = await import('../../../src/models/setting.js');

const OTHER = '11111111-2222-4333-8444-555555555555';
let db;
let tmpDir;
let self;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  self = ownInstanceId(db);
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => {
  makeController(db);
  for (const key of [
    'dhcp_active_instance',
    'dhcp_term',
    'dhcp_handover_from',
    'dhcp_handover_since',
  ]) {
    deleteSetting(db, key);
  }
  markDhcpReady(db, null);
  upsertSetting(db, 'dhcp_enabled', 'true');
});

function given({ active, term, handover, ready, host }) {
  if (active) upsertSetting(db, 'dhcp_active_instance', active);
  if (term !== undefined) upsertSetting(db, 'dhcp_term', term);
  if (handover) upsertSetting(db, 'dhcp_handover_from', handover);
  if (ready !== undefined) markDhcpReady(db, ready);
  if (host !== undefined) upsertSetting(db, 'dhcp_enabled', host);
}
// The rule, and the registry's reading of it, which must agree.
const serves = () => {
  const answer = servesDhcpHere(db);
  expect(roleSwitchedOff('dhcp')).toBe(!answer);
  return answer;
};

describe('a single box', () => {
  it('serves by its own switch alone, as before instances', () => {
    expect(dhcpState(db)).toMatchObject({ active: self, term: 0, here: true, handoverFrom: null });
    expect(serves()).toBe(true);
    given({ host: 'false' });
    expect(serves()).toBe(false);
    // Its leases are still the leases: the lease sync keeps storing them.
    expect(holdsDhcp(db)).toBe(true);
  });

  it('does not serve with no switch stored, the default', () => {
    deleteSetting(db, 'dhcp_enabled');
    expect(serves()).toBe(false);
  });
});

describe('the controller', () => {
  it('does not serve while a member is the active instance', () => {
    given({ active: OTHER, term: 1 });
    expect(serves()).toBe(false);
    expect(holdsDhcp(db)).toBe(false);
  });

  it('serves again once DHCP is back and its server has the leases', () => {
    given({ active: self, term: 2 });
    expect(serves()).toBe(false);
    given({ ready: 1 });
    expect(serves()).toBe(false);
    given({ ready: 2 });
    expect(serves()).toBe(true);
  });

  it('does not serve while the instance before it still owes its leases', () => {
    given({ active: self, term: 2, ready: 2, handover: OTHER });
    expect(serves()).toBe(false);
    expect(holdsDhcp(db)).toBe(false);
  });

  it('does not serve with its own switch off, or while a move holds it quiet', () => {
    given({ active: self, term: 2, ready: 2, host: 'false' });
    expect(serves()).toBe(false);
    given({ host: 'true' });
    const release = quiesceDhcp(db);
    expect(serves()).toBe(false);
    // Quiet is not gone: the final leases are still read and kept.
    expect(holdsDhcp(db)).toBe(true);
    release();
    expect(serves()).toBe(true);
  });
});

describe('a member', () => {
  beforeEach(() => makeMember(db));

  it('does not serve by default, whatever its own switch says', () => {
    expect(dhcpState(db)).toMatchObject({ active: 'test-controller', here: false, member: true });
    expect(serves()).toBe(false);
  });

  it('serves once it is the active instance and has the leases, its own switch ignored', () => {
    given({ active: self, term: 1, host: 'false' });
    expect(serves()).toBe(false);
    given({ ready: 1 });
    expect(serves()).toBe(true);
    expect(holdsDhcp(db)).toBe(true);
  });

  it('does not serve at a term it has not loaded the leases for', () => {
    given({ active: self, term: 3, ready: 1 });
    expect(serves()).toBe(false);
  });

  it('does not serve while a handover is pending, or once DHCP is elsewhere', () => {
    given({ active: self, term: 2, ready: 2, handover: OTHER });
    expect(serves()).toBe(false);
    deleteSetting(db, 'dhcp_handover_from');
    expect(serves()).toBe(true);
    given({ active: OTHER, term: 3 });
    expect(serves()).toBe(false);
  });
});
