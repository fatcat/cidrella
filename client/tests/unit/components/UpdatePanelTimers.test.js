// The Updates panel's timers stop with the panel. Each one starts after a
// request comes back; a request still out when the panel closed used to start
// its timer after the cleanup had run, leaving a status poll every two
// seconds for the life of the tab, or a page reload from another page.
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
const toast = { add: vi.fn() };

vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));

const { default: UpdatePanel } = await import('../../../src/views/UpdatePanel.vue');

// Requests wait until the test answers them.
let pending;
const out = (url) => pending.filter((read) => read.url === url);
function answer(url, reply) {
  for (const read of out(url)) {
    pending.splice(pending.indexOf(read), 1);
    if (reply instanceof Error) read.reject(reply);
    else read.resolve({ data: reply });
  }
}
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};
const VERSION = {
  version: '0.5.0',
  updateAvailable: null,
  updateCheckEnabled: true,
  updateChain: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  pending = [];
  api.get.mockImplementation(
    (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

// Timers the test environment already holds are not the panel's; the panel
// is judged by what it adds to them.
let baseline;
const panelTimers = () => vi.getTimerCount() - baseline;
function mountPanel() {
  baseline = vi.getTimerCount();
  return mount(UpdatePanel, {
    global: { stubs: { Dialog: true, ConfirmDialog: true }, directives: { tooltip: () => {} } },
  });
}

describe('Updates panel timers', () => {
  it('starts no poll when it closes before its first reads answer', async () => {
    const wrapper = mountPanel();
    wrapper.unmount();
    answer('/version', VERSION);
    await settle();
    answer('/version/update-status', { state: 'installing' });
    await settle();
    // A poll would ask again within two seconds, and keep its interval.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(out('/version/update-status')).toEqual([]);
    expect(panelTimers()).toBe(0);
  });

  it('polls while it is open during an update, and stops when it closes', async () => {
    const wrapper = mountPanel();
    answer('/version', VERSION);
    await settle();
    answer('/version/update-status', { state: 'installing' });
    await settle();
    expect(panelTimers()).toBe(1);
    wrapper.unmount();
    expect(panelTimers()).toBe(0);
  });

  it('starts no reconnect when a poll out at close finds the server gone', async () => {
    const wrapper = mountPanel();
    answer('/version', VERSION);
    await settle();
    answer('/version/update-status', { state: 'installing' });
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(out('/version/update-status')).toHaveLength(1);
    wrapper.unmount();
    answer('/version/update-status', new Error('restarting'));
    await settle();
    expect(panelTimers()).toBe(0);
  });

  it('starts no poll when the server comes back after it closed', async () => {
    const wrapper = mountPanel();
    answer('/version', VERSION);
    await settle();
    answer('/version/update-status', { state: 'installing' });
    await settle();
    // The restart: the next poll fails and the panel starts reconnecting.
    await vi.advanceTimersByTimeAsync(2000);
    answer('/version/update-status', new Error('restarting'));
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(out('/health')).toHaveLength(1);
    wrapper.unmount();
    // The probe out at close answers: the server is back, still updating.
    answer('/health', { ok: true });
    await settle();
    answer('/version', VERSION);
    await settle();
    answer('/version/update-status', { state: 'installing' });
    await settle();
    expect(panelTimers()).toBe(0);
  });

  it('schedules no reload when the update completes after it closed', async () => {
    const wrapper = mountPanel();
    answer('/version', VERSION);
    await settle();
    answer('/version/update-status', { state: 'installing' });
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    wrapper.unmount();
    answer('/version/update-status', { state: 'completed' });
    await settle();
    expect(panelTimers()).toBe(0);
  });
});
