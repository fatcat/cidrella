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

// One upstream address's minute row from /api/metrics/forwarder.
const upstream = (i, provider, address, extra = {}) => ({
  ts: 1789900000 + i * 60,
  provider,
  address,
  protocol: 'dot',
  queries: 12,
  answers: 12,
  timeouts: 0,
  drops: 0,
  connect_failures: 0,
  failovers: 0,
  latency_p50_us: address ? 9000 : null,
  latency_p95_us: address ? 21000 : null,
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
          servfail_dnssec: 1,
          servfail_upstream: 1,
          servfail_timeout: 1,
        }),
      ],
      '/metrics/forwarder': [
        upstream(0, 'dns10.quad9.net', '9.9.9.10', { answers: 10, timeouts: 1 }),
        upstream(0, 'dns10.quad9.net', '', { queries: 0, answers: 0, failovers: 1 }),
        upstream(1, 'unfiltered.adguard-dns.com', '2a10:50c0::ad1:ff', { answers: 12 }),
      ],
      '/metrics/dns-failures': [
        { domain: 'dnssec-failed.org', count: 3, failure: 'dnssec', ede: 7 },
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

  it('shows the service chips, every figure, a legend per chart and the two lists', async () => {
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
      'Failed answers',
      'DNSSEC failures',
      'Upstream failures',
      'Failovers',
      'CPU',
      'Memory',
    ]);
    // 40 queries over 2 minutes; p95 averages the two minutes; 21 of 30 hit;
    // 3 of the 40 answers failed (7.5%), one a failover to the next provider.
    expect(text(w, '.fig .value')).toEqual([
      '20',
      '18ms',
      '70%',
      '2',
      '2',
      '7.5%',
      '1',
      '2',
      '1',
      '61%',
      '210MB',
    ]);
    const figs = w.findAll('.fig');
    expect(figs[3].classes()).toContain('warn');
    expect(figs[5].classes()).toContain('err');
    expect(figs[9].classes()).toContain('warn');
    expect(text(w, '.fig .sub')[7]).toBe('1 no upstream answer · 1 timed out');
    expect(text(w, '.fig .sub')[9]).toBe('of one core · avg 36.7%');
    const notes = w.findAll('.panel-note');
    expect(notes[0].text()).toBe('last 24 hours · 40 queries in 2 samples');
    expect(notes[3].text()).toBe('forwarding · 22 answers in the range');
    expect(notes[8].text()).toContain('the host has 8');

    expect(text(w, '.series-chart .chip')).toEqual([
      'DNSSEC 1',
      'Upstream 1',
      'Timed out 1',
      'Refused 0',
      'Other 0',
      'Timeouts 1',
      'Dropped, resent 0',
      'Refused connections 0',
      'Failovers 1',
      'dns10.quad9.net 21ms',
      'unfiltered.adguard-dns.com 21ms',
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
    const lists = w.findAll('.top-list');
    expect(lists[0].text()).toContain('dnssec-failed.org');
    expect(lists[0].text()).toContain('DNSSEC · Signature Expired');
    expect(lists[1].text()).toContain('unfiltered.adguard-dns.com');
    expect(lists[1].text()).toContain('1 timeouts · 0 resent · 1 failovers · p95 21 ms');
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
    payloads['/metrics/forwarder'] = [];
    payloads['/metrics/dns-failures'] = [];
    const w = await mountPage();
    expect(text(w, '.fig .value').slice(0, 5)).toEqual(['0', '—', '—', '0', '2']);
    expect(w.text()).toContain('No latency samples in this range.');
    expect(w.text()).toContain('No queries in this range.');
    expect(w.text()).toContain('No lookups in this range.');
    // The process gauges still draw: a quiet process is data.
    expect(w.findAll('.line-stub').length).toBe(2);
    expect(w.text()).toContain('No failed answers in this range');
    expect(w.text()).toContain('nothing was forwarded');
    w.unmount();
  });
});
