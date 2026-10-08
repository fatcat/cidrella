import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { useAutoRefresh } from '../../../src/composables/useAutoRefresh.js';

function mountWithRefresh(fn, interval) {
  return mount({
    setup() {
      useAutoRefresh(fn, interval);
      return () => null;
    },
  });
}

describe('useAutoRefresh', () => {
  it('runs on every tick while the tab is visible and stops on unmount', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const fn = vi.fn();
      const wrapper = mountWithRefresh(fn, 1000);
      vi.advanceTimersByTime(3000);
      expect(fn).toHaveBeenCalledTimes(3);
      wrapper.unmount();
      vi.advanceTimersByTime(3000);
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the tick while the tab is hidden and resumes when it is shown', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const hidden = vi.spyOn(globalThis.document, 'hidden', 'get');
    try {
      const fn = vi.fn();
      mountWithRefresh(fn, 1000);
      hidden.mockReturnValue(true);
      vi.advanceTimersByTime(3000);
      expect(fn).not.toHaveBeenCalled();
      // Nobody was reading it; the next visible tick catches up.
      hidden.mockReturnValue(false);
      vi.advanceTimersByTime(1000);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      hidden.mockRestore();
      vi.useRealTimers();
    }
  });
});
