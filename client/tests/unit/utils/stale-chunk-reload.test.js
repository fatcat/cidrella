import { describe, expect, it, vi } from 'vitest';
import {
  installStaleChunkReload,
  RELOAD_GUARD_MS,
  RELOAD_KEY,
} from '../../../src/utils/stale-chunk-reload.js';

function fakeWindow() {
  const store = new Map();
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    dispatch() {
      const event = new Event('vite:preloadError', { cancelable: true });
      target.dispatchEvent(event);
      return event;
    },
    sessionStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
    location: { reload: vi.fn() },
    store,
  };
}

describe('stale chunk reload', () => {
  it('reloads once when a chunk from an older build is missing', () => {
    const win = fakeWindow();
    let clock = 1_000_000;
    installStaleChunkReload(win, () => clock);
    const event = win.dispatch();
    expect(event.defaultPrevented).toBe(true);
    expect(win.location.reload).toHaveBeenCalledTimes(1);
    expect(win.store.get(RELOAD_KEY)).toBe(String(clock));
  });

  it('lets the error surface when the reload did not help', () => {
    const win = fakeWindow();
    let clock = 1_000_000;
    win.store.set(RELOAD_KEY, String(clock - 2_000));
    installStaleChunkReload(win, () => clock);
    const event = win.dispatch();
    expect(event.defaultPrevented).toBe(false);
    expect(win.location.reload).not.toHaveBeenCalled();
    // A later deploy gets its own reload.
    clock += RELOAD_GUARD_MS;
    win.dispatch();
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing without session storage, so it cannot loop', () => {
    const win = fakeWindow();
    win.sessionStorage.getItem = () => {
      throw new Error('blocked');
    };
    installStaleChunkReload(win);
    expect(win.dispatch().defaultPrevented).toBe(false);
    expect(win.location.reload).not.toHaveBeenCalled();
  });
});
