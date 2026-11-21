/**
 * The instance filter of the Analytics pages: absent on a single box, and on
 * a controller with members a select beside the range that every read
 * follows and this browser remembers. With every instance together, a p95 is
 * shown as the highest instance's own, never merged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('vue-chartjs', () => ({
  Line: { name: 'Line', props: ['data'], template: '<div class="line-stub" />' },
}));

const { default: Performance } = await import('../../../src/views/Performance.vue');
const { useFeaturesStore } = await import('../../../src/stores/features.js');

const NS1 = '11111111-1111-4111-8111-111111111111';
const NS2 = '22222222-2222-4222-8222-222222222222';
const INSTANCES = [
  { instance_id: NS1, name: 'ns1', is_self: true },
  { instance_id: NS2, name: 'ns2', is_self: false },
];

const minute = (extra = {}) => ({
  ts: 1789900000,
  query_count: 20,
  latency_min: 3000,
  latency_avg: 8000,
  latency_p95: 17000,
  latency_max: 90000,
  cache_hits: 14,
  cache_misses: 6,
  timeouts: 0,
  pending_queries: 2,
  cpu_percent: 12.4,
  rss_mb: 210.4,
  heap_mb: 90.2,
  ...extra,
});

function respond(url, config = {}) {
  if (url === '/analytics/instances') return Promise.resolve({ data: INSTANCES });
  if (url === '/metrics/proxy-perf') {
    if (config.params?.by === 'instance') {
      return Promise.resolve({
        data: [
          { instance_id: NS1, name: 'ns1', rows: [minute()] },
          { instance_id: NS2, name: 'ns2', rows: [minute({ latency_p95: 42000, rss_mb: 300 })] },
        ],
      });
    }
    // Merged: what one proxy owns is empty for a minute two instances measured.
    const merged = { latency_p95: null, cpu_percent: null, rss_mb: null, heap_mb: null };
    return Promise.resolve({
      data: [minute(config.params?.instance ? {} : { query_count: 40, ...merged })],
    });
  }
  if (url === '/health/system') return Promise.resolve({ data: { cpu: { cores: 2 } } });
  if (url === '/metrics/services') return Promise.resolve({ data: {} });
  return Promise.resolve({ data: [] });
}

async function mountPage(members) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useFeaturesStore().set({ instance: { mode: 'controller', members } });
  const wrapper = mount(Performance, {
    global: {
      plugins: [pinia],
      stubs: {
        Select: {
          props: ['modelValue', 'options'],
          emits: ['update:modelValue'],
          template:
            '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
        },
        Button: { template: '<button><slot /></button>' },
      },
    },
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

const reads = (url) => api.get.mock.calls.filter(([u]) => u === url).map(([, c]) => c?.params);
const select = (w) => w.find('[data-track="performance-instance"]');
const figure = (w, label) =>
  w
    .findAll('.fig')
    .find((n) => n.find('.label').text() === label)
    .text()
    .replace(/\s+/g, ' ');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.get.mockImplementation(respond);
});

describe('the Analytics instance filter', () => {
  it('is not there on a single box, and its reads name no instance', async () => {
    const wrapper = await mountPage(0);

    expect(select(wrapper).exists()).toBe(false);
    expect(wrapper.find('[data-track="performance-range"]').exists()).toBe(true);
    expect(reads('/analytics/instances')).toEqual([]);
    expect(reads('/metrics/proxy-perf')).toEqual([{ range: '24h' }]);
    expect(reads('/metrics/forwarder')).toEqual([{ range: '24h' }]);
  });

  it('lists every instance once there are members, all of them first', async () => {
    const wrapper = await mountPage(1);

    expect(select(wrapper).exists()).toBe(true);
    expect(
      select(wrapper)
        .findAll('option')
        .map((o) => o.text()),
    ).toEqual(['All instances', 'ns1', 'ns2']);
    expect(select(wrapper).element.value).toBe('all');
    expect(reads('/analytics/instances')).toHaveLength(1);
    // Every instance: the merged rows, and each instance's own beside them.
    expect(reads('/metrics/proxy-perf')).toEqual([
      { range: '24h' },
      { range: '24h', by: 'instance' },
    ]);
  });

  it('shows a p95 as the highest instance’s own when every instance is selected', async () => {
    const wrapper = await mountPage(1);

    expect(figure(wrapper, 'p95 latency')).toContain('42ms');
    expect(figure(wrapper, 'p95 latency')).toContain('highest of 2 instances: ns2');
    expect(figure(wrapper, 'Memory')).toContain('highest of 2 instances: ns2');
    // Counts are the sum the server made.
    expect(figure(wrapper, 'Queries per minute')).toContain('40');
  });

  it('sends the chosen instance with every read, and remembers it', async () => {
    const wrapper = await mountPage(1);
    api.get.mockClear();

    await select(wrapper).setValue(NS2);
    await flushPromises();

    expect(reads('/metrics/proxy-perf')).toEqual([{ range: '24h', instance: NS2 }]);
    expect(reads('/metrics/forwarder')).toEqual([{ range: '24h', instance: NS2 }]);
    expect(reads('/metrics/dns-failures')).toEqual([{ range: '24h', instance: NS2 }]);
    // One instance: its own p95, as a single box shows it.
    expect(figure(wrapper, 'p95 latency')).toContain('17ms');
    expect(figure(wrapper, 'p95 latency')).not.toContain('highest');

    wrapper.unmount();
    api.get.mockClear();
    const again = await mountPage(1);
    expect(select(again).element.value).toBe(NS2);
    expect(reads('/metrics/proxy-perf')).toEqual([{ range: '24h', instance: NS2 }]);
  });

  it('falls back to every instance when the remembered one is gone', async () => {
    localStorage.setItem('cidrella_analytics_instance', JSON.stringify('gone'));

    const wrapper = await mountPage(1);

    expect(select(wrapper).element.value).toBe('all');
    expect(reads('/metrics/forwarder')).toEqual([{ range: '24h' }]);
  });

  it('ignores a remembered instance on a box that has no members now', async () => {
    localStorage.setItem('cidrella_analytics_instance', JSON.stringify(NS2));

    const wrapper = await mountPage(0);

    expect(select(wrapper).exists()).toBe(false);
    expect(reads('/metrics/proxy-perf')).toEqual([{ range: '24h' }]);
  });
});
