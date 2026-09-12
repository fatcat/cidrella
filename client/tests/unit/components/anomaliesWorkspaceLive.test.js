/**
 * Live mode of the anomaly triage preview.
 *
 * The sample half of that page cannot regress: it reads a literal. The live
 * half normalizes three things that CAN, and each of them is a place where the
 * API's vocabulary and the page's vocabulary differ:
 *
 *   - ordering: a MORE anomalous window is a MORE NEGATIVE isolation forest
 *     score, so a naive descending sort puts the calmest device on top.
 *   - the response column: a blocked query carries response_code NOERROR, so
 *     reading response_code alone reports blocked traffic as clean.
 *   - the peer column: nothing computes peer medians yet, and rendering an
 *     empty cell would read as "the peers do none of this".
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const { default: AnomaliesWorkspacePreview } = await import('../../../src/views/AnomaliesWorkspacePreview.vue');

const CALM = {
  identity: 'aa:bb:cc:dd:ee:01', client_ip: '10.0.0.1', hostname: 'calm-host',
  anomaly_score: -0.52, severity: 'medium', resolved: 0,
  window_start: '2026-09-10 04:00:00', window_end: '2026-09-10 05:00:00',
  top_features: [
    { feature: 'nxdomain_ratio', label: 'High NXDOMAIN rate', contribution: 0.2, observed: 0.3, baseline: 0.02 },
  ],
};
const WORST = {
  identity: 'aa:bb:cc:dd:ee:02', client_ip: '10.0.0.2', hostname: 'worst-host',
  anomaly_score: -0.74, severity: 'high', resolved: 0,
  window_start: '2026-09-10 06:00:00', window_end: '2026-09-10 07:00:00',
  top_features: [
    { feature: 'block_ratio', label: 'High blocked query rate', contribution: 0.44, observed: 0.38, baseline: 0.05 },
  ],
};

function mountPreview() {
  return mount(AnomaliesWorkspacePreview, {
    global: {
      plugins: [createPinia()],
      stubs: { 'router-link': { template: '<a><slot /></a>' } },
    },
  });
}

async function goLive(wrapper) {
  const live = wrapper.findAll('.mode-switch button').find(b => b.text() === 'Live data');
  await live.trigger('click');
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url === '/anomalies/summary') {
      return Promise.resolve({ data: { enabled: true, clients_monitored: 12, clients_learning: 3, daemon: { last_score: '2026-09-10T07:00:00Z', heartbeat_age_sec: 12 } } });
    }
    if (url.startsWith('/anomalies/events')) {
      return Promise.resolve({ data: { events: [CALM, WORST], learning: [] } });
    }
    if (url.includes('/evidence')) {
      return Promise.resolve({ data: {
        identity: 'aa:bb:cc:dd:ee:02', client_ip: '10.0.0.2',
        window_start: '2026-09-10 06:00:00', window_end: '2026-09-10 07:00:00',
        retention_days: 7, window_within_retention: true, evidence_available: true, truncated: false,
        summary: { total_queries: 900, distinct_domains: 40, nxdomain_count: 2, blocked_count: 311 },
        rows: [
          { domain: 'ads.example.com', query_type: 'A', response_code: 'NOERROR', action: 'blocked_blocklist', count: 311 },
          { domain: 'missing.example.com', query_type: 'A', response_code: 'NXDOMAIN', action: 'allowed', count: 12 },
        ],
      } });
    }
    if (url.endsWith('/model')) return Promise.resolve({ data: { training_rows: 168 } });
    return Promise.resolve({ data: [WORST] });
  });
});

describe('anomaly triage preview, live mode', () => {
  it('ranks the most anomalous device first, which is the most NEGATIVE score', async () => {
    const wrapper = await goLive(mountPreview());
    const names = wrapper.findAll('.queue-row .row-who b').map(node => node.text());
    expect(names[0]).toBe('worst-host');
    expect(names).toContain('calm-host');
  });

  it('opens the worst device and asks the evidence endpoint for its identity', async () => {
    await goLive(mountPreview());
    const evidenceCall = api.get.mock.calls.map(call => call[0]).find(url => url.includes('/evidence'));
    expect(evidenceCall).toContain('/anomalies/client/aa:bb:cc:dd:ee:02/evidence');
    expect(evidenceCall).toContain('limit=50');
  });

  it('reports a blocked query as BLOCKED even though its response code is NOERROR', async () => {
    const wrapper = await goLive(mountPreview());
    const codes = wrapper.findAll('.evidence-table .rcode').map(node => node.text());
    expect(codes).toEqual(['BLOCKED', 'NXDOMAIN']);
  });

  it('says the peer median is not collected rather than leaving the cell empty', async () => {
    const wrapper = await goLive(mountPreview());
    expect(wrapper.find('.signal-table').text()).toContain('not collected');
  });

  it('hides the triage map in live mode because nothing scores its vertical axis', async () => {
    const wrapper = mountPreview();
    expect(wrapper.find('.map-svg').exists()).toBe(true);
    await goLive(wrapper);
    expect(wrapper.find('.map-svg').exists()).toBe(false);
    expect(wrapper.find('.missing-axis').text()).toContain('threat shape');
  });

  it('surfaces a pruned window instead of showing it as no traffic', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/anomalies/summary') return Promise.resolve({ data: { enabled: true, daemon: null } });
      if (url.startsWith('/anomalies/events')) return Promise.resolve({ data: { events: [WORST], learning: [] } });
      if (url.includes('/evidence')) {
        return Promise.resolve({ data: {
          retention_days: 7, window_within_retention: false, evidence_available: false,
          truncated: false, summary: null, rows: [],
          window_start: '2026-08-10 06:00:00', window_end: '2026-08-10 07:00:00',
        } });
      }
      if (url.endsWith('/model')) return Promise.resolve({ data: null });
      return Promise.resolve({ data: [WORST] });
    });

    const wrapper = await goLive(mountPreview());
    expect(wrapper.find('.evidence-state').text()).toContain('older than the 7 day analytics retention');
  });
});
