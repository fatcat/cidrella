import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('vue-chartjs', () => ({
  Line: { name: 'Line', props: ['data'], template: '<div class="line-stub" />' },
}));

const { default: Performance } = await import('../../../src/views/Performance.vue');

const minute = (i, extra = {}) => ({
  ts: 1789900000 + i * 60,
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

let payloads;

function respond(url) {
  const path = url.split('?')[0];
  if (path in payloads) return Promise.resolve({ data: payloads[path] });
  return Promise.reject(new Error(`Unexpected GET ${url}`));
}

async function mountPage() {
  const wrapper = mount(Performance, {
    global: {
      plugins: [createPinia()],
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

const text = (w, sel) => w.findAll(sel).map((n) => n.text().replace(/\s+/g, ' '));

describe('Performance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    payloads = {
      '/metrics/proxy-perf': [
        minute(0),
        minute(1, {
          latency_p95: 19000,
          cache_hits: 7,
          cache_misses: 3,
          timeouts: 2,
          cpu_percent: 61,
        }),
      ],
      '/metrics/services': {
        dnsmasq: false,
        geoip_proxy: true,
        geoip_bypassed: false,
        forwarders: [{ ip: '9.9.9.9', reachable: true }],
      },
      '/health/system': { cpu: { cores: 8 } },
    };
    api.get.mockImplementation(respond);
  });

  it('shows the service chips, the seven figures and a legend per chart', async () => {
    const w = await mountPage();
    expect(text(w, '.status-rail .chip')).toEqual([
      'dnsmasq Stopped',
      'DNS proxy Running',
      'Forwarders 1 of 1',
    ]);
    expect(text(w, '.fig .label')).toEqual([
      'Queries per minute',
      'p95 latency',
      'Cache hit rate',
      'Timeouts',
      'Peak pending',
      'CPU',
      'Memory',
    ]);
    // 40 queries over 2 minutes; p95 averages the two minutes; 21 of 30 hit.
    expect(text(w, '.fig .value')).toEqual(['20', '18ms', '70%', '2', '2', '61%', '210MB']);
    expect(w.findAll('.fig')[3].classes()).toContain('warn');
    expect(w.findAll('.fig')[5].classes()).toContain('warn');
    expect(text(w, '.fig .sub')[5]).toBe('of one core · avg 36.7%');
    expect(w.findAll('.panel-note')[0].text()).toBe('last 24 hours · 40 queries in 2 samples');
    expect(w.findAll('.panel-note')[4].text()).toContain('the host has 8');

    expect(text(w, '.series-chart .chip')).toEqual([
      'Avg 8ms',
      'p95 18ms',
      'Max 90ms',
      'Queries 40',
      'Timeouts 2',
      'Hits 21',
      'Misses 9',
      'CPU 37%',
      'RSS 210 MB',
      'Heap 90 MB',
    ]);
    w.unmount();
  });

  it('refetches with the new range when it changes, and remembers it', async () => {
    const w = await mountPage();
    api.get.mockClear();
    await w.find('select').setValue('1h');
    await flushPromises();
    const perf = api.get.mock.calls.find(([url]) => url === '/metrics/proxy-perf');
    expect(perf[1].params.range).toBe('1h');
    expect(localStorage.getItem('cidrella_analytics_range')).toBe('"1h"');
    w.unmount();
  });

  it('says so instead of drawing zeros when the range has no queries', async () => {
    payloads['/metrics/proxy-perf'] = [
      minute(0, {
        query_count: 0,
        latency_min: null,
        latency_avg: null,
        latency_p95: null,
        latency_max: null,
        cache_hits: 0,
        cache_misses: 0,
      }),
    ];
    const w = await mountPage();
    expect(text(w, '.fig .value').slice(0, 5)).toEqual(['0', '—', '—', '0', '2']);
    expect(w.text()).toContain('No latency samples in this range.');
    expect(w.text()).toContain('No queries in this range.');
    expect(w.text()).toContain('No lookups in this range.');
    // The process gauges still draw: a quiet process is data.
    expect(w.findAll('.line-stub').length).toBe(2);
    w.unmount();
  });
});
