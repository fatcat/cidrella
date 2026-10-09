/**
 * The Resolution Map section: the HUD is drawn from the server's slice, each
 * poll asks only for what is newer than the last, only admins can set the
 * location, and the page says when GeoIP cannot place answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { api, perms, enqueue } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn() },
  perms: { admin: true },
  enqueue: vi.fn(),
}));

vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/composables/usePermissions.js', () => ({
  usePermissions: () => ({ can: (perm) => perm !== 'system:write' || perms.admin }),
}));
// The canvas cannot draw in the test DOM; the stub records what it is fed.
vi.mock('../../../src/components/analytics/ResolutionCanvas.vue', () => ({
  default: {
    name: 'ResolutionCanvas',
    props: ['mode', 'home', 'paused', 'picking'],
    emits: ['pick'],
    setup(_, { expose }) {
      expose({ enqueue });
    },
    template: '<div class="canvas-stub" :data-mode="mode" :data-home="home.join(\',\')"></div>',
  },
}));

const ResolutionMap = (await import('../../../src/views/ResolutionMap.vue')).default;

const NOW = Date.parse('2026-10-09T12:00:00Z');
function slice(overrides = {}) {
  return {
    seq: 3,
    events: [
      { seq: 1, at: NOW - 60_000, kind: 'answer', name: 'old.example', country: 'US', point: null },
      {
        seq: 2,
        at: NOW - 500,
        kind: 'answer',
        name: 'v4.example',
        country: 'DE',
        point: [13.4, 52.5],
      },
      { seq: 3, at: NOW, kind: 'geoip', name: 'bad.example', country: 'CN', point: null },
    ],
    summary: {
      kinds: { answer: 2, geoip: 1, blocklist: 0 },
      countries: 2,
      topCountries: [
        { country: 'DE', count: 1 },
        { country: 'US', count: 1 },
      ],
    },
    home: { lat: 39.95, lon: -75.16 },
    geoip: { enabled: true, loaded: true, cities: { month: '2026-10', cellKm: 100 } },
    ...overrides,
  };
}

function mountPage() {
  return mount(ResolutionMap, {
    global: { stubs: { WorkspaceHead: true, GeoAttribution: true } },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  perms.admin = true;
  api.get.mockReset().mockResolvedValue({ data: slice() });
  api.put.mockReset().mockResolvedValue({ data: {} });
  enqueue.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('ResolutionMap', () => {
  it('draws the HUD from the slice and flies only the last poll of a backlog', async () => {
    const wrapper = mountPage();
    await flushPromises();
    const stats = wrapper.find('.stats').text();
    expect(stats).toContain('2');
    expect(stats).toContain('GeoIP blocks');
    expect(wrapper.find('.top').text()).toContain('DE');
    const latest = wrapper.findAll('.feed li').map((li) => li.text());
    expect(latest[0]).toContain('bad.example');
    expect(latest[0]).toContain('GEOIP BLOCK');
    expect(enqueue.mock.calls[0][0].map((e) => e.name)).toEqual(['v4.example', 'bad.example']);
    expect(wrapper.find('.canvas-stub').attributes('data-home')).toBe('-75.16,39.95');
  });

  it('polls from the last sequence number', async () => {
    mountPage();
    await flushPromises();
    api.get.mockResolvedValue({ data: slice({ seq: 4, events: [] }) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.get).toHaveBeenLastCalledWith('/analytics/resolution-map', {
      params: { since: 3 },
    });
  });

  it('lets an admin set the location by clicking the map', async () => {
    const wrapper = mountPage();
    await flushPromises();
    await wrapper.find('[data-track="map-set-location"]').trigger('click');
    const canvas = wrapper.findComponent({ name: 'ResolutionCanvas' });
    expect(canvas.props('picking')).toBe(true);
    canvas.vm.$emit('pick', [151.20931, -33.86882]);
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/settings/map_home', { value: '-33.8688,151.2093' });
    expect(wrapper.find('.canvas-stub').attributes('data-home')).toBe('151.2093,-33.8688');
  });

  it('offers no location control to anyone else', async () => {
    perms.admin = false;
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.find('[data-track="map-set-location"]').exists()).toBe(false);
  });

  it('says when GeoIP is off, and when city places are missing', async () => {
    api.get.mockResolvedValue({
      data: slice({ geoip: { enabled: false, loaded: false, cities: null } }),
    });
    const off = mountPage();
    await flushPromises();
    expect(off.find('.notice').text()).toContain('GeoIP is off');

    api.get.mockResolvedValue({
      data: slice({ geoip: { enabled: true, loaded: true, cities: null } }),
    });
    const noCities = mountPage();
    await flushPromises();
    expect(noCities.find('.notice').text()).toContain('City places are not installed');
  });
});
