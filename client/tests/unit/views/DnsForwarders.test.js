/**
 * The Upstream Forwarders card after a save (IPV6-51). The server stores each
 * forwarder in its canonical spelling and answers with that list; the card
 * used to keep the typed text and compare it to the canonical list as
 * strings, so a typed '2001:DB8::1' left the card unsaved forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';

const store = {
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
    store.updateForwarders.mockResolvedValue({ servers: [stored], no_recursion: false });
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

    expect(store.updateForwarders).toHaveBeenCalledWith([typed], false);
    expect(wrapper.find('.forwarder-entry input').element.value).toBe(stored);
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
  });
});
