/**
 * The wording for instances: the header chip's three cases (a single box, a
 * controller with members, a member with its sync state), and how far behind
 * a member is, in words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { behindText, instanceChip, lastSyncText, syncState } from '../../../src/utils/instances.js';
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
