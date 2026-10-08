/**
 * Settings > Access > Two-factor: status, enrolment through the shared
 * component, fresh backup codes and turning it off, the last two behind the
 * password.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { auth } = vi.hoisted(() => ({
  auth: {
    user: { username: 'admin' },
    totpStatus: vi.fn(),
    totpSetup: vi.fn(),
    totpEnable: vi.fn(),
    totpRegenerateBackupCodes: vi.fn(),
    totpDisable: vi.fn(),
  },
}));
vi.mock('../../../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:qr') } }));

const ButtonStub = {
  props: ['label', 'disabled', 'loading'],
  emits: ['click'],
  template:
    '<button type="button" :disabled="disabled || loading" @click="$emit(\'click\')">{{ label }}</button>',
};
const TextStub = {
  props: ['modelValue', 'id', 'inputId'],
  emits: ['update:modelValue'],
  template:
    '<input :id="id || inputId" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const CheckStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
};
vi.mock('../../../src/ui/Button.js', () => ({ default: ButtonStub }));
vi.mock('../../../src/ui/InputText.js', () => ({ default: TextStub }));
vi.mock('../../../src/ui/Password.js', () => ({ default: TextStub }));
vi.mock('../../../src/ui/Checkbox.js', () => ({ default: CheckStub }));
vi.mock('../../../src/ui/Message.js', () => ({
  default: { template: '<div class="msg"><slot /></div>' },
}));

const TwoFactorSettings = (await import('../../../src/views/settings/TwoFactorSettings.vue'))
  .default;

const CODES = Array.from({ length: 10 }, (_, i) => `fresh${i}-abcde`);

beforeEach(() => {
  vi.clearAllMocks();
  auth.totpSetup.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauth_url: 'otpauth://totp/x' });
  auth.totpEnable.mockResolvedValue({ backup_codes: CODES });
  auth.totpRegenerateBackupCodes.mockResolvedValue({ backup_codes: CODES });
  auth.totpDisable.mockResolvedValue({ ok: true });
});

describe('TwoFactorSettings', () => {
  it('enrols from the off state and shows the backup codes until they are confirmed saved', async () => {
    auth.totpStatus.mockResolvedValueOnce({ enabled: false, backup_codes_remaining: 0 });
    auth.totpStatus.mockResolvedValueOnce({ enabled: true, backup_codes_remaining: 10 });
    const w = mount(TwoFactorSettings);
    await flushPromises();
    expect(w.text()).toContain('Off');
    await w.find('[data-track="twofactor-enable"]').trigger('click');
    await flushPromises();
    expect(auth.totpSetup).toHaveBeenCalled();
    await w.find('#totp-code').setValue('123456');
    await w.find('[data-track="totp-verify"]').trigger('click');
    await flushPromises();
    expect(auth.totpEnable).toHaveBeenCalledWith('123456');
    expect(w.findAll('.codes li')).toHaveLength(10);
    const done = () => w.find('[data-track="twofactor-codes-done"]');
    expect(done().attributes('disabled')).toBeDefined();
    await w.find('[data-track="backup-codes-saved"]').setValue(true);
    await done().trigger('click');
    await flushPromises();
    expect(w.text()).toContain('On');
    expect(w.text()).toContain('10 of 10 backup codes unused');
  });

  it('asks for the password before fresh codes or turning it off', async () => {
    auth.totpStatus.mockResolvedValue({ enabled: true, backup_codes_remaining: 2 });
    const w = mount(TwoFactorSettings);
    await flushPromises();
    expect(w.text()).toContain('get a fresh set');
    const regen = () => w.find('[data-track="twofactor-regenerate"]');
    const off = () => w.find('[data-track="twofactor-disable"]');
    expect(regen().attributes('disabled')).toBeDefined();
    expect(off().attributes('disabled')).toBeDefined();
    await w.find('#twofactor-password').setValue('pw');
    await regen().trigger('click');
    await flushPromises();
    expect(auth.totpRegenerateBackupCodes).toHaveBeenCalledWith('pw');
    expect(w.text()).toContain('Fresh backup codes');
    expect(w.findAll('.codes li')).toHaveLength(10);
  });

  it('turns it off with the password and reloads the status', async () => {
    auth.totpStatus.mockResolvedValueOnce({ enabled: true, backup_codes_remaining: 7 });
    auth.totpStatus.mockResolvedValueOnce({ enabled: false, backup_codes_remaining: 0 });
    const w = mount(TwoFactorSettings);
    await flushPromises();
    await w.find('#twofactor-password').setValue('pw');
    await w.find('[data-track="twofactor-disable"]').trigger('click');
    await flushPromises();
    expect(auth.totpDisable).toHaveBeenCalledWith('pw');
    expect(w.text()).toContain('Off');
  });

  it('shows the server message when the password is wrong', async () => {
    auth.totpStatus.mockResolvedValue({ enabled: true, backup_codes_remaining: 7 });
    auth.totpDisable.mockRejectedValue({ response: { data: { error: 'Password is incorrect' } } });
    const w = mount(TwoFactorSettings);
    await flushPromises();
    await w.find('#twofactor-password').setValue('bad');
    await w.find('[data-track="twofactor-disable"]').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Password is incorrect');
    expect(w.text()).toContain('On');
  });
});
