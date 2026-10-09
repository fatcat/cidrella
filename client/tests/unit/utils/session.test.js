/**
 * The sign-in page's line about why the last session ended: remembered once,
 * shown once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { rememberSignOut, takeSignOutMessage } from '../../../src/utils/session.js';

beforeEach(() => sessionStorage.clear());

describe('sign-out reasons', () => {
  it('names the inactivity limit in minutes', () => {
    rememberSignOut('idle', 1800);
    expect(takeSignOutMessage()).toBe('Signed out after 30 minutes without activity.');
  });

  it('is shown once', () => {
    rememberSignOut('expired');
    expect(takeSignOutMessage()).toMatch(/24 hour limit/);
    expect(takeSignOutMessage()).toBeNull();
  });

  it.each([
    ['password_changed', /password was changed/],
    ['password_reset', /reset your password/],
    ['role_changed', /role was changed/],
    ['restore', /backup was restored/],
    ['something-new', /session ended/],
  ])('explains %s', (reason, text) => {
    rememberSignOut(reason);
    expect(takeSignOutMessage()).toMatch(text);
  });

  it('says nothing when nothing ended a session', () => {
    expect(takeSignOutMessage()).toBeNull();
  });
});
