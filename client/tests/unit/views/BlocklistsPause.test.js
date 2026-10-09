/**
 * Disable filtering on the Filtering page: a period pauses blocklists and
 * GeoIP at once (not on Save), the page counts down to when the server
 * resumes them, and Resume now ends it early.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { store, perms, toast } = vi.hoisted(() => ({
  store: {
    fetchCategories: vi.fn(),
    fetchSettings: vi.fn(),
    fetchStats: vi.fn(),
    pauseFiltering: vi.fn(),
    updateSettings: vi.fn(),
    categories: [],
    stats: {},
  },
  perms: { writable: true },
  toast: { add: vi.fn() },
}));

vi.mock('../../../src/stores/blocklists.js', () => ({ useBlocklistStore: () => store }));
vi.mock('../../../src/stores/dns.js', () => ({
  useDnsStore: () => ({ getForwarders: vi.fn().mockResolvedValue({}) }),
}));
vi.mock('../../../src/composables/usePermissions.js', () => ({
  usePermissions: () => ({ can: (perm) => perm !== 'dns:write' || perms.writable }),
}));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));

const Blocklists = (await import('../../../src/views/Blocklists.vue')).default;

const SelectStub = {
  props: ['options', 'disabled'],
  emits: ['update:modelValue'],
  template:
    '<div class="select" :data-disabled="String(!!disabled)"><button v-for="o in options" :key="o.value" type="button" class="option" @click="$emit(\'update:modelValue\', o.value)">{{ o.label }}</button></div>',
};
const ButtonStub = {
  props: ['label', 'disabled'],
  emits: ['click'],
  template:
    '<button type="button" class="button" :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
};

function mountPage() {
  return mount(Blocklists, {
    global: {
      stubs: {
        Select: SelectStub,
        Button: ButtonStub,
        ToggleSwitch: true,
        InputText: true,
        DataTable: true,
        Column: true,
        Toast: true,
        EmptyState: true,
      },
    },
  });
}
const pauseControl = (wrapper) => wrapper.find('[data-track="filtering-pause"]');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
  perms.writable = true;
  store.fetchCategories.mockReset().mockResolvedValue([]);
  store.fetchStats.mockReset().mockResolvedValue({});
  store.fetchSettings.mockReset().mockResolvedValue({ blocklist_enabled: 'true' });
  store.pauseFiltering.mockReset();
  toast.add.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('Disable filtering', () => {
  it('offers 5, 15, 30 minutes and 1 hour, and pauses at once on a choice', async () => {
    store.pauseFiltering.mockResolvedValue('2026-10-09T12:15:00.000Z');
    const wrapper = mountPage();
    await flushPromises();
    const options = pauseControl(wrapper).findAll('.option');
    expect(options.map((o) => o.text())).toEqual(['5 minutes', '15 minutes', '30 minutes', '1 hour']);

    await options[1].trigger('click');
    await flushPromises();
    expect(store.pauseFiltering).toHaveBeenCalledWith(15);
    expect(store.updateSettings).not.toHaveBeenCalled();
    expect(wrapper.find('[data-track="filtering-paused"]').text()).toContain('(15 min left)');
  });

  it('counts down a pause the server reports, ends with it, and resumes on request', async () => {
    store.fetchSettings.mockResolvedValue({ filtering_paused_until: '2026-10-09T12:00:30.000Z' });
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.find('[data-track="filtering-paused"]').text()).toContain('(30 s left)');

    store.pauseFiltering.mockResolvedValue(null);
    await wrapper.find('[data-track="filtering-resume"]').trigger('click');
    await flushPromises();
    expect(store.pauseFiltering).toHaveBeenCalledWith(0);
    expect(pauseControl(wrapper).exists()).toBe(true);

    store.fetchSettings.mockResolvedValue({ filtering_paused_until: '2026-10-09T12:00:30.000Z' });
    const ending = mountPage();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(ending.find('[data-track="filtering-paused"]').exists()).toBe(false);
    expect(pauseControl(ending).exists()).toBe(true);
  });

  it('is locked without dns:write', async () => {
    perms.writable = false;
    const wrapper = mountPage();
    await flushPromises();
    expect(pauseControl(wrapper).attributes('data-disabled')).toBe('true');
  });
});
