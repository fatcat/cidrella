/**
 * The anomaly triage page: a queue and a map linked by selection, and an
 * Evidence drawer that opens on a pick, swaps in place on the next pick, and
 * collapses on a click anywhere else.
 *
 * Two API conventions the page has to translate: a MORE anomalous window is
 * a MORE NEGATIVE score, and a blocked query carries response_code NOERROR
 * with the block recorded in `action`.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));
const toast = { add: vi.fn() };
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
// Chart.js wants a canvas; the drawer's other sections are plain SVG.
vi.mock('../../../src/components/anomaly/AnomalyScoreHistory.vue', () => ({
  default: { props: ['history'], template: '<div class="score-history-stub" />' },
}));

const { default: AnomaliesWorkspace } = await import('../../../src/views/AnomaliesWorkspace.vue');

const CALM = {
  identity: 'aa:bb:cc:dd:ee:01',
  client_ip: '10.0.0.1',
  hostname: 'calm-host',
  anomaly_score: -0.12,
  threat_score: 0.2,
  severity: 'low',
  is_anomaly: 1,
  resolved: 0,
  window_start: '2026-09-10 04:00:00',
  window_end: '2026-09-10 05:00:00',
  top_features: [
    {
      feature: 'nxdomain_ratio',
      label: 'High NXDOMAIN rate',
      contribution: 0.2,
      observed: 0.3,
      baseline: 0.02,
      peers: 0.28,
    },
  ],
};
const WORST = {
  identity: 'aa:bb:cc:dd:ee:02',
  client_ip: '10.0.0.2',
  hostname: 'worst-host',
  anomaly_score: -0.64,
  threat_score: 0.85,
  severity: 'high',
  is_anomaly: 1,
  resolved: 0,
  window_start: '2026-09-10 06:00:00',
  window_end: '2026-09-10 07:00:00',
  top_features: [
    {
      feature: 'block_ratio',
      label: 'High blocked query rate',
      contribution: 0.44,
      observed: 0.38,
      baseline: 0.05,
      peers: 0.04,
    },
  ],
};
const QUIET = {
  identity: '10.0.0.3',
  client_ip: '10.0.0.3',
  hostname: 'quiet-host',
  anomaly_score: 0.18,
  threat_score: null,
  severity: null,
  is_anomaly: 0,
  resolved: 0,
  window_start: '2026-09-10 06:00:00',
  flagged_24h: 0,
  training_rows: 90,
};

const evidenceFor = (row, extra = {}) => ({
  identity: row.identity,
  client_ip: row.client_ip,
  window_start: row.window_start,
  window_end: row.window_end,
  retention_days: 7,
  window_within_retention: true,
  evidence_available: true,
  truncated: false,
  summary: { total_queries: 900, distinct_domains: 40, nxdomain_count: 2, blocked_count: 311 },
  rows: [
    {
      domain: 'ads.example.com',
      query_type: 'A',
      response_code: 'NOERROR',
      action: 'blocked_blocklist',
      count: 311,
    },
    {
      domain: 'missing.example.com',
      query_type: 'A',
      response_code: 'NXDOMAIN',
      action: 'allowed',
      count: 12,
    },
  ],
  ...extra,
});

let evidenceOverride = null;
beforeEach(() => {
  vi.clearAllMocks();
  evidenceOverride = null;
  api.get.mockImplementation((url) => {
    if (url === '/anomalies/summary') {
      return Promise.resolve({
        data: {
          enabled: true,
          clients_monitored: 12,
          clients_learning: 3,
          daemon: { last_score: '2026-09-10T07:00:00Z', heartbeat_age_sec: 12 },
        },
      });
    }
    if (url === '/anomalies/map') {
      return Promise.resolve({
        data: [
          { ...WORST, flagged_24h: 4, training_rows: 120 },
          { ...CALM, flagged_24h: 1, training_rows: 100 },
          QUIET,
        ],
      });
    }
    if (url.startsWith('/anomalies/events')) {
      return Promise.resolve({ data: { events: [CALM, WORST], learning: [] } });
    }
    if (url.includes('/evidence/signal')) {
      const feature = new URL(url, 'http://x').searchParams.get('feature');
      return Promise.resolve({
        data: {
          feature,
          metric: feature === 'block_ratio' ? 'blocked' : 'nxdomain',
          unit: '',
          total: 3,
          limit: 8,
          items: [{ domain: `names-for-${feature}.example.com`, count: 12, value: 12 }],
        },
      });
    }
    if (url.includes('/evidence')) {
      if (evidenceOverride) return evidenceOverride(url);
      const row = url.includes(WORST.identity) ? WORST : CALM;
      return Promise.resolve({ data: evidenceFor(row) });
    }
    if (url.endsWith('/model')) return Promise.resolve({ data: { training_rows: 168 } });
    if (url.includes('/fingerprint/')) return Promise.resolve({ data: [] });
    // client history
    const row = url.includes(WORST.identity) ? WORST : CALM;
    return Promise.resolve({ data: [row] });
  });
});

async function mountPage() {
  const wrapper = mount(AnomaliesWorkspace, {
    attachTo: globalThis.document.body,
    global: { plugins: [createPinia()], stubs: { 'router-link': { template: '<a><slot /></a>' } } },
  });
  await flushPromises();
  return wrapper;
}
const rowNames = (w) => w.findAll('.queue-row .row-name').map((n) => n.text());
const drawer = (w) => w.find('.evidence-drawer');
const shown = (w) => w.find('.evidence-drawer .dhead h3').text();
const dotFor = (w, id) =>
  w.findAll('circle.mdot').find((c) => c.attributes('aria-label') === `Open ${id}`);
function pointerDownOn(el) {
  el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

describe('anomaly triage page', () => {
  it('ranks the most anomalous device first, which is the most NEGATIVE score', async () => {
    const w = await mountPage();
    expect(rowNames(w)).toEqual(['worst-host', 'calm-host']);
    expect(drawer(w).exists()).toBe(false);
    w.unmount();
  });

  it('opens the drawer from a map dot and asks the evidence endpoint for that identity', async () => {
    const w = await mountPage();
    await dotFor(w, 'worst-host').trigger('click');
    await flushPromises();
    expect(drawer(w).exists()).toBe(true);
    expect(shown(w)).toBe('worst-host');
    expect(
      api.get.mock.calls.some(([url]) =>
        url.startsWith(`/anomalies/client/${WORST.identity}/evidence`),
      ),
    ).toBe(true);
    // A blocked query reads BLOCKED even though its response code is NOERROR.
    expect(w.find('.evidence-drawer .rcode.blocked').text()).toBe('BLOCKED');
    w.unmount();
  });

  it('swaps the content in place when another row is picked while open', async () => {
    const w = await mountPage();
    await dotFor(w, 'worst-host').trigger('click');
    await flushPromises();
    const before = drawer(w).element;
    const calmRow = w.findAll('.queue-row')[1];
    pointerDownOn(calmRow.element);
    await calmRow.trigger('click');
    await flushPromises();
    expect(drawer(w).exists()).toBe(true);
    expect(drawer(w).element).toBe(before);
    expect(shown(w)).toBe('calm-host');
    w.unmount();
  });

  it('collapses on a click anywhere that is not a dot, a row or the drawer', async () => {
    const w = await mountPage();
    await dotFor(w, 'worst-host').trigger('click');
    await flushPromises();
    pointerDownOn(w.find('.workspace-head h1').element);
    await flushPromises();
    expect(drawer(w).exists()).toBe(false);
    w.unmount();
  });

  it('does not collapse on a click inside the drawer or on another dot', async () => {
    const w = await mountPage();
    await dotFor(w, 'worst-host').trigger('click');
    await flushPromises();
    pointerDownOn(w.find('.evidence-drawer .dhead h3').element);
    await flushPromises();
    expect(drawer(w).exists()).toBe(true);
    const calmDot = dotFor(w, 'calm-host');
    pointerDownOn(calmDot.element);
    await calmDot.trigger('click');
    await flushPromises();
    expect(drawer(w).exists()).toBe(true);
    expect(shown(w)).toBe('calm-host');
    w.unmount();
  });

  it('closes on Escape and on the X', async () => {
    const w = await mountPage();
    await dotFor(w, 'worst-host').trigger('click');
    await flushPromises();
    globalThis.window.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(drawer(w).exists()).toBe(false);
    await w.findAll('.queue-row')[0].trigger('click');
    await flushPromises();
    await w.find('[data-track="evidence-close"]').trigger('click');
    expect(drawer(w).exists()).toBe(false);
    w.unmount();
  });

  it('steps through the queue with Previous and Next, bounded at both ends', async () => {
    const w = await mountPage();
    await w.findAll('.queue-row')[0].trigger('click');
    await flushPromises();
    expect(w.find('.position').text()).toBe('1 of 2');
    expect(w.find('[data-track="evidence-prev"]').attributes('disabled')).toBeDefined();
    await w.find('[data-track="evidence-next"]').trigger('click');
    await flushPromises();
    expect(shown(w)).toBe('calm-host');
    expect(w.find('[data-track="evidence-next"]').attributes('disabled')).toBeDefined();
    w.unmount();
  });

  it('plots every monitored device, hollow when its threat shape is not scored yet', async () => {
    const w = await mountPage();
    expect(w.findAll('circle.mdot')).toHaveLength(3);
    expect(dotFor(w, 'quiet-host').classes()).toContain('hollow');
    expect(dotFor(w, 'worst-host').classes()).not.toContain('hollow');
    expect(w.text()).toContain('Threat shape not scored yet');
    w.unmount();
  });

  it('opens a within-baseline device from the map and says there is no flagged window', async () => {
    evidenceOverride = () => Promise.reject({ response: { status: 404 } });
    const w = await mountPage();
    await dotFor(w, 'quiet-host').trigger('click');
    await flushPromises();
    expect(shown(w)).toBe('quiet-host');
    expect(w.find('.evidence-drawer').text()).toContain('Within baseline');
    expect(w.find('.evidence-drawer').text()).toContain('No flagged window');
    expect(w.find('.position').exists()).toBe(false);
    w.unmount();
  });

  it('surfaces a pruned window instead of showing it as no traffic', async () => {
    evidenceOverride = () =>
      Promise.resolve({
        data: evidenceFor(WORST, { window_within_retention: false, rows: [], summary: null }),
      });
    const w = await mountPage();
    await w.findAll('.queue-row')[0].trigger('click');
    await flushPromises();
    expect(w.find('.evidence-drawer').text()).toContain('older than the 7 day analytics retention');
    w.unmount();
  });

  it('lists the names behind each contributing factor, ranked by that signal', async () => {
    const w = await mountPage();
    await dotFor(w, 'worst-host').trigger('click');
    await flushPromises();
    await flushPromises();
    const factor = w.find('.evidence-drawer .factor');
    expect(factor.text()).toContain('High blocked query rate');
    expect(factor.find('.factor-names .name').text()).toBe('names-for-block_ratio.example.com');
    expect(factor.find('.factor-names .measure').text()).toBe('12 blocked');
    expect(factor.text()).toContain('top 1 of 3');
    expect(
      api.get.mock.calls.some(([url]) =>
        url.startsWith(`/anomalies/client/${WORST.identity}/evidence/signal?feature=block_ratio`),
      ),
    ).toBe(true);
    w.unmount();
  });

  it('says whether a factor is odd for the device alone or for its peers too', async () => {
    const w = await mountPage();
    await dotFor(w, 'worst-host').trigger('click');
    await flushPromises();
    await flushPromises();
    const worst = w.find('.evidence-drawer .factor');
    expect(worst.find('.factor-vals').text()).toContain('peers');
    expect(worst.find('.factor-peers').text()).toBe('Above its peers too');
    expect(worst.find('.factor-peers').classes()).toContain('alone');

    // The calm host's NXDOMAIN rate is high against its own baseline but the
    // whole network is doing it: shared, not a finding about this device.
    await dotFor(w, 'calm-host').trigger('click');
    await flushPromises();
    await flushPromises();
    const mild = w.find('.evidence-drawer .factor');
    expect(mild.find('.factor-peers').text()).toBe('In line with what peers do');
    expect(mild.find('.factor-peers').classes()).toContain('shared');
    w.unmount();
  });
});
