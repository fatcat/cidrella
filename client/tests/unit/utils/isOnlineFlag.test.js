/**
 * The single liveness coercion, and its agreement with the server.
 *
 * `is_online` was coerced four different ways: plain truthiness in
 * displayOnlineStatus, a strict two-state test in ipLifecycleDisplay.js, a
 * strict three-state one in DhcpPanel.vue, and an inline ternary in
 * IpDetailsDrawer.vue. The string '0' is truthy in JavaScript, so an offline
 * host read as "Online" in the column while the pill beside it read offline.
 *
 * String flags are not hypothetical here: ipLifecycleDisplay.test.js has a case
 * literally named "even when flags arrive as strings".
 *
 * See REVIEW.md, duplicate-logic audit #48.
 */
import { describe, it, expect } from 'vitest';
import { isOnlineFlag, displayOnlineStatus, EMPTY_CELL } from '../../../src/utils/format.js';

// truthy() from server/src/models/ip-view.js, duplicated here on purpose so a
// change to either side of that boundary shows up as a failing assertion rather
// than as two screens disagreeing. The server cannot be imported from a client
// test, which is exactly why this is pinned rather than shared.
const serverTruthy = (v) => v === true || v === 1 || v === '1';

describe('isOnlineFlag', () => {
  it('reads every online spelling the API can send', () => {
    expect(isOnlineFlag(true)).toBe(true);
    expect(isOnlineFlag(1)).toBe(true);
    expect(isOnlineFlag('1')).toBe(true);
  });

  it("treats the STRING '0' as offline, which plain truthiness got wrong", () => {
    // This is the bug. `'0' ? 'Online' : 'Offline'` yields 'Online'.
    expect(isOnlineFlag('0')).toBe(false);
    expect(displayOnlineStatus('0').label).toBe('Offline');
  });

  it('reads every offline spelling', () => {
    expect(isOnlineFlag(false)).toBe(false);
    expect(isOnlineFlag(0)).toBe(false);
    expect(isOnlineFlag('0')).toBe(false);
  });

  it('keeps unknown distinct from offline', () => {
    // "never seen" and "down" are different facts and render differently.
    expect(isOnlineFlag(null)).toBe(null);
    expect(isOnlineFlag(undefined)).toBe(null);
    expect(displayOnlineStatus(null).known).toBe(false);
    expect(displayOnlineStatus(null).label).toBe(EMPTY_CELL);
    expect(displayOnlineStatus(false).known).toBe(true);
    expect(displayOnlineStatus(false).label).toBe('Offline');
  });

  it('agrees with the server truthy() on every value that reaches both', () => {
    for (const v of [true, false, 1, 0, '1', '0', null, undefined, '', 'yes', 2]) {
      expect(isOnlineFlag(v) === true, `is_online=${JSON.stringify(v)}`).toBe(serverTruthy(v));
    }
  });
});
