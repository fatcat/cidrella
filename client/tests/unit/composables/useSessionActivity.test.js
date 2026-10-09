/**
 * Inactivity sign-out on the client: input is reported at most once a minute
 * and only after input, other tabs' input counts, and the warnings come 60
 * seconds before the inactivity limit and 5 minutes before the 24 hours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const { api } = vi.hoisted(() => ({ api: { post: vi.fn(), get: vi.fn() } }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const { useAuthStore } = await import('../../../src/stores/auth.js');
const { useSessionActivity } = await import('../../../src/composables/useSessionActivity.js');

const MINUTE = 60 * 1000;
const times = (idleMinutes, idleRemaining = idleMinutes * 60, expiresIn = 24 * 60 * 60) => ({
  idle_timeout_seconds: idleMinutes * 60,
  idle_remaining_seconds: idleMinutes ? idleRemaining : null,
  expires_in_seconds: expiresIn,
});

let auth;
let wrappers = [];

function host() {
  let state;
  const wrapper = mount({
    setup() {
      state = useSessionActivity();
      return () => null;
    },
  });
  wrappers.push(wrapper);
  return state;
}

const press = () =>
  globalThis.window.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'a' }));
// BroadcastChannel delivers on the real event loop, not on a fake timer.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  setActivePinia(createPinia());
  auth = useAuthStore();
  auth.token = 'token';
  api.post.mockReset().mockResolvedValue({ data: times(15) });
  api.get.mockReset().mockResolvedValue({ data: times(15) });
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers = [];
  vi.useRealTimers();
});

describe('reporting activity', () => {
  it('reports nothing when nobody touches the page', () => {
    auth.applySessionTimes(times(60));
    host();
    vi.advanceTimersByTime(5 * MINUTE);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('reports input at most once a minute', async () => {
    auth.applySessionTimes(times(60));
    host();
    for (let second = 0; second < 150; second += 1) {
      press();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.post).toHaveBeenCalledWith('/auth/activity');
  });

  it("counts another tab's input, and lets the tab that reported speak for all", async () => {
    auth.applySessionTimes(times(60));
    host();
    const otherTab = new BroadcastChannel('cidrella-session');
    otherTab.postMessage({ type: 'input', at: Date.now() + 1 });
    await settle();
    vi.advanceTimersByTime(MINUTE + 1000);
    expect(api.post).toHaveBeenCalledTimes(1);

    otherTab.postMessage({ type: 'times', times: times(15, 900) });
    otherTab.postMessage({ type: 'input', at: Date.now() + 1 });
    await settle();
    vi.advanceTimersByTime(30 * 1000);
    expect(api.post).toHaveBeenCalledTimes(1);
    otherTab.close();
  });
});

describe('warnings', () => {
  it('warns 60 seconds before the inactivity limit, and input reports at once', () => {
    auth.applySessionTimes(times(15, 2 * 60));
    const state = host();
    vi.advanceTimersByTime(59 * 1000);
    expect(state.idleWarning.value).toBe(false);
    vi.advanceTimersByTime(2 * 1000);
    expect(state.idleWarning.value).toBe(true);
    expect(state.idleSecondsLeft.value).toBeLessThanOrEqual(60);
    press();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('asks the server once a deadline has passed', () => {
    auth.applySessionTimes(times(15, 10));
    host();
    vi.advanceTimersByTime(11 * 1000);
    expect(api.get).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * 1000);
    expect(api.get).toHaveBeenCalledWith('/auth/session');
  });

  it('with no inactivity limit, still warns 5 minutes before the 24 hours', () => {
    auth.applySessionTimes(times(0, null, 10 * 60));
    const state = host();
    vi.advanceTimersByTime(4 * MINUTE);
    expect(state.idleWarning.value).toBe(false);
    expect(state.expiryWarning.value).toBe(false);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(state.expiryWarning.value).toBe(true);
    state.dismissExpiry();
    expect(state.expiryWarning.value).toBe(false);
  });

  it('shows nothing while signed out', () => {
    auth.token = null;
    const state = host();
    vi.advanceTimersByTime(30 * MINUTE);
    expect(state.idleWarning.value).toBe(false);
    expect(state.expiryWarning.value).toBe(false);
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('signing out', () => {
  it('ends the session on the server, then here, and remembers nothing to explain', async () => {
    auth.applySessionTimes(times(15));
    const state = host();
    api.post.mockResolvedValue({ data: { ok: true } });
    await state.signOutNow();
    expect(api.post).toHaveBeenCalledWith('/auth/logout');
    expect(auth.token).toBeNull();
    expect(auth.session).toBeNull();
  });
});
