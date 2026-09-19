/**
 * The first-run wizard: resumes at the first unfinished step, the password
 * step is gated on the server's policy and hands off through the auth store,
 * the deployment step locks the column the role rules out and saves only the
 * ticked interfaces, the import step blocks until its source is usable, and
 * Start applies everything in order (or restores, and only restores).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

const { api, auth, subnets, ops, toast, router, pihole } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
  auth: {
    user: { username: 'admin', must_change_password: true, setup_required: true },
    mustChangePassword: true,
    totpEnabled: false,
    changePassword: vi.fn(),
    totpSetup: vi.fn(),
    totpEnable: vi.fn(),
    fetchUser: vi.fn(),
    logout: vi.fn(),
  },
  subnets: { createSupernet: vi.fn(), configureSubnet: vi.fn(), updateSetting: vi.fn() },
  ops: { restoreBackup: vi.fn() },
  toast: { add: vi.fn() },
  router: { push: vi.fn() },
  pihole: {},
}));

vi.mock('vue-router', () => ({ useRouter: () => router }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));
// Reactive on purpose: the two-factor step must keep showing the backup codes
// after the store flips totpEnabled, which a plain object would never exercise.
vi.mock('../../../src/stores/auth.js', async () => {
  const { reactive } = await import('vue');
  const live = reactive(auth);
  return { useAuthStore: () => live };
});
vi.mock('../../../src/stores/subnets.js', () => ({ useSubnetStore: () => subnets }));
vi.mock('../../../src/stores/operations.js', () => ({ useOperationsStore: () => ops }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/composables/usePiholeImport.js', () => ({
  usePiholeImport: () => pihole,
}));
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,QR') },
}));

// The UI shims wrap vendor components; plain elements keep the v-model and
// click contracts without the vendor's DOM.
const ButtonStub = {
  props: ['label', 'disabled', 'loading', 'type', 'form'],
  emits: ['click'],
  template:
    '<button :type="type || \'button\'" :form="form" :disabled="disabled || loading" @click="$emit(\'click\')">{{ label }}</button>',
};
const TextStub = {
  props: ['modelValue', 'id', 'readonly'],
  emits: ['update:modelValue'],
  template:
    '<input :id="id" :value="modelValue" :readonly="readonly" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const PasswordStub = {
  props: ['modelValue', 'inputId', 'inputProps'],
  emits: ['update:modelValue'],
  template:
    '<input type="password" :id="inputId" :name="inputProps?.name" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const SwitchStub = {
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  template:
    '<input type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
};
vi.mock('../../../src/ui/Button.js', () => ({ default: ButtonStub }));
vi.mock('../../../src/ui/InputText.js', () => ({ default: TextStub }));
vi.mock('../../../src/ui/Password.js', () => ({ default: PasswordStub }));
vi.mock('../../../src/ui/ToggleSwitch.js', () => ({ default: SwitchStub }));
vi.mock('../../../src/ui/Checkbox.js', () => ({ default: SwitchStub }));
vi.mock('../../../src/ui/Tag.js', () => ({ default: { template: '<span />' } }));
vi.mock('../../../src/ui/Message.js', () => ({
  default: { template: '<div class="msg"><slot /></div>' },
}));

const FirstRun = (await import('../../../src/views/FirstRun.vue')).default;
const { useSetupStore } = await import('../../../src/stores/setup.js');

const POLICY = {
  minLength: 8,
  maxLength: 1024,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
};
const IFACES = [
  { name: 'eth0', addresses: [{ address: '10.0.0.8/24', family: 4 }], state: 'up' },
  { name: 'eth1', addresses: [], state: 'down' },
];

const LENGTH_ONLY = {
  ...POLICY,
  requireUppercase: false,
  requireLowercase: false,
  requireDigit: false,
};

function serverState(overrides = {}) {
  return {
    password: false,
    totp: null,
    deployment: null,
    import: null,
    done: false,
    password_policy: POLICY,
    password_complexity: true,
    ...overrides,
  };
}

function mountWizard(state) {
  api.get.mockImplementation((url) => {
    if (url === '/setup/state') return Promise.resolve({ data: state });
    if (url === '/interfaces') return Promise.resolve({ data: IFACES });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  api.put.mockImplementation((url, body) => {
    if (url === '/setup/state') {
      const { password_complexity: complexity, ...markers } = body;
      Object.assign(state, markers);
      if (complexity !== undefined) {
        state.password_complexity = complexity;
        state.password_policy = complexity ? POLICY : LENGTH_ONLY;
      }
      return Promise.resolve({ data: { ...state } });
    }
    return Promise.resolve({ data: {} });
  });
  return mount(FirstRun, { attachTo: globalThis.document.body });
}

const stepOf = (w) => Number(w.find('.fr-steps li.active').attributes('data-step'));
const setInput = async (w, sel, value) => {
  const el = w.find(sel);
  el.element.value = value;
  await el.trigger('input');
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  Object.assign(pihole, {
    tab: ref('online'),
    url: ref(''),
    password: ref(''),
    probeStatus: ref(null),
    probeError: ref(''),
    needsPassword: ref(false),
    fetching: ref(false),
    parsing: ref(false),
    importing: ref(false),
    preview: ref(null),
    importResults: ref(null),
    fileContent: ref(null),
    fileInput: ref(null),
    fetchConfig: vi.fn(),
    parseFile: vi.fn(),
    onFileSelect: vi.fn(),
    executeImport: vi.fn(),
  });
  auth.user = { username: 'admin', must_change_password: true, setup_required: true };
  auth.mustChangePassword = true;
  auth.totpEnabled = false;
  auth.changePassword.mockResolvedValue({});
  auth.totpSetup.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauth_url: 'otpauth://totp/x' });
  auth.totpEnable.mockImplementation(async () => {
    auth.totpEnabled = true;
    return { backup_codes: Array.from({ length: 10 }, (_, i) => `code${i}-abcde`) };
  });
  auth.fetchUser.mockResolvedValue({});
  subnets.createSupernet.mockResolvedValue({ id: 7 });
  subnets.configureSubnet.mockResolvedValue({});
  subnets.updateSetting.mockResolvedValue({});
  ops.restoreBackup.mockResolvedValue({ ok: true });
});

describe('resume', () => {
  it('starts at the password step on a fresh appliance', async () => {
    const w = mountWizard(serverState());
    await flushPromises();
    expect(stepOf(w)).toBe(1);
    w.unmount();
  });

  it('skips to the first unfinished step and restores the earlier answers', async () => {
    auth.mustChangePassword = false;
    const w = mountWizard(
      serverState({
        password: true,
        totp: 'skipped',
        deployment: { role: 'dns', interfaces: { eth0: { dns: true, dhcp: false } } },
      }),
    );
    await flushPromises();
    expect(stepOf(w)).toBe(4);
    expect(useSetupStore().draft.role).toBe('dns');
    w.unmount();
  });

  it('stops at the two-factor step when the password is done but no choice was made', async () => {
    auth.mustChangePassword = false;
    const w = mountWizard(serverState({ password: true }));
    await flushPromises();
    expect(stepOf(w)).toBe(2);
    w.unmount();
  });

  it('goes back to the password step when the password still has to change', async () => {
    auth.mustChangePassword = true;
    const w = mountWizard(serverState({ password: true }));
    await flushPromises();
    expect(stepOf(w)).toBe(1);
    w.unmount();
  });
});

describe('password step', () => {
  it('holds the button until the current password, the policy and the match are satisfied', async () => {
    const w = mountWizard(serverState());
    await flushPromises();
    const submit = () => w.find('[data-track="first-run-password-submit"]');
    expect(submit().attributes('disabled')).toBeDefined();

    await setInput(w, '#fr-current', 'installer-pw');
    await setInput(w, '#fr-new', 'weak');
    await setInput(w, '#fr-confirm', 'weak');
    expect(submit().attributes('disabled')).toBeDefined();
    expect(w.findAll('.fr-checks li.ok')).toHaveLength(1); // only "a lowercase letter"

    await setInput(w, '#fr-new', 'Strong-pass1');
    expect(submit().attributes('disabled')).toBeDefined(); // confirm no longer matches
    await setInput(w, '#fr-confirm', 'Strong-pass1');
    expect(submit().attributes('disabled')).toBeUndefined();
    expect(w.findAll('.fr-checks li.ok')).toHaveLength(4);
    w.unmount();
  });

  it('lets the operator drop the complexity rule, and the checklist follows the served policy', async () => {
    const w = mountWizard(serverState());
    await flushPromises();
    expect(w.findAll('.fr-checks li')).toHaveLength(4);
    await w.find('[data-track="first-run-password-complexity"]').setValue(false);
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/setup/state', { password_complexity: false });
    expect(w.findAll('.fr-checks li')).toHaveLength(1);
    await setInput(w, '#fr-current', 'installer-pw');
    await setInput(w, '#fr-new', 'aaaaaaaa');
    await setInput(w, '#fr-confirm', 'aaaaaaaa');
    expect(
      w.find('[data-track="first-run-password-submit"]').attributes('disabled'),
    ).toBeUndefined();
    w.unmount();
  });

  it('is a real form with named autocomplete fields', async () => {
    const w = mountWizard(serverState());
    await flushPromises();
    const form = w.find('form#first-run-password');
    expect(form.exists()).toBe(true);
    expect(form.find('input[name="username"]').exists()).toBe(true);
    expect(form.find('input[name="new-password"]').exists()).toBe(true);
    expect(w.find('[data-track="first-run-password-submit"]').attributes('form')).toBe(
      'first-run-password',
    );
    w.unmount();
  });

  it('changes the password through the auth store, marks the step and moves on', async () => {
    const w = mountWizard(serverState());
    await flushPromises();
    await setInput(w, '#fr-current', 'installer-pw');
    await setInput(w, '#fr-new', 'Strong-pass1');
    await setInput(w, '#fr-confirm', 'Strong-pass1');
    await w.find('form#first-run-password').trigger('submit');
    await flushPromises();
    expect(auth.changePassword).toHaveBeenCalledWith('installer-pw', 'Strong-pass1');
    expect(api.put).toHaveBeenCalledWith('/setup/state', { password: true });
    expect(stepOf(w)).toBe(2);
    w.unmount();
  });

  it('shows the server error and stays put when the current password is wrong', async () => {
    auth.changePassword.mockRejectedValue({
      response: { data: { error: 'Current password is incorrect' } },
    });
    const w = mountWizard(serverState());
    await flushPromises();
    await setInput(w, '#fr-current', 'wrong');
    await setInput(w, '#fr-new', 'Strong-pass1');
    await setInput(w, '#fr-confirm', 'Strong-pass1');
    await w.find('form#first-run-password').trigger('submit');
    await flushPromises();
    expect(w.text()).toContain('Current password is incorrect');
    expect(stepOf(w)).toBe(1);
    expect(api.put).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe('two-factor step', () => {
  async function atTotp() {
    auth.mustChangePassword = false;
    const w = mountWizard(serverState({ password: true }));
    await flushPromises();
    expect(stepOf(w)).toBe(2);
    return w;
  }

  it('cannot continue without a choice; skipping marks it and moves on', async () => {
    const w = await atTotp();
    const cont = () => w.find('[data-track="first-run-totp-continue"]');
    expect(cont().attributes('disabled')).toBeDefined();
    await w.find('[data-track="first-run-totp-skip"]').trigger('click');
    expect(cont().text()).toBe('Skip and continue');
    await cont().trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/setup/state', { totp: 'skipped' });
    expect(auth.totpSetup).not.toHaveBeenCalled();
    expect(stepOf(w)).toBe(3);
    w.unmount();
  });

  it('enrols: setup, QR, verify, backup codes shown once, confirmation before continuing', async () => {
    const w = await atTotp();
    await w.find('[data-track="first-run-totp-app"]').trigger('click');
    await flushPromises();
    expect(auth.totpSetup).toHaveBeenCalledTimes(1);
    expect(w.find('img.qr').attributes('src')).toBe('data:image/png;base64,QR');
    expect(w.find('[data-track="totp-secret"]').text()).toBe('JBSW Y3DP EHPK 3PXP');
    const cont = () => w.find('[data-track="first-run-totp-continue"]');
    expect(cont().attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('Verify a code from the app first');

    const verify = () => w.find('[data-track="totp-verify"]');
    expect(verify().attributes('disabled')).toBeDefined();
    await setInput(w, '#totp-code', '123 456');
    expect(verify().attributes('disabled')).toBeUndefined();
    await verify().trigger('click');
    await flushPromises();
    expect(auth.totpEnable).toHaveBeenCalledWith('123456');
    const codes = w.findAll('.codes li').map((li) => li.text());
    expect(codes).toHaveLength(10);
    expect(codes[0]).toBe('code0-abcde');
    expect(cont().attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('Confirm the backup codes are saved');

    await w.find('[data-track="backup-codes-saved"]').setValue(true);
    expect(cont().attributes('disabled')).toBeUndefined();
    await cont().trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/setup/state', { totp: 'enabled' });
    expect(stepOf(w)).toBe(3);
    w.unmount();
  });

  it('a wrong code keeps enrolment open with the server message', async () => {
    auth.totpEnable.mockRejectedValueOnce({
      response: { data: { error: 'That code did not match.' } },
    });
    const w = await atTotp();
    await w.find('[data-track="first-run-totp-app"]').trigger('click');
    await flushPromises();
    await setInput(w, '#totp-code', '000000');
    await w.find('[data-track="totp-verify"]').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('That code did not match.');
    expect(w.find('.codes').exists()).toBe(false);
    expect(stepOf(w)).toBe(2);
    w.unmount();
  });

  it('shows the already-on state on a resumed setup and just marks it', async () => {
    auth.totpEnabled = true;
    const w = await atTotp();
    expect(w.text()).toContain('Two-factor is already on');
    await w.find('[data-track="first-run-totp-continue"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/setup/state', { totp: 'enabled' });
    expect(stepOf(w)).toBe(3);
    w.unmount();
  });
});

describe('deployment step', () => {
  async function atDeployment() {
    auth.mustChangePassword = false;
    const w = mountWizard(serverState({ password: true, totp: 'skipped' }));
    await flushPromises();
    expect(stepOf(w)).toBe(3);
    return w;
  }

  it('ticks every usable interface for both services by default', async () => {
    const w = await atDeployment();
    const rows = w.findAll('.fr-table tbody tr');
    expect(rows).toHaveLength(2);
    const [eth0, eth1] = rows;
    expect(eth0.findAll('input[type="checkbox"]').map((c) => c.element.checked)).toEqual([
      true,
      true,
    ]);
    expect(eth1.findAll('input[type="checkbox"]').map((c) => c.element.checked)).toEqual([
      false,
      false,
    ]);
    w.unmount();
  });

  it('locks the DHCP column for DNS only and saves only the DNS interfaces', async () => {
    const w = await atDeployment();
    await w.find('[data-track="first-run-role-dns"]').trigger('click');
    const dhcpSwitches = w.findAll('[data-track="first-run-iface-dhcp"]');
    expect(dhcpSwitches.every((s) => s.attributes('disabled') !== undefined)).toBe(true);
    expect(w.text()).toContain('DHCP is switched off globally');

    await w.find('[data-track="first-run-deployment-continue"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/setup/state', {
      deployment: { role: 'dns', interfaces: { eth0: { dns: true, dhcp: false } } },
    });
    expect(stepOf(w)).toBe(4);
    w.unmount();
  });

  it('refuses to continue with no interface ticked for the role', async () => {
    const w = await atDeployment();
    const eth0 = w.findAll('.fr-table tbody tr')[0];
    for (const box of eth0.findAll('input[type="checkbox"]')) await box.setValue(false);
    const cont = w.find('[data-track="first-run-deployment-continue"]');
    expect(cont.attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('Pick at least one interface');
    w.unmount();
  });
});

describe('import step and start', () => {
  async function atImport(role = 'both') {
    auth.mustChangePassword = false;
    const w = mountWizard(
      serverState({
        password: true,
        totp: 'skipped',
        deployment: { role, interfaces: { eth0: { dns: role !== 'dhcp', dhcp: role !== 'dns' } } },
      }),
    );
    await flushPromises();
    expect(stepOf(w)).toBe(4);
    return w;
  }

  it('starts fresh: marks the import, then Start applies interfaces, finishes and opens the workspace', async () => {
    const w = await atImport('dns');
    await w.find('[data-track="first-run-import-continue"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/setup/state', { import: { kind: 'fresh' } });
    expect(stepOf(w)).toBe(5);
    expect(w.text()).toContain('Ready to start');

    await w.find('[data-track="first-run-start"]').trigger('click');
    await flushPromises();

    const putCalls = api.put.mock.calls.map(([url, body]) => [url, body]);
    const ifaceCall = putCalls.find(([url]) => url === '/interfaces/config');
    expect(ifaceCall[1]).toEqual({
      interfaces: { eth0: { dns: true, dhcp: false } },
      dns_enabled: true,
      dhcp_enabled: false,
    });
    // Order: interfaces applied, classic flag set, state marked done, user refreshed, workspace.
    const order = api.put.mock.invocationCallOrder;
    const ifaceAt = order[putCalls.findIndex(([url]) => url === '/interfaces/config')];
    const doneAt = order[putCalls.findIndex(([, body]) => body?.done === true)];
    expect(ifaceAt).toBeLessThan(subnets.updateSetting.mock.invocationCallOrder[0]);
    expect(subnets.updateSetting).toHaveBeenCalledWith('setup_wizard_completed', 'true');
    expect(subnets.updateSetting.mock.invocationCallOrder[0]).toBeLessThan(doneAt);
    expect(doneAt).toBeLessThan(auth.fetchUser.mock.invocationCallOrder[0]);
    expect(router.push).toHaveBeenCalledWith('/networks');
    expect(ops.restoreBackup).not.toHaveBeenCalled();
    w.unmount();
  });

  it('Pi-hole: blocks until a preview exists, then Start creates the network before importing', async () => {
    const w = await atImport('both');
    await w.find('[data-track="first-run-import-pihole"]').trigger('click');
    let cont = w.find('[data-track="first-run-import-continue"]');
    expect(cont.attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('Fetch or parse the Pi-hole configuration first');

    pihole.preview.value = {
      zoneName: 'home.arpa',
      hosts: [{ name: 'nas', ip: '192.168.1.10' }],
      cnames: [],
      dhcpHosts: [
        { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.20', hostname: 'a' },
        { mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.1.21', hostname: 'b' },
        { mac: 'aa:bb:cc:dd:ee:03', ip: '10.9.9.9', hostname: 'c' },
      ],
    };
    await flushPromises();
    const setup = useSetupStore();
    expect(setup.draft.network).toEqual({ cidr: '192.168.1.0/24', domain: 'home.arpa' });
    expect(w.text()).toContain('1 of 3 fall outside it');

    cont = w.find('[data-track="first-run-import-continue"]');
    expect(cont.attributes('disabled')).toBeUndefined();
    await cont.trigger('click');
    await flushPromises();
    expect(stepOf(w)).toBe(5);

    pihole.executeImport.mockImplementation(async () => {
      pihole.importResults.value = { a: { created: 1 } };
    });
    await w.find('[data-track="first-run-start"]').trigger('click');
    await flushPromises();
    expect(subnets.createSupernet).toHaveBeenCalledWith({ cidr: '192.168.1.0/24' });
    expect(subnets.configureSubnet).toHaveBeenCalledWith(7, {
      name: '192.168.1.0/24',
      domain_name: 'home.arpa',
      create_reverse_dns: true,
      create_dhcp_scope: false,
    });
    expect(subnets.configureSubnet.mock.invocationCallOrder[0]).toBeLessThan(
      pihole.executeImport.mock.invocationCallOrder[0],
    );
    expect(router.push).toHaveBeenCalledWith('/networks');
    w.unmount();
  });

  it('backup: needs a file, and Start restores with the DHCP answer from step 2 and nothing else', async () => {
    const w = await atImport('dns');
    await w.find('[data-track="first-run-import-cidrella"]').trigger('click');
    expect(w.find('[data-track="first-run-import-continue"]').attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('DHCP: off');

    const file = new File(['x'], 'cidrella-backup-2026-09-19.tar.gz');
    const input = w.find('[data-track="first-run-restore-file"]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await w.find('[data-track="first-run-import-continue"]').trigger('click');
    await flushPromises();
    expect(stepOf(w)).toBe(5);
    expect(w.text()).toContain('Ready to restore');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }));
    vi.useFakeTimers();
    await w.find('[data-track="first-run-start"]').trigger('click');
    await flushPromises();
    expect(ops.restoreBackup).toHaveBeenCalledWith(file, { dhcp: 'disabled' });
    expect(api.put.mock.calls.some(([url]) => url === '/interfaces/config')).toBe(false);
    expect(subnets.updateSetting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3500);
    await flushPromises();
    expect(auth.logout).toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith({ name: 'Login' });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    w.unmount();
  });
});
