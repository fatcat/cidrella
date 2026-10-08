import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('vue-chartjs', () => ({
  Line: { name: 'Line', props: ['data'], template: '<div class="line-stub" />' },
}));

const { default: Intelligence } = await import('../../../src/views/Intelligence.vue');

let payloads;

function respond(url) {
  const path = url.split('?')[0];
  if (path in payloads) {
    const value = payloads[path];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve({ data: value });
  }
  return Promise.reject(new Error(`Unexpected GET ${url}`));
}

async function mountPage() {
  const wrapper = mount(Intelligence, {
    global: {
      plugins: [createPinia()],
      stubs: {
        RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        Select: {
          props: ['modelValue', 'options'],
          emits: ['update:modelValue'],
          template:
            '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
        },
        Button: { template: '<button><slot /></button>' },
        DataTable: { props: ['value'], template: '<table class="pairs-stub"><slot /></table>' },
        Column: true,
      },
    },
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

const text = (w, sel) => w.findAll(sel).map((n) => n.text().replace(/\s+/g, ' '));
// Table cells run together in text(); read them per cell.
const cells = (row) => row.findAll('td').map((c) => c.text().replace(/\s+/g, ' '));
const rowsOf = (list) => list.findAll('tbody tr').map(cells);

describe('Intelligence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    payloads = {
      '/analytics/action-breakdown': [
        { action: 'allowed', count: 119572 },
        { action: 'blocked_blocklist', count: 16734 },
        { action: 'blocked_geoip', count: 168 },
      ],
      '/analytics/query-volume': [
        { bucket: '2026-09-21T10:00:00.000Z', total: 100, allowed: 90, blocked: 10 },
        { bucket: '2026-09-21T10:15:00.000Z', total: 60, allowed: 50, blocked: 10 },
      ],
      '/analytics/allowed/top-domains': [{ domain: 'talk.google.com', count: 11983 }],
      '/analytics/allowed/top-clients': [
        { client_ip: '10.0.0.214', hostname: 'new-windows', count: 32424 },
      ],
      '/analytics/blocklist/top-domains': [
        { domain: 'global.telemetry.insights.video.a2z.com', count: 5198 },
      ],
      '/analytics/blocklist/top-categories': [
        { block_reason: 'ads', count: 16698 },
        { block_reason: 'malware', count: 29 },
      ],
      '/analytics/blocklist/top-clients': [
        { client_ip: '10.0.0.195', hostname: 'amazontechno-device', count: 8550 },
      ],
      '/analytics/blocklist/top-client-domains': [
        {
          client_ip: '10.0.0.195',
          hostname: 'amazontechno-device',
          domain: 'global.telemetry.insights.video.a2z.com',
          block_reason: 'ads',
          count: 5164,
        },
      ],
      '/metrics/geoip-hits': [{ country: 'CN', count: 210 }],
      '/analytics/geoip/top-domains': [{ domain: 'stun.hitv.com', count: 101 }],
      '/analytics/geoip/top-clients': [{ client_ip: '10.0.3.248', hostname: null, count: 103 }],
      '/analytics/dnssec/top-unsupported-domains': [{ domain: 'talk.google.com', count: 11969 }],
      '/metrics/services': { dnsmasq: true, geoip_proxy: true, geoip_bypassed: false },
      '/health/system': { dnssec: { enabled: true, supported: true, validating: true } },
      '/blocklists/settings': { blocklist_enabled: 'true' },
      '/blocklists/stats': { enabled_categories: 6, total_domains: 3064244 },
      '/geoip/status': {
        enabled: true,
        mode: 'blocklist',
        ruleCount: 4,
        bypassed: false,
        dbLoaded: true,
      },
    };
    api.get.mockImplementation(respond);
  });

  it('shows the filter chips, the verdicts and the ranked lists', async () => {
    const w = await mountPage();
    expect(text(w, '.status-rail .chip')).toEqual([
      'dnsmasq Running',
      'DNS proxy Running',
      'Blocklist 6 categories',
      'GeoIP Block 4 countries',
      'DNSSEC Validating',
    ]);
    expect(text(w, '.fig .value')).toEqual(['119,572', '12.4%', '16,734', '168']);
    expect(text(w, '.fig .sub')).toEqual([
      'of 136,474 queries',
      'stopped by any filter',
      '2 categories hit',
      '1 country',
    ]);
    expect(w.findAll('.stacked .legend button').map((b) => b.text())).toEqual([
      'Allowed119,572',
      'Blocked by list16,734',
      'Blocked by GeoIP168',
    ]);
    expect(text(w, '.series-chart .chip')).toEqual(['Allowed 140', 'Blocked 20']);

    const lists = w.findAll('.top-list');
    expect(lists.map((l) => l.find('th').text())).toEqual([
      'Domains',
      'Clients',
      'Domains',
      'Categories',
      'Hosts',
      'Countries',
      'Domains',
      'Hosts',
      'Domains whose answers were not signed',
    ]);
    expect(rowsOf(lists[3])).toEqual([
      ['ads', '16,698'],
      ['malware', '29'],
    ]);
    expect(rowsOf(lists[5])).toEqual([['ChinaCN', '210']]);
    expect(lists[1].find('a').attributes('href')).toBe(
      '/networks?context=all&view=addresses&q=10.0.0.214',
    );
    expect(rowsOf(lists[1])).toEqual([['new-windows10.0.0.214', '32,424']]);
    w.unmount();
  });

  it('says a filter is off, with a link to the setting, instead of an empty list', async () => {
    payloads['/blocklists/settings'] = { blocklist_enabled: 'false' };
    payloads['/geoip/status'] = { enabled: false, mode: 'blocklist', ruleCount: 0 };
    payloads['/health/system'] = { dnssec: { enabled: false, supported: true, validating: false } };
    const w = await mountPage();
    expect(text(w, '.status-rail .chip').slice(2)).toEqual([
      'Blocklist Off',
      'GeoIP Off',
      'DNSSEC Off',
    ]);
    expect(w.find('[data-track="intelligence-enable-blocklist"]').attributes('href')).toBe(
      '/system?area=filtering&sec=categories',
    );
    expect(w.find('[data-track="intelligence-enable-geoip"]').attributes('href')).toBe(
      '/system?area=filtering&sec=geoip',
    );
    expect(w.find('[data-track="intelligence-enable-dnssec"]').attributes('href')).toBe(
      '/system?area=dns&sec=dns',
    );
    // The permitted lists still render: they do not depend on a filter.
    expect(w.findAll('.top-list').length).toBe(2);
    w.unmount();
  });

  it('keeps the page up when the settings endpoints are refused, and refetches only range data on a range change', async () => {
    payloads['/blocklists/settings'] = new Error('403');
    payloads['/geoip/status'] = new Error('403');
    const w = await mountPage();
    expect(text(w, '.status-rail .chip').slice(2, 4)).toEqual([
      'Blocklist unknown',
      'GeoIP unknown',
    ]);
    expect(w.findAll('.top-list').length).toBe(9);

    api.get.mockClear();
    await w.find('select').setValue('1h');
    await flushPromises();
    const urls = api.get.mock.calls.map(([url]) => url.split('?')[0]);
    expect(urls).not.toContain('/blocklists/settings');
    expect(urls).toContain('/analytics/query-volume');
    const volume = api.get.mock.calls.find(([url]) => url === '/analytics/query-volume');
    expect(volume[1].params).toEqual({ range: '1h', interval: '1m' });
    w.unmount();
  });
});
