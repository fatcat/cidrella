/**
 * Settings > DHCP > Server: shows which server serves DHCP and what a switch
 * gains and loses, asks before switching, and refreshes the feature switches
 * after one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { auth, api, toast, features } = vi.hoisted(() => ({
  auth: { isAdmin: true },
  api: { get: vi.fn(), post: vi.fn() },
  toast: { add: vi.fn() },
  features: { reload: vi.fn(() => Promise.resolve()) },
}));
vi.mock('../../../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/composables/useFeatures.js', () => ({ useFeatures: () => features }));
vi.mock('../../../src/ui/Button.js', () => ({
  default: {
    props: ['label', 'disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
  },
}));
vi.mock('../../../src/components/ConfirmDialog.vue', () => ({
  default: {
    props: ['visible', 'header'],
    emits: ['confirm', 'update:visible'],
    template:
      '<div v-if="visible" class="confirm"><h2>{{ header }}</h2><slot /><button class="go" @click="$emit(\'confirm\')">Switch</button></div>',
  },
}));

const DhcpServerSettings = (await import('../../../src/views/settings/DhcpServerSettings.vue'))
  .default;

const STATE = {
  current: 'dnsmasq',
  label: 'dnsmasq',
  switching: false,
  targets: [
    {
      name: 'kea',
      label: 'Kea',
      blocked: null,
      gained: [
        { id: 'dhcp-relay', label: 'Subnets behind a DHCP relay' },
        { id: 'forensic-log', label: 'DHCP audit log' },
      ],
      lost: [],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAdmin = true;
  api.get.mockResolvedValue({ data: STATE });
});

const switchButton = (w) => w.findAll('button').find((b) => b.text() === 'Switch to Kea');

describe('DhcpServerSettings', () => {
  it('names the server and what Kea would add', async () => {
    const w = mount(DhcpServerSettings);
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/dhcp/server');
    expect(w.text()).toContain('dnsmasq serves DHCP');
    expect(w.text()).toContain('Adds Subnets behind a DHCP relay, DHCP audit log');
    expect(w.text()).not.toContain('Loses');
    expect(switchButton(w).attributes('disabled')).toBeUndefined();
  });

  it('shows why a switch cannot run, and disables it', async () => {
    api.get.mockResolvedValue({
      data: {
        ...STATE,
        targets: [
          { ...STATE.targets[0], blocked: 'Kea is not installed: kea-dhcp4 was not found' },
        ],
      },
    });
    const w = mount(DhcpServerSettings);
    await flushPromises();
    expect(w.find('[data-track="dhcp-server-blocked"]').text()).toBe(
      'Kea is not installed: kea-dhcp4 was not found',
    );
    expect(switchButton(w).attributes('disabled')).toBeDefined();
  });

  it('lets only an administrator switch', async () => {
    auth.isAdmin = false;
    const w = mount(DhcpServerSettings);
    await flushPromises();
    expect(switchButton(w).attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('Only an administrator can switch.');
  });

  it('asks first, switches, then reloads the server and the features', async () => {
    api.post.mockResolvedValue({
      data: { from: 'dnsmasq', to: 'kea', leases: 3, added: 3, failed: [], missing: [] },
    });
    const w = mount(DhcpServerSettings);
    await flushPromises();
    await switchButton(w).trigger('click');
    expect(w.find('.confirm h2').text()).toBe('Switch DHCP to Kea?');
    expect(api.post).not.toHaveBeenCalled();

    api.get.mockResolvedValue({ data: { ...STATE, current: 'kea', label: 'Kea', targets: [] } });
    await w.find('.go').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/dhcp/server', { target: 'kea' });
    expect(features.reload).toHaveBeenCalled();
    expect(w.text()).toContain('Kea serves DHCP');
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'success',
        detail: 'Kea serves DHCP. 3 of 3 lease(s) moved.',
      }),
    );
  });

  it('lists leases the new server refused, and where the rest are kept', async () => {
    api.post.mockResolvedValue({
      data: {
        leases: 2,
        added: 1,
        failed: [{ ip: '10.0.0.9', error: 'no subnet' }],
        missing: [],
        snapshot: '/var/lib/cidrella/handover/x.json',
      },
    });
    const w = mount(DhcpServerSettings);
    await flushPromises();
    await switchButton(w).trigger('click');
    await w.find('.go').trigger('click');
    await flushPromises();
    const outcome = w.find('[data-track="dhcp-server-outcome"]').text();
    expect(outcome).toContain('Kea refused 1 lease(s): 10.0.0.9 (no subnet)');
    expect(outcome).toContain('/var/lib/cidrella/handover/x.json');
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn' }));
  });

  it('says why a switch stopped', async () => {
    api.post.mockRejectedValue({
      response: { data: { error: 'The switch to Kea stopped (serve): no sockets.' } },
    });
    const w = mount(DhcpServerSettings);
    await flushPromises();
    await switchButton(w).trigger('click');
    await w.find('.go').trigger('click');
    await flushPromises();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', summary: 'Switch stopped' }),
    );
    expect(features.reload).toHaveBeenCalled();
  });
});
