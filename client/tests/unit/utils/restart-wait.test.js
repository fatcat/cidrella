import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForRestart } from '../../../src/utils/restart-wait.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settled = (promise) => {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  return () => done;
};

describe('waitForRestart', () => {
  it('waits for the service to go away and answer again', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 200 })
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ status: 401 });
    vi.stubGlobal('fetch', fetch);
    const done = settled(waitForRestart());
    await vi.advanceTimersByTimeAsync(1500);
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(done()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('carries on when the service is never seen going', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    const done = settled(waitForRestart({ goneWithinMs: 5000 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(done()).toBe(true);
  });

  it('stops waiting for a service that does not come back', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const done = settled(waitForRestart({ backWithinMs: 10_000 }));
    await vi.advanceTimersByTimeAsync(9000);
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(done()).toBe(true);
  });
});
