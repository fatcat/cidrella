import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));
// Chart.js wants a canvas; the chart's data plumbing is tested through the
// legend it renders around the stub.
vi.mock('vue-chartjs', () => ({ Line: { template: '<div class="line-stub" />' } }));

const { default: Dashboard } = await import('../../../src/views/Dashboard.vue');

const minute = (i, extra = {}) => ({
  ts: 1789900000 + i * 60,
  dns_queries: 10,
  dhcp_requests: 3,
  dhcp_client_msgs: 2,
  dhcp_server_msgs: 1,
  blocklist_blocks: 1,
  geoip_blocks: 0,
  ...extra,
});

let payloads;

function respond(url) {
  const path = url.split('?')[0];
  if (path in payloads) {
    const value = payloads[path];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve({ data: value });
  }
  return Promise.reject(new Error(`Unexpected GET ${url}`));
}

async function mountBoard() {
  const wrapper = mount(Dashboard, {
    global: {
      plugins: [createPinia()],
      stubs: {
        RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        Select: {
          props: ['modelValue', 'options'],
          emits: ['update:modelValue', 'change'],
          template:
            '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value); $emit(\'change\')"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
        },
        Button: { template: '<button><slot /></button>' },
      },
    },
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

describe('Dashboard health board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    payloads = {
      '/metrics/timeseries': [minute(0), minute(1), minute(2, { geoip_blocks: 2 })],
      '/metrics/proxy-perf': [
        {
          ts: 1,
          query_count: 20,
          latency_min: 3000,
          latency_avg: 8000,
          latency_p95: 17000,
          cache_hits: 14,
          cache_misses: 6,
          timeouts: 0,
        },
        {
          ts: 2,
          query_count: 10,
          latency_min: 3000,
          latency_avg: 9000,
          latency_p95: 19000,
          cache_hits: 7,
          cache_misses: 3,
          timeouts: 2,
        },
      ],
      '/analytics/top-clients': [
        { client_ip: '10.0.0.5', hostname: 'truenas', count: 900 },
        { client_ip: '10.0.0.9', hostname: null, count: 450 },
      ],
      '/analytics/top-domains': [{ domain: 'apple.com', count: 300 }],
      '/metrics/services': {
        dnsmasq: true,
        geoip_proxy: true,
        geoip_bypassed: false,
        forwarders: [
          { ip: '9.9.9.9', reachable: true },
          { ip: '8.8.8.8', reachable: false },
        ],
      },
      '/health/system': { stats: { subnets: 4, dns_zones: 10, dhcp_scopes: 3, dhcp_leases: 44 } },
      '/metrics/ip-lifecycle': {
        allocations: { unassigned: 42, static_dns: 18, static_dhcp: 23, system: 8, gateway: 4 },
        scope_conflicts: 0,
        rogue_hosts: 7,
        retirement: { last_24h: 131 },
        reconciliation: { outcome: 'complete', failures: 0, blocking_conflicts: 0 },
      },
      '/metrics/network-dhcp': { summary: { review_required: 0, safe_repairs: 0 } },
      '/dhcp/rogue/status': { enabled: true, healthy: true, unacknowledged: 1 },
      '/anomalies/summary': {
        enabled: true,
        unacknowledged_active: 15,
        by_severity: { low: 15 },
        daemon: { last_score: '2026-09-20T00:00:00Z' },
      },
    };
    api.get.mockImplementation(respond);
  });

  it('renders the rail, the attention rows and the figures from the sources', async () => {
    const wrapper = await mountBoard();
    const chips = wrapper.findAll('.status-rail .chip').map((c) => c.text().replace(/\s+/g, ' '));
    expect(chips).toEqual([
      'dnsmasq Running',
      'DNS proxy Running',
      'Forwarders 1 of 2',
      'Detector Scoring',
      'Networks 4',
      'Zones 10',
      'Scopes 3',
      'Leases 44',
    ]);
    expect(wrapper.find('.status-rail .chip:nth-child(3) .cid-status-dot').classes()).toContain(
      'sd-warn',
    );

    const rows = wrapper.findAll('.attn-row').map((r) => r.attributes('data-track'));
    expect(rows).toEqual([
      'dashboard-attention-rogue-dhcp',
      'dashboard-attention-rogue-hosts',
      'dashboard-attention-anomalies',
    ]);
    expect(wrapper.find('[data-track="dashboard-attention-rogue-hosts"]').attributes('href')).toBe(
      '/networks?context=all&view=addresses&type=rogue',
    );
    expect(wrapper.findAll('.panel-note')[0].text()).toBe('3 open');

    const figures = wrapper.findAll('.fig .value').map((v) => v.text());
    // p95 averages the minute p95s (18ms), hit rate is 21 of 30, timeouts sum.
    expect(figures).toEqual(['18ms', '70%', '2']);
    expect(wrapper.findAll('.fig')[2].classes()).toContain('warn');

    // DNS stack: answered is queries minus both block counts.
    const legends = wrapper.findAll('.traffic .chip').map((c) => c.text().replace(/\s+/g, ' '));
    expect(legends).toEqual([
      'Answered 25',
      'Blocked by list 3',
      'Blocked by GeoIP 2',
      'Client requests 6',
      'Server replies 3',
    ]);
    expect(wrapper.text()).toContain('truenas');
    expect(wrapper.text()).toContain('10.0.0.9');
    expect(wrapper.find('[data-track="dashboard-top-domain"]').attributes('href')).toBe(
      '/analytics?view=intelligence&q=apple.com',
    );
    expect(wrapper.text()).toContain('131 addresses retired in the last 24h');
    wrapper.unmount();
  });

  it('refetches only the range-driven sources when the range changes', async () => {
    const wrapper = await mountBoard();
    api.get.mockClear();
    await wrapper.find('select').setValue('4h');
    await flushPromises();
    const urls = api.get.mock.calls.map(([url]) => url.split('?')[0]).sort();
    expect(urls).toEqual([
      '/analytics/top-clients',
      '/analytics/top-domains',
      '/metrics/proxy-perf',
      '/metrics/timeseries',
    ]);
    expect(api.get.mock.calls.every(([, cfg]) => cfg.params.range === '4h')).toBe(true);
    wrapper.unmount();
  });

  it('keeps rendering when one source fails, and says which panel is unavailable', async () => {
    payloads['/metrics/ip-lifecycle'] = new Error('boom');
    payloads['/metrics/services'] = new Error('boom');
    const wrapper = await mountBoard();
    expect(wrapper.text()).toContain('Address figures are unavailable right now.');
    expect(wrapper.findAll('.status-rail .chip')[0].text().replace(/\s+/g, ' ')).toBe(
      'Services unknown',
    );
    // Rows from the sources that did answer still show.
    expect(wrapper.find('[data-track="dashboard-attention-anomalies"]').exists()).toBe(true);
    expect(wrapper.findAll('.panel-note')[0].text()).toBe('2 open, 2 sources unavailable');
    wrapper.unmount();
  });

  it('draws rows from before the DHCP split as client messages', async () => {
    payloads['/metrics/timeseries'] = [
      minute(0, { dhcp_requests: 5, dhcp_client_msgs: 0, dhcp_server_msgs: 0 }),
    ];
    const wrapper = await mountBoard();
    const legends = wrapper.findAll('.traffic .chip').map((c) => c.text().replace(/\s+/g, ' '));
    expect(legends.slice(-2)).toEqual(['Client requests 5', 'Server replies 0']);
    wrapper.unmount();
  });
});
