/**
 * Settings > General > Servers: shows which stack serves DNS and DHCP, each
 * stack's daemons and whether they are installed, what a switch gains and
 * loses, asks before switching, and refreshes the feature switches after one.
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

const ServerStackSettings = (await import('../../../src/views/settings/ServerStackSettings.vue'))
  .default;

const STATE = {
  current: 'dnsmasq',
  label: 'dnsmasq',
  switching: false,
  stacks: [
    { name: 'dnsmasq', label: 'dnsmasq', daemons: ['dnsmasq'], installed: { ok: true } },
    {
      name: 'pdns-kea',
      label: 'PowerDNS + Kea',
      daemons: ['PowerDNS', 'Kea', 'radvd'],
      installed: { ok: true },
    },
  ],
  targets: [
    {
      name: 'pdns-kea',
      label: 'PowerDNS + Kea',
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

const switchButton = (w) =>
  w.findAll('button').find((b) => b.text() === 'Switch to PowerDNS + Kea');

describe('ServerStackSettings', () => {
  it('shows both stacks, the one serving, and what PowerDNS + Kea would add', async () => {
    const w = mount(ServerStackSettings);
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/backend-stack');
    const cards = w.findAll('[data-track="server-stack-card"]');
    expect(cards.map((c) => c.attributes('data-stack'))).toEqual(['dnsmasq', 'pdns-kea']);
    expect(cards[0].text()).toContain('Serving now');
    expect(cards[1].text()).toContain('PowerDNS, Kea, radvd');
    expect(w.text()).toContain('Adds Subnets behind a DHCP relay, DHCP audit log');
    expect(w.text()).not.toContain('Loses');
    expect(switchButton(w).attributes('disabled')).toBeUndefined();
  });

  it('shows why a switch cannot run, and disables it', async () => {
    api.get.mockResolvedValue({
      data: {
        ...STATE,
        targets: [{ ...STATE.targets[0], blocked: 'radvd is not installed: radvd was not found' }],
        stacks: [
          STATE.stacks[0],
          {
            ...STATE.stacks[1],
            installed: { ok: false, reason: 'radvd is not installed: radvd was not found' },
          },
        ],
      },
    });
    const w = mount(ServerStackSettings);
    await flushPromises();
    expect(w.find('[data-track="server-stack-blocked"]').text()).toBe(
      'radvd is not installed: radvd was not found',
    );
    expect(w.findAll('[data-track="server-stack-card"]')[1].text()).toContain('Not installed');
    expect(switchButton(w).attributes('disabled')).toBeDefined();
  });

  it('lets only an administrator switch', async () => {
    auth.isAdmin = false;
    const w = mount(ServerStackSettings);
    await flushPromises();
    expect(switchButton(w).attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('Only an administrator can switch.');
  });

  it('asks first, switches, then reloads the server and the features', async () => {
    api.post.mockResolvedValue({
      data: { from: 'dnsmasq', to: 'pdns-kea', leases: 3, added: 3, failed: [], missing: [] },
    });
    const w = mount(ServerStackSettings);
    await flushPromises();
    await switchButton(w).trigger('click');
    expect(w.find('.confirm h2').text()).toBe('Switch to PowerDNS + Kea?');
    expect(api.post).not.toHaveBeenCalled();

    api.get.mockResolvedValue({
      data: { ...STATE, current: 'pdns-kea', label: 'PowerDNS + Kea', targets: [] },
    });
    await w.find('.go').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/backend-stack', { stack: 'pdns-kea' });
    expect(features.reload).toHaveBeenCalled();
    expect(w.text()).toContain('PowerDNS + Kea serves DNS and DHCP');
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'success',
        detail: 'PowerDNS + Kea serves DNS and DHCP. 3 of 3 lease(s) moved.',
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
    const w = mount(ServerStackSettings);
    await flushPromises();
    await switchButton(w).trigger('click');
    await w.find('.go').trigger('click');
    await flushPromises();
    const outcome = w.find('[data-track="server-stack-outcome"]').text();
    expect(outcome).toContain('PowerDNS + Kea refused 1 lease(s): 10.0.0.9 (no subnet)');
    expect(outcome).toContain('/var/lib/cidrella/handover/x.json');
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn' }));
  });

  it('says why a switch stopped', async () => {
    api.post.mockRejectedValue({
      response: { data: { error: 'The switch to PowerDNS + Kea stopped (start): no sockets.' } },
    });
    const w = mount(ServerStackSettings);
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
