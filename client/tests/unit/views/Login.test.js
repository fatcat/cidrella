/**
 * Sign-in with two-factor on: the password earns a challenge and the form
 * turns into a code prompt; the code (or a backup code) finishes the login.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { auth, router } = vi.hoisted(() => ({
  auth: { login: vi.fn(), loginTotp: vi.fn() },
  router: { push: vi.fn() },
}));
vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => ({ query: {} }) }));
vi.mock('../../../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('../../../src/utils/landing.js', () => ({ landingPath: () => '/networks' }));

const TextStub = {
  props: ['modelValue', 'id'],
  emits: ['update:modelValue'],
  template:
    '<input :id="id" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const ButtonStub = {
  props: ['label', 'type', 'loading'],
  emits: ['click'],
  template: '<button :type="type || \'button\'" @click="$emit(\'click\')">{{ label }}</button>',
};
vi.mock('../../../src/ui/InputText.js', () => ({ default: TextStub }));
vi.mock('../../../src/ui/Password.js', () => ({ default: TextStub }));
vi.mock('../../../src/ui/Button.js', () => ({ default: ButtonStub }));
vi.mock('../../../src/ui/Message.js', () => ({
  default: { template: '<div class="msg"><slot /></div>' },
}));

const Login = (await import('../../../src/views/Login.vue')).default;

const session = { token: 't', user: { username: 'admin', must_change_password: false } };

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

async function signIn(w) {
  await w.find('#username').setValue('admin');
  await w.find('#password').setValue('pw');
  await w.find('form').trigger('submit');
  await flushPromises();
}

describe('Login with two-factor', () => {
  it('goes straight through when the account has no second factor', async () => {
    auth.login.mockResolvedValue(session);
    const w = mount(Login);
    await signIn(w);
    expect(router.push).toHaveBeenCalledWith('/networks');
    expect(w.find('[data-track="login-totp-form"]').exists()).toBe(false);
  });

  it('asks for the code after the password and finishes with loginTotp', async () => {
    auth.login.mockResolvedValue({ totp_required: true, challenge: 'chal' });
    auth.loginTotp.mockResolvedValue(session);
    const w = mount(Login);
    await signIn(w);
    expect(router.push).not.toHaveBeenCalled();
    expect(w.find('[data-track="login-totp-form"]').exists()).toBe(true);
    await w.find('#totp-code').setValue(' 123456 ');
    await w.find('[data-track="login-totp-form"]').trigger('submit');
    await flushPromises();
    expect(auth.loginTotp).toHaveBeenCalledWith('chal', '123456');
    expect(router.push).toHaveBeenCalledWith('/networks');
  });

  it('shows a wrong code as an error and stays on the code prompt', async () => {
    auth.login.mockResolvedValue({ totp_required: true, challenge: 'chal' });
    auth.loginTotp.mockRejectedValue({
      response: { status: 401, data: { error: 'That code did not work' } },
    });
    const w = mount(Login);
    await signIn(w);
    await w.find('#totp-code').setValue('000000');
    await w.find('[data-track="login-totp-form"]').trigger('submit');
    await flushPromises();
    expect(w.text()).toContain('That code did not work');
    expect(w.find('[data-track="login-totp-form"]').exists()).toBe(true);
  });

  it('drops back to the password form when the challenge has expired', async () => {
    auth.login.mockResolvedValue({ totp_required: true, challenge: 'chal' });
    auth.loginTotp.mockRejectedValue({
      response: { status: 401, data: { error: 'Sign in again' } },
    });
    const w = mount(Login);
    await signIn(w);
    await w.find('#totp-code').setValue('123456');
    await w.find('[data-track="login-totp-form"]').trigger('submit');
    await flushPromises();
    expect(w.find('[data-track="login-totp-form"]').exists()).toBe(false);
    expect(w.find('#username').exists()).toBe(true);
  });

  it('remembers a low backup-code count for the shell to mention', async () => {
    auth.login.mockResolvedValue({ totp_required: true, challenge: 'chal' });
    auth.loginTotp.mockResolvedValue({ ...session, backup_codes_remaining: 1 });
    const w = mount(Login);
    await signIn(w);
    await w.find('#totp-code').setValue('abcde-fghjk');
    await w.find('[data-track="login-totp-form"]').trigger('submit');
    await flushPromises();
    expect(sessionStorage.getItem('cidrella_backup_codes_low')).toBe('1');
  });
});
