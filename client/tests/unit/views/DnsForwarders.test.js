/**
 * The Upstream Forwarders card after a save (IPV6-51). The server stores each
 * forwarder in its canonical spelling and answers with that list; the card
 * used to keep the typed text and compare it to the canonical list as
 * strings, so a typed '2001:DB8::1' left the card unsaved forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';

const store = {
  startResolverTest: vi.fn(),
  getResolverTest: vi.fn(),
  cancelResolverTest: vi.fn(),
  getForwarders: vi.fn(),
  updateForwarders: vi.fn(),
  testForwarder: vi.fn(async () => ({ reachable: true })),
  getEncryption: vi.fn(async () => ({ mode: 'off', providers: [], upstreams: [] })),
  updateEncryption: vi.fn(),
  getSoaDefaults: vi.fn(async () => ({})),
  updateSoaDefaults: vi.fn(),
  getDnssec: vi.fn(async () => ({})),
  updateDnssec: vi.fn(),
};
vi.mock('../../../src/stores/dns.js', () => ({ useDnsStore: () => store }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => ({ add: vi.fn() }) }));
vi.mock('../../../src/composables/useFeatures.js', async () => {
  const { computed } = await import('vue');
  return { useFeatures: () => ({ ipv6: computed(() => true), reload: vi.fn() }) };
});

const { default: DNS } = await import('../../../src/views/DNS.vue');
const { UiPlugin } = await import('../../../src/ui/plugin.js');

enableAutoUnmount(afterEach);

beforeEach(() => {
  store.getForwarders.mockResolvedValue({ servers: ['1.1.1.1'], no_recursion: false });
});

const saveButton = (wrapper) => wrapper.find('[data-track="dns-save-upstream"]');

describe('Upstream Forwarders after a save', () => {
  it.each([
    ['2001:DB8::1', '2001:db8::1'],
    ['2606:4700:4700:0:0:0:0:1111', '2606:4700:4700::1111'],
    ['9.9.9.9', '9.9.9.9'],
  ])('is clean after saving %s, stored as %s', async (typed, stored) => {
    store.updateForwarders.mockResolvedValue({
      servers: [stored],
      backup_servers: [],
      backup_mode: 'balance',
      no_recursion: false,
    });
    const wrapper = mount(DNS, {
      attachTo: globalThis.document.body,
      global: { plugins: [[UiPlugin, { unstyled: true }]] },
    });
    await flushPromises();

    const input = wrapper.find('.forwarder-entry input');
    await input.setValue(typed);
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(store.updateForwarders).toHaveBeenCalledWith({
      servers: [typed],
      backup_servers: [],
      backup_mode: 'balance',
      no_recursion: false,
    });
    expect(wrapper.find('.forwarder-entry input').element.value).toBe(stored);
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
  });
});

describe('primary and backup resolvers', () => {
  const QUAD9 = {
    id: 'quad9',
    label: 'Quad9',
    addresses: ['9.9.9.10', '149.112.112.10'],
    hostname: 'dns10.quad9.net',
    doh_url: 'https://dns10.quad9.net/dns-query',
  };
  const CLOUDFLARE = {
    id: 'cloudflare',
    label: 'Cloudflare',
    addresses: ['1.1.1.1', '1.0.0.1'],
    hostname: 'cloudflare-dns.com',
    doh_url: 'https://cloudflare-dns.com/dns-query',
  };
  const upstream = (p) => ({
    label: p.label,
    hostname: p.hostname,
    addresses: p.addresses,
    doh_url: p.doh_url,
  });

  async function mountWith({ mode = 'off', upstreams = [], forwarders }) {
    store.getForwarders.mockResolvedValue({
      servers: QUAD9.addresses,
      backup_servers: [],
      backup_mode: 'balance',
      no_recursion: false,
      ...forwarders,
    });
    store.getEncryption.mockResolvedValue({
      mode,
      upstreams,
      providers: [QUAD9, CLOUDFLARE],
      status: null,
    });
    const wrapper = mount(DNS, {
      attachTo: globalThis.document.body,
      global: { plugins: [[UiPlugin, { unstyled: true }]] },
    });
    await flushPromises();
    return wrapper;
  }

  const pickers = (wrapper) => wrapper.findAllComponents({ name: 'ResolverPicker' });
  const dialog = (wrapper) => wrapper.findComponent({ name: 'ResolverTestDialog' });

  beforeEach(() => {
    store.updateForwarders.mockReset();
    store.updateEncryption.mockReset();
  });

  it('saves a plaintext backup and On failure', async () => {
    const wrapper = await mountWith({});
    expect(wrapper.find('[data-track="dns-backup-mode"]').exists()).toBe(false);

    const [, backup] = pickers(wrapper);
    backup.vm.$emit('update:modelValue', {
      choice: 'cloudflare',
      custom: backup.props().modelValue.custom,
    });
    await flushPromises();
    wrapper.findComponent({ name: 'SelectButton' }).vm.$emit('update:modelValue', 'failover');
    await flushPromises();

    store.updateForwarders.mockResolvedValue({
      servers: QUAD9.addresses,
      backup_servers: CLOUDFLARE.addresses,
      backup_mode: 'failover',
      no_recursion: false,
    });
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(store.updateForwarders).toHaveBeenCalledWith({
      servers: QUAD9.addresses,
      backup_servers: CLOUDFLARE.addresses,
      backup_mode: 'failover',
      no_recursion: false,
    });
    expect(store.updateEncryption).not.toHaveBeenCalled();
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
  });

  it('fills the encrypted backup from a test result and saves both', async () => {
    const wrapper = await mountWith({ mode: 'tls', upstreams: [upstream(QUAD9)] });
    dialog(wrapper).vm.$emit('pick', 'backup', { ...CLOUDFLARE, preset: true });
    await flushPromises();

    store.updateEncryption.mockResolvedValue({ mode: 'tls', status: null });
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(store.updateEncryption).toHaveBeenCalledWith('tls', [
      upstream(QUAD9),
      upstream(CLOUDFLARE),
    ]);
  });

  it('swaps when the backup is picked as the primary, and refuses the primary as backup', async () => {
    const wrapper = await mountWith({
      mode: 'tls',
      upstreams: [upstream(QUAD9), upstream(CLOUDFLARE)],
    });
    dialog(wrapper).vm.$emit('pick', 'backup', { ...QUAD9, preset: true });
    await flushPromises();
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

    dialog(wrapper).vm.$emit('pick', 'primary', { ...CLOUDFLARE, preset: true });
    await flushPromises();
    store.updateEncryption.mockResolvedValue({ mode: 'tls', status: null });
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(store.updateEncryption).toHaveBeenCalledWith('tls', [
      upstream(CLOUDFLARE),
      upstream(QUAD9),
    ]);
  });

  it('offers an IPv6 custom result as a plaintext backup', async () => {
    const wrapper = await mountWith({});
    dialog(wrapper).vm.$emit('pick', 'backup', {
      id: 'custom-1',
      preset: false,
      label: 'fd00::53',
      hostname: '',
      addresses: ['fd00::53'],
    });
    await flushPromises();
    store.updateForwarders.mockResolvedValue({
      servers: QUAD9.addresses,
      backup_servers: ['fd00::53'],
      backup_mode: 'balance',
      no_recursion: false,
    });
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(store.updateForwarders.mock.calls[0][0].backup_servers).toEqual(['fd00::53']);
  });
});
