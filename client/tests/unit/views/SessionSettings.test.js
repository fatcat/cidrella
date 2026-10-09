/**
 * Settings > Access > Sessions: the inactivity limit, admin-only, saved as
 * one setting, and this session's deadline re-read after a change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { auth, store, toast } = vi.hoisted(() => ({
  auth: { isAdmin: true, refreshSession: vi.fn() },
  store: { getSettings: vi.fn(), updateSetting: vi.fn() },
  toast: { add: vi.fn() },
}));
vi.mock('../../../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('../../../src/stores/subnets.js', () => ({ useSubnetStore: () => store }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/ui/SelectButton.js', () => ({
  default: {
    props: ['modelValue', 'options', 'disabled'],
    emits: ['update:modelValue'],
    template:
      '<div><button v-for="o in options" :key="o.value" :disabled="disabled" :data-value="o.value" :class="{ on: o.value === modelValue }" @click="$emit(\'update:modelValue\', o.value)">{{ o.label }}</button></div>',
  },
}));

const SessionSettings = (await import('../../../src/views/settings/SessionSettings.vue')).default;

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAdmin = true;
  auth.refreshSession.mockResolvedValue({});
  store.updateSetting.mockResolvedValue({});
});

describe('SessionSettings', () => {
  it('shows the saved limit, and 60 minutes when none is saved', async () => {
    store.getSettings.mockResolvedValue({ session_idle_timeout_minutes: '15' });
    let w = mount(SessionSettings);
    await flushPromises();
    expect(w.find('button.on').text()).toBe('15 minutes');

    store.getSettings.mockResolvedValue({});
    w = mount(SessionSettings);
    await flushPromises();
    expect(w.find('button.on').text()).toBe('60 minutes');
  });

  it('saves a choice and re-reads this session', async () => {
    store.getSettings.mockResolvedValue({ session_idle_timeout_minutes: '60' });
    const w = mount(SessionSettings);
    await flushPromises();
    await w.find('button[data-value="0"]').trigger('click');
    await flushPromises();
    expect(store.updateSetting).toHaveBeenCalledWith('session_idle_timeout_minutes', '0');
    expect(auth.refreshSession).toHaveBeenCalled();
    expect(w.find('button.on').text()).toBe('Never');
  });

  it('puts the old choice back when the save fails', async () => {
    store.getSettings.mockResolvedValue({ session_idle_timeout_minutes: '30' });
    store.updateSetting.mockRejectedValue(new Error('nope'));
    const w = mount(SessionSettings);
    await flushPromises();
    await w.find('button[data-value="15"]').trigger('click');
    await flushPromises();
    expect(w.find('button.on').text()).toBe('30 minutes');
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
  });

  it('is read-only for anyone but an administrator', async () => {
    auth.isAdmin = false;
    store.getSettings.mockResolvedValue({});
    const w = mount(SessionSettings);
    await flushPromises();
    expect(w.findAll('button').every((b) => b.attributes('disabled') !== undefined)).toBe(true);
  });
});
