/**
 * Settings > Access > Password rule: the appliance-wide complexity switch,
 * admin-only, read from and written to the settings API.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { auth, store, toast } = vi.hoisted(() => ({
  auth: { isAdmin: true },
  store: { getSettings: vi.fn(), updateSetting: vi.fn() },
  toast: { add: vi.fn() },
}));
vi.mock('../../../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('../../../src/stores/subnets.js', () => ({ useSubnetStore: () => store }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/ui/ToggleSwitch.js', () => ({
  default: {
    props: ['modelValue', 'disabled', 'inputId'],
    emits: ['update:modelValue'],
    template:
      '<input type="checkbox" :id="inputId" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
  },
}));

const PasswordRuleSettings = (await import('../../../src/views/settings/PasswordRuleSettings.vue'))
  .default;

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAdmin = true;
  store.updateSetting.mockResolvedValue({});
});

describe('PasswordRuleSettings', () => {
  it('reads the setting and states the rule in force', async () => {
    store.getSettings.mockResolvedValue({ password_complexity: 'true' });
    const w = mount(PasswordRuleSettings);
    await flushPromises();
    expect(w.find('#password-complexity').element.checked).toBe(true);
    expect(w.text()).toContain('including an uppercase letter');
  });

  it('treats a missing setting as on and false as off', async () => {
    store.getSettings.mockResolvedValue({});
    let w = mount(PasswordRuleSettings);
    await flushPromises();
    expect(w.find('#password-complexity').element.checked).toBe(true);
    store.getSettings.mockResolvedValue({ password_complexity: 'false' });
    w = mount(PasswordRuleSettings);
    await flushPromises();
    expect(w.find('#password-complexity').element.checked).toBe(false);
    expect(w.text()).toContain('Nothing else is required');
  });

  it('writes the setting on toggle and reports it', async () => {
    store.getSettings.mockResolvedValue({ password_complexity: 'true' });
    const w = mount(PasswordRuleSettings);
    await flushPromises();
    await w.find('#password-complexity').setValue(false);
    await flushPromises();
    expect(store.updateSetting).toHaveBeenCalledWith('password_complexity', 'false');
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Complexity rule off' }),
    );
    expect(w.text()).toContain('Nothing else is required');
  });

  it('reverts the switch when the save fails', async () => {
    store.getSettings.mockResolvedValue({ password_complexity: 'true' });
    store.updateSetting.mockRejectedValue({ response: { data: { error: 'nope' } } });
    const w = mount(PasswordRuleSettings);
    await flushPromises();
    await w.find('#password-complexity').setValue(false);
    await flushPromises();
    expect(w.find('#password-complexity').element.checked).toBe(true);
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
  });

  it('is read-only for non-admins', async () => {
    auth.isAdmin = false;
    store.getSettings.mockResolvedValue({ password_complexity: 'true' });
    const w = mount(PasswordRuleSettings);
    await flushPromises();
    expect(w.find('#password-complexity').attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('Only an administrator can change this');
  });
});
