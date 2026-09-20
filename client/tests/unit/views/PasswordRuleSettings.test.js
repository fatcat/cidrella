/**
 * Settings > Access > Password rule: the four parts of the appliance-wide
 * rule, admin-only, read from and written to the settings API one at a time.
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
vi.mock('../../../src/ui/Checkbox.js', () => ({
  default: {
    props: ['modelValue', 'disabled', 'inputId'],
    emits: ['update:modelValue'],
    template:
      '<input type="checkbox" :id="inputId" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
  },
}));
vi.mock('../../../src/ui/InputNumber.js', () => ({
  default: {
    props: ['modelValue', 'disabled', 'inputId'],
    emits: ['update:modelValue', 'blur'],
    template:
      '<input type="number" :id="inputId" :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', Number($event.target.value))" @blur="$emit(\'blur\')" />',
  },
}));

const PasswordRuleSettings = (await import('../../../src/views/settings/PasswordRuleSettings.vue'))
  .default;

const STRICT = {
  password_min_length: '8',
  password_require_mixed_case: 'true',
  password_require_number: 'true',
  password_require_symbol: 'false',
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAdmin = true;
  store.updateSetting.mockResolvedValue({});
});

describe('PasswordRuleSettings', () => {
  it('reads the four settings and states the rule in force', async () => {
    store.getSettings.mockResolvedValue(STRICT);
    const w = mount(PasswordRuleSettings);
    await flushPromises();
    expect(w.find('#password-min-length').element.value).toBe('8');
    expect(w.find('#password-mixed-case').element.checked).toBe(true);
    expect(w.find('#password-number').element.checked).toBe(true);
    expect(w.find('#password-symbol').element.checked).toBe(false);
    expect(w.find('[data-track="password-rule-description"]').text()).toBe(
      'At least 8 characters, including upper and lower case letters, a number.',
    );
  });

  it('falls back to the defaults when the settings are missing', async () => {
    store.getSettings.mockResolvedValue({});
    const w = mount(PasswordRuleSettings);
    await flushPromises();
    expect(w.find('#password-min-length').element.value).toBe('8');
    expect(w.find('#password-mixed-case').element.checked).toBe(true);
  });

  it('writes each part on its own and updates the description', async () => {
    store.getSettings.mockResolvedValue(STRICT);
    const w = mount(PasswordRuleSettings);
    await flushPromises();
    await w.find('#password-symbol').setValue(true);
    await flushPromises();
    expect(store.updateSetting).toHaveBeenCalledWith('password_require_symbol', 'true');
    const len = w.find('#password-min-length');
    await len.setValue(0);
    await len.trigger('blur');
    await flushPromises();
    expect(store.updateSetting).toHaveBeenCalledWith('password_min_length', '0');
    expect(w.find('[data-track="password-rule-description"]').text()).toBe(
      'Including upper and lower case letters, a number, a symbol.',
    );
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Password rule saved' }),
    );
  });

  it('reverts when the save fails', async () => {
    store.getSettings.mockResolvedValue(STRICT);
    store.updateSetting.mockRejectedValue({ response: { data: { error: 'nope' } } });
    const w = mount(PasswordRuleSettings);
    await flushPromises();
    await w.find('#password-number').setValue(false);
    await flushPromises();
    expect(w.find('#password-number').element.checked).toBe(true);
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
  });

  it('is read-only for non-admins', async () => {
    auth.isAdmin = false;
    store.getSettings.mockResolvedValue(STRICT);
    const w = mount(PasswordRuleSettings);
    await flushPromises();
    expect(w.find('#password-symbol').attributes('disabled')).toBeDefined();
    expect(w.find('#password-min-length').attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('Only an administrator can change this');
  });
});
