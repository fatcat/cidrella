import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = {
  startResolverTest: vi.fn(),
  getResolverTest: vi.fn(),
  cancelResolverTest: vi.fn(),
};
vi.mock('../../../../src/stores/dns.js', () => ({ useDnsStore: () => store }));

const { default: ResolverTestDialog } =
  await import('../../../../src/components/dns/ResolverTestDialog.vue');

const stubs = {
  Dialog: { template: '<section><slot /><slot name="footer" /></section>' },
  ProgressBar: { props: ['value'], template: '<progress :value="value" />' },
  DataTable: {
    props: ['value'],
    template: '<table><tr><slot /></tr></table>',
  },
  // One result row in these tests: each column renders it.
  Column: { template: '<td><slot name="body" :data="$parent.$props.value[0]" /></td>' },
  Button: {
    props: ['label'],
    emits: ['click'],
    template:
      '<button :data-track="$attrs[\'data-track\']" @click="$emit(\'click\')">{{ label }}</button>',
  },
};

const ROW = (over) => ({
  id: 'quad9',
  label: 'Quad9',
  hostname: 'dns10.quad9.net',
  addresses: ['9.9.9.10'],
  preset: true,
  cached: { count: 15, p50: 12.4, p95: 30 },
  uncached: { count: 15, p50: 80, p95: 140 },
  failed: 0,
  sent: 30,
  fastest: true,
  last_problem: null,
  ...over,
});

const mountDialog = (props = {}) =>
  mount(ResolverTestDialog, {
    props: { visible: true, mode: 'tls', custom: [], ...props },
    global: { stubs },
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  store.startResolverTest.mockResolvedValue({ id: 'run-1' });
});
afterEach(() => vi.useRealTimers());

describe('ResolverTestDialog', () => {
  it('starts a run for the mode and the custom resolvers when it opens', async () => {
    const custom = [{ addresses: ['192.168.1.53'] }];
    store.getResolverTest.mockResolvedValue({ state: 'running', progress_pct: 40, results: [] });
    const wrapper = mountDialog({ mode: 'off', custom });
    await flushPromises();
    expect(store.startResolverTest).toHaveBeenCalledWith('off', custom);
    expect(wrapper.text()).toContain('plain DNS');

    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getResolverTest).toHaveBeenCalledWith('run-1');
    expect(wrapper.find('progress').attributes('value')).toBe('40');
  });

  it('shows the results and emits a pick', async () => {
    store.getResolverTest.mockResolvedValue({
      state: 'done',
      progress_pct: 100,
      results: [ROW()],
    });
    const wrapper = mountDialog();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);

    expect(wrapper.text()).toContain('12 / 30 ms');
    expect(wrapper.text()).toContain('80 / 140 ms');
    expect(wrapper.text()).toContain('0 of 30');
    expect(wrapper.text()).toContain('Fastest');
    expect(wrapper.text()).toContain('dns10.quad9.net · 9.9.9.10');

    await wrapper.find('[data-track="resolver-test-use-backup"]').trigger('click');
    expect(wrapper.emitted('pick')).toEqual([['backup', ROW()]]);
    // Done: no more polling.
    store.getResolverTest.mockClear();
    await vi.advanceTimersByTimeAsync(6000);
    expect(store.getResolverTest).not.toHaveBeenCalled();
  });

  it('cancels a running test on close', async () => {
    store.getResolverTest.mockResolvedValue({ state: 'running', progress_pct: 5, results: [] });
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.find('[data-track="resolver-test-cancel"]').trigger('click');
    await flushPromises();
    expect(store.cancelResolverTest).toHaveBeenCalledWith('run-1');
    expect(wrapper.emitted('update:visible')).toEqual([[false]]);
  });

  it('says why a run could not start', async () => {
    store.startResolverTest.mockRejectedValue({
      response: { status: 400, data: { error: 'mode must be off, tls, or https' } },
    });
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.find('.field-error').text()).toBe('mode must be off, tls, or https');
  });

  const busy = (mode) => ({
    response: {
      status: 409,
      data: { error: 'A resolver test is already running', id: 'run-0', mode },
    },
  });

  it('follows a test of the same mode that is already running', async () => {
    store.startResolverTest.mockRejectedValue(busy('tls'));
    store.getResolverTest.mockResolvedValue({ state: 'running', progress_pct: 70, results: [] });
    const wrapper = mountDialog({ mode: 'tls' });
    await flushPromises();
    expect(store.getResolverTest).toHaveBeenCalledWith('run-0');
    expect(wrapper.find('progress').attributes('value')).toBe('70');
    expect(wrapper.find('.field-error').exists()).toBe(false);
  });

  it('names a test of another mode that is already running', async () => {
    store.startResolverTest.mockRejectedValue(busy('https'));
    const wrapper = mountDialog({ mode: 'off' });
    await flushPromises();
    expect(wrapper.find('.field-error').text()).toBe(
      'A DNS-over-HTTPS test is already running. It ends within a minute.',
    );
    expect(store.getResolverTest).not.toHaveBeenCalled();
  });
});
