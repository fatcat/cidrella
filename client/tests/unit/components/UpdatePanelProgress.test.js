import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
const toast = { add: vi.fn() };
let statusPayload;
let statusHandler;
let healthHandler;

vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));

const { default: UpdatePanel } = await import('../../../src/views/UpdatePanel.vue');

function stepStates(wrapper) {
  return wrapper.findAll('.update-step').map((el) => el.attributes('data-step-state'));
}

describe('UpdatePanel progress steps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusPayload = { state: 'idle' };
    statusHandler = () => Promise.resolve({ data: statusPayload });
    healthHandler = () => Promise.resolve({ data: { ok: true } });
    api.get.mockImplementation((url) => {
      if (url === '/version') {
        return Promise.resolve({
          data: { version: '0.5.0', updateAvailable: '0.5.1', updateCheckEnabled: true },
        });
      }
      if (url === '/version/update-status') return statusHandler();
      if (url === '/health') return healthHandler();
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks off the phases update.sh actually reports', async () => {
    statusPayload = {
      state: 'snapshotting',
      progress_pct: 80,
      message: 'Snapshotting databases...',
    };
    const wrapper = mount(UpdatePanel);
    await flushPromises();

    expect(stepStates(wrapper)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'active',
      'pending',
      'pending',
    ]);
    expect(wrapper.find('.step-message').text()).toBe('Snapshotting databases...');
    wrapper.unmount();
  });

  it('falls back to the percentage for a state name it does not know', async () => {
    statusPayload = { state: 'some_future_phase', progress_pct: 60 };
    const wrapper = mount(UpdatePanel);
    await flushPromises();

    expect(stepStates(wrapper)[3]).toBe('active');
    expect(stepStates(wrapper)[2]).toBe('done');
    wrapper.unmount();
  });

  it('marks the phase that failed', async () => {
    statusPayload = { state: 'failed', progress_pct: 93, error: 'Health probe failed' };
    const wrapper = mount(UpdatePanel);
    await flushPromises();

    expect(stepStates(wrapper)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'failed']);
    wrapper.unmount();
  });

  it('keeps polling after the restart and reloads once the update completes', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { reload },
    });

    statusPayload = { state: 'switching', progress_pct: 90, message: 'Restarting CIDRella...' };
    const wrapper = mount(UpdatePanel);
    await flushPromises();
    expect(stepStates(wrapper)[5]).toBe('active');

    // The server goes away for the restart: the poll fails, health is not back yet.
    statusHandler = () => Promise.reject(new Error('ECONNREFUSED'));
    healthHandler = () => Promise.reject(new Error('ECONNREFUSED'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper.text()).toContain('restarting with the new version');
    expect(stepStates(wrapper)[5]).toBe('active');

    // Back up, still confirming health. Polling must resume on its own.
    healthHandler = () => Promise.resolve({ data: { ok: true } });
    statusPayload = { state: 'confirming', progress_pct: 93, message: 'Confirming...' };
    statusHandler = () => Promise.resolve({ data: statusPayload });
    await vi.advanceTimersByTimeAsync(3000);
    expect(stepStates(wrapper)[6]).toBe('active');

    statusPayload = {
      state: 'completed',
      progress_pct: 100,
      from_version: '0.5.0',
      to_version: '0.5.1',
    };
    await vi.advanceTimersByTimeAsync(2000);
    expect(stepStates(wrapper).every((s) => s === 'done')).toBe(true);
    expect(wrapper.text()).toContain('Reloading in 5s');
    expect(wrapper.find('[data-track="update-reload-now"]').exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    expect(reload).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('does not reload for a completed update it did not watch', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { reload } });

    statusPayload = {
      state: 'completed',
      progress_pct: 100,
      from_version: '0.5.0',
      to_version: '0.5.1',
    };
    const wrapper = mount(UpdatePanel);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10000);

    expect(reload).not.toHaveBeenCalled();
    expect(wrapper.find('[data-track="update-dismiss"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
