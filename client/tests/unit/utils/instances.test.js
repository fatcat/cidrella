/**
 * The wording for instances: the header chip's three cases (a single box, a
 * controller with members, a member with its sync state), and how far behind
 * a member is, in words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  behindText,
  dhcpServer,
  dhcpState,
  dnsHandoutLine,
  dnsState,
  fencedText,
  handoverNames,
  handoverText,
  handoverWaited,
  instanceChip,
  lastSyncText,
  promotionText,
  replacedBy,
  restartingText,
  syncState,
  takeBackLossText,
} from '../../../src/utils/instances.js';
import { EMPTY_CELL } from '../../../src/utils/format.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const member = (sync) => ({ mode: 'member', controller_name: 'ns1', members: 0, sync });

describe('instanceChip', () => {
  it('shows nothing on a single box: a controller with no members', () => {
    expect(
      instanceChip({ mode: 'controller', controller_name: null, members: 0, sync: null }),
    ).toBeNull();
    expect(instanceChip(null)).toBeNull();
  });

  it('names a controller that has members', () => {
    const one = instanceChip({ mode: 'controller', controller_name: null, members: 1, sync: null });
    expect(one).toMatchObject({ label: 'Controller', tone: 'info' });
    expect(one.title).toBe('Controller of 1 member');
    expect(
      instanceChip({ mode: 'controller', controller_name: null, members: 3, sync: null }).title,
    ).toBe('Controller of 3 members');
  });

  it('names the controller a member follows, with the sync state as its tone', () => {
    const chip = instanceChip(
      member({ state: 'current', last_sync_at: '2026-11-21T11:57:00Z', last_error: null }),
    );
    expect(chip.label).toBe('Member of ns1');
    expect(chip.tone).toBe('ok');
    expect(chip.state).toBe('Current');
    expect(chip.title).toBe('Member of ns1: Current with the controller\nLast sync 3m ago');
  });

  it.each([
    ['starting', 'muted'],
    ['current', 'ok'],
    ['behind', 'warn'],
    ['offline', 'err'],
    ['paused', 'warn'],
    ['something-new', 'muted'],
  ])('sync state %s reads as %s', (state, tone) => {
    expect(instanceChip(member({ state, last_sync_at: null, last_error: null })).tone).toBe(tone);
  });

  it('says which side to update when sync is paused, and that there was no sync yet', () => {
    const chip = instanceChip(
      member({
        state: 'paused',
        last_sync_at: null,
        last_error: 'ns1 runs 0.7.1. Update this instance.',
      }),
    );
    expect(chip.title).toContain('run different versions');
    expect(chip.title).toContain('No sync yet');
    expect(chip.title).toContain('ns1 runs 0.7.1. Update this instance.');
  });

  it('is muted when a member has no sync report', () => {
    expect(instanceChip(member(null))).toMatchObject({ label: 'Member of ns1', tone: 'muted' });
  });
});

describe('sync wording', () => {
  it('has words for every state and for none', () => {
    expect(syncState({ state: 'offline' }).words).toBe('Cannot reach the controller');
    expect(syncState(null).value).toBe('Unknown');
    expect(lastSyncText({ last_sync_at: null })).toBe('No sync yet');
  });
});

describe('behindText', () => {
  it('puts the lag in words', () => {
    expect(behindText({ behind: 0, last_contact_at: '2026-11-21T11:59:00Z' })).toBe('Current');
    expect(behindText({ behind: 1, last_contact_at: '2026-11-21T11:59:00Z' })).toBe(
      '1 change behind',
    );
    expect(behindText({ behind: 3, last_contact_at: '2026-11-21T11:59:00Z' })).toBe(
      '3 changes behind',
    );
    expect(behindText({ behind: null, last_contact_at: null })).toBe('Not heard from yet');
    expect(behindText({ behind: null, last_contact_at: '2026-11-21T11:59:00Z' })).toBe('Unknown');
    expect(behindText({ is_controller: true, behind: null, last_contact_at: null })).toBe(
      EMPTY_CELL,
    );
  });
});

describe('DHCP wording', () => {
  const handover = { from_instance_id: 'i-ctl', from_name: 'ns1', since: '2026-11-21T11:59:15Z' };
  const rows = [
    { name: 'ns1', is_controller: true, dhcp: 'handing_over' },
    { name: 'ns2', dhcp: 'starting' },
    { name: 'ns3', dhcp: null },
  ];

  it('has words and a tone for each state, and nothing for the rest', () => {
    expect(dhcpState({ dhcp: 'serving', dhcp_state: 'serving' })).toEqual({
      tone: 'ok',
      words: 'On',
    });
    // Assigned, but the server did not say what it does.
    expect(dhcpState({ dhcp: 'serving' })).toEqual({ tone: 'info', words: 'Assigned' });
    expect(dhcpState({ dhcp: 'serving', dhcp_state: 'down' })).toEqual({
      tone: 'err',
      words: 'Not running',
    });
    expect(dhcpState({ dhcp: 'serving', dhcp_state: 'off' })).toMatchObject({
      tone: 'muted',
      words: 'Off',
    });
    // Assigned, but no interface of the box has DHCP on: nobody is answered.
    expect(dhcpState({ dhcp: 'serving', dhcp_state: 'no_interface' })).toMatchObject({
      tone: 'err',
      words: 'No interface',
      title: expect.stringContaining('Settings > General > Interfaces'),
    });
    expect(dhcpState({ dhcp: null, dhcp_state: 'off' })).toEqual({ tone: 'muted', words: 'Off' });
    expect(dhcpState({ dhcp: null, dhcp_state: 'serving' })).toMatchObject({
      tone: 'err',
      words: 'On, not assigned',
    });
    expect(dhcpState({ dhcp: 'starting' }, handover)).toEqual({
      tone: 'warn',
      words: 'Starting, waiting for ns1',
    });
    expect(dhcpState({ dhcp: 'starting' })).toEqual({ tone: 'warn', words: 'Starting' });
    expect(dhcpState({ dhcp: 'handing_over' }, handover)).toEqual({
      tone: 'warn',
      words: 'Handing over',
    });
    expect(dhcpState({ dhcp: null })).toBeNull();
    // A server older than moving DHCP says nothing, and so does a new word.
    expect(dhcpState({})).toBeNull();
    expect(dhcpState({ dhcp: 'paused' })).toBeNull();
  });

  it('names who DHCP clients are given as DNS servers, only when someone is left out', () => {
    expect(
      dnsHandoutLine({ limit: 3, served: ['ns1', 'ns2', 'ns3'], left_out: ['ns4', 'ns5'] }),
    ).toBe(
      'DHCP clients are given 3 instances as DNS servers: ns1, ns2, and ns3. ns4 and ns5 ' +
        'answer DNS but are not handed out, since clients use only the first 3.',
    );
    expect(
      dnsHandoutLine({ limit: 3, served: ['ns1', 'ns2', 'ns3'], left_out: ['ns4'] }),
    ).toContain('ns4 answers DNS but is not handed out');
    expect(dnsHandoutLine({ limit: 3, served: ['ns1'], left_out: [] })).toBeNull();
    expect(dnsHandoutLine(undefined)).toBeNull();
    // Out of contact: named, with when clients see the change.
    expect(
      dnsHandoutLine({ limit: 3, served: ['ns1', 'ns2'], left_out: [], withdrawn: ['ns3'] }),
    ).toBe(
      'DHCP clients are given 2 instances as DNS servers: ns1 and ns2. ns3 is out of contact ' +
        'and not handed out until it is back. Clients get the new list when they renew their lease.',
    );
    expect(
      dnsHandoutLine({
        limit: 1,
        served: ['ns1'],
        left_out: ['ns2'],
        withdrawn: ['ns3', 'ns4'],
      }),
    ).toBe(
      'DHCP clients are given 1 instance as DNS servers: ns1. ns2 answers DNS but is not handed ' +
        'out, since clients use only the first 1. ns3 and ns4 are out of contact and not handed ' +
        'out until they are back. Clients get the new list when they renew their lease.',
    );
  });

  it('has words for DNS, and nothing when it is not known', () => {
    expect(dnsState({ dns_state: 'serving' })).toEqual({ tone: 'ok', words: 'On' });
    expect(dnsState({ dns_state: 'off' })).toEqual({ tone: 'muted', words: 'Off' });
    expect(dnsState({ dns_state: 'down' })).toEqual({ tone: 'err', words: 'Not running' });
    expect(dnsState({ dns_state: null })).toBeNull();
    expect(dnsState({})).toBeNull();
  });

  it('finds the instance that serves', () => {
    expect(
      dhcpServer([
        { name: 'ns1', dhcp: null },
        { name: 'ns2', dhcp: 'serving' },
      ]).name,
    ).toBe('ns2');
    expect(dhcpServer(rows)).toBeNull();
  });

  it('names both ends of a handover, from the rows when the handover has no name', () => {
    expect(handoverNames(handover, rows)).toEqual({ from: 'ns1', to: 'ns2' });
    expect(handoverNames({ since: handover.since }, rows)).toEqual({ from: 'ns1', to: 'ns2' });
    expect(handoverNames(handover, [])).toEqual({ from: 'ns1', to: 'the new instance' });
  });

  it('counts the wait in seconds, then minutes, and never below zero', () => {
    expect(handoverWaited(handover)).toBe(45);
    expect(handoverText(handover, rows)).toBe(
      'DHCP is moving to ns2. Waiting for ns1 to hand over its leases, 45 seconds so far.',
    );
    const later = Date.parse('2026-11-21T12:02:30Z');
    expect(handoverText(handover, rows, later)).toBe(
      'DHCP is moving to ns2. Waiting for ns1 to hand over its leases, 3 minutes so far.',
    );
    expect(handoverWaited({ since: '2026-11-21T12:00:30Z' })).toBe(0);
    expect(handoverWaited({ since: 'not a time' })).toBe(0);
    expect(handoverWaited(null)).toBe(0);
  });

  it('says in the header chip that a member serves DHCP, and nothing on a controller', () => {
    const sync = { state: 'current', last_sync_at: '2026-11-21T11:59:00Z', last_error: null };
    expect(instanceChip({ ...member(sync), serves_dhcp: true }).title).toBe(
      'Member of ns1: Current with the controller\nLast sync 1m ago\nThis instance serves DHCP',
    );
    expect(instanceChip({ ...member(sync), serves_dhcp: false }).title).not.toContain('DHCP');
    expect(instanceChip(member(sync)).title).not.toContain('DHCP');
    expect(
      instanceChip({ mode: 'controller', members: 2, sync: null, serves_dhcp: true }).title,
    ).toBe('Controller of 2 members');
  });
});

describe('a change of controller', () => {
  const controller = (extra) => ({
    mode: 'controller',
    controller_name: null,
    members: 2,
    ...extra,
  });

  it('the chip says a controller was replaced, by name when it knows one', () => {
    const named = instanceChip(controller({ fenced: true, fenced_by: 'ns2' }));
    expect(named).toMatchObject({ label: 'Replaced by ns2', tone: 'err', state: 'Replaced' });
    expect(named.title).toBe(
      'Replaced by ns2. This instance takes no changes.\nRejoin it as a member under Settings > System > Instances.',
    );
    expect(instanceChip(controller({ fenced: true })).label).toBe('Replaced by another controller');
    // Shown whatever the member count says: its list is out of date.
    expect(instanceChip(controller({ fenced: true, members: 0 })).tone).toBe('err');
    expect(replacedBy(null)).toBe('Replaced by another controller');
  });

  it('the chip says a controller is handing over, and to which member', () => {
    const chip = instanceChip(controller({ handover_to: 'ns2' }));
    expect(chip).toMatchObject({ label: 'Handing over to ns2', tone: 'warn', state: 'Frozen' });
    expect(chip.title).toBe(
      'ns2 is becoming the controller. No changes can be made until it is done.',
    );
  });

  it('the chip is as before for a server that says neither', () => {
    expect(instanceChip(controller({})).label).toBe('Controller');
    expect(instanceChip(controller({ fenced: false, handover_to: null })).label).toBe('Controller');
    expect(instanceChip({ ...member(null), handover_to: 'ns3' }).label).toBe('Member of ns1');
  });

  it('says what replaced a controller and since when, in two sentences', () => {
    const text = fencedText({ by_name: 'ns2', since: '2026-11-21T11:00:00Z', report: true });
    expect(text).toMatch(
      /^ns2 replaced this instance as the controller\. This instance has taken no changes since .+, and its data is out of date\.$/,
    );
    expect(fencedText({ by_name: null, since: null })).toBe(
      'Another instance replaced this instance as the controller. This instance takes no changes, and its data is out of date.',
    );
  });

  it('names the instance that reported the replacement when it is not the new controller', () => {
    const fenced = { by_name: 'ns2', since: null };
    expect(fencedText({ ...fenced, told_by: 'ns3' })).toBe(
      'ns2 replaced this instance as the controller. This instance takes no changes, and its data is out of date. ns3 reported it.',
    );
    expect(fencedText({ ...fenced, told_by: 'ns2' })).not.toContain('reported it');
    expect(fencedText({ ...fenced, told_by: null })).not.toContain('reported it');
    expect(fencedText({ by_name: null, since: null, told_by: 'ns3' })).toContain(
      'Another instance replaced this instance as the controller.',
    );
    expect(fencedText({ by_name: null, since: null, told_by: 'ns3' })).toMatch(
      / ns3 reported it\.$/,
    );
  });

  it('says what taking the controller back loses, or nothing when it knows neither end', () => {
    expect(takeBackLossText({ by_name: 'ns2', since: '2026-11-21T11:00:00Z' })).toMatch(
      /^Changes made on ns2 since .+ are lost unless it comes back and you enter them again\.$/,
    );
    expect(takeBackLossText({ by_name: 'ns2', since: null })).toBe(
      'Changes made on ns2 are lost unless it comes back and you enter them again.',
    );
    expect(takeBackLossText({ by_name: null, since: '2026-11-21T11:00:00Z' })).toMatch(
      /^Changes made on the other controller since .+ are lost unless/,
    );
    expect(takeBackLossText({ by_name: null, since: null })).toBe('');
    expect(takeBackLossText(null)).toBe('');
  });

  it('counts the wait of a handover of the controller role', () => {
    const handover = { to_instance_id: 'i-m2', to_name: 'ns2', since: '2026-11-21T11:59:15Z' };
    expect(promotionText(handover)).toBe(
      'Handing over to ns2. Waiting for it to catch up and take over, 45 seconds so far.',
    );
    expect(promotionText({ ...handover, since: '2026-11-21T11:57:00Z' })).toContain(
      '3 minutes so far',
    );
    expect(promotionText({ since: '2026-11-21T12:00:00Z' })).toContain(
      'Handing over to the new controller.',
    );
  });

  it('says what this box is restarting as', () => {
    expect(restartingText({ mode: 'controller' })).toBe(
      'Restarting as the controller. The sign-in page opens when it is back.',
    );
    expect(restartingText({ mode: 'member', name: 'ns2' })).toBe(
      'Restarting as a member of ns2. The sign-in page opens when it is back.',
    );
    expect(restartingText({ mode: 'member', name: null })).toContain('Restarting as a member.');
  });
});
