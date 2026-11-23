import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const api = { get: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const { useFeaturesStore } = await import('../../../src/stores/features.js');

beforeEach(() => {
  setActivePinia(createPinia());
  api.get.mockReset();
});

describe('features store', () => {
  it('starts with every switch off and nothing loaded', () => {
    const store = useFeaturesStore();
    expect(store.ipv6).toBe(false);
    expect(store.loaded).toBe(false);
  });

  it('loads the switches from /features', async () => {
    api.get.mockResolvedValueOnce({ data: { ipv6: true } });
    const store = useFeaturesStore();
    await store.load();
    expect(api.get).toHaveBeenCalledWith('/features');
    expect(store.ipv6).toBe(true);
    expect(store.loaded).toBe(true);
  });

  it('keeps the switches off when the read fails, but counts as loaded', async () => {
    api.get.mockRejectedValueOnce(new Error('offline'));
    const store = useFeaturesStore();
    await store.load();
    expect(store.ipv6).toBe(false);
    expect(store.loaded).toBe(true);
  });

  it('only the literal true turns a switch on', () => {
    const store = useFeaturesStore();
    store.set({ ipv6: 'true' });
    expect(store.ipv6).toBe(false);
    store.set({ ipv6: true });
    expect(store.ipv6).toBe(true);
    store.set({});
    expect(store.ipv6).toBe(false);
  });

  it('reads as a single box until the server says otherwise', () => {
    const store = useFeaturesStore();
    expect(store.instance).toEqual({
      mode: 'controller',
      controller_name: null,
      controller_url: null,
      members: 0,
      sync: null,
      serves_dhcp: true,
      fenced: false,
      fenced_by: null,
      handover_to: null,
    });
    expect(store.isMember).toBe(false);
    expect(store.frozen).toBe(false);
    // A server older than 0.7.0 sends no instance at all.
    store.set({ ipv6: true });
    expect(store.instance.mode).toBe('controller');
    expect(store.isMember).toBe(false);
  });

  it("keeps a member's controller URL only when it is https", () => {
    const store = useFeaturesStore();
    const url = 'https://[2001:db8::10]:443';
    store.set({ instance: { mode: 'member', controller_name: 'ns1', controller_url: url } });
    expect(store.instance.controller_url).toBe(url);
    store.set({ instance: { mode: 'member', controller_url: 'javascript:alert(1)' } });
    expect(store.instance.controller_url).toBeNull();
  });

  it('reads whether this box serves DHCP, and the old rule from a server that does not say', () => {
    const store = useFeaturesStore();
    store.set({ instance: { mode: 'member', controller_name: 'ns1', serves_dhcp: true } });
    expect(store.instance.serves_dhcp).toBe(true);
    store.set({ instance: { mode: 'controller', members: 1, serves_dhcp: false } });
    expect(store.instance.serves_dhcp).toBe(false);
    // Before DHCP could move, the controller served it and a member never did.
    store.set({ instance: { mode: 'member', controller_name: 'ns1' } });
    expect(store.instance.serves_dhcp).toBe(false);
    store.set({ instance: { mode: 'controller', members: 1 } });
    expect(store.instance.serves_dhcp).toBe(true);
  });

  it('exposes the instance mode from /features', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        instance: {
          mode: 'member',
          controller_name: 'ns1',
          members: 0,
          sync: { state: 'behind', last_sync_at: '2026-11-21T10:00:00Z', last_error: null },
        },
      },
    });
    const store = useFeaturesStore();
    await store.load();
    expect(store.isMember).toBe(true);
    expect(store.instance.controller_name).toBe('ns1');
    expect(store.instance.sync.state).toBe('behind');

    store.set({ instance: { mode: 'controller', controller_name: null, members: 2, sync: null } });
    expect(store.isMember).toBe(false);
    expect(store.instance.members).toBe(2);
  });

  it('a controller that was replaced, or is handing over, is frozen', () => {
    const store = useFeaturesStore();
    store.set({ instance: { mode: 'controller', members: 2 } });
    expect(store.frozen).toBe(false);
    store.set({ instance: { mode: 'controller', members: 2, fenced: true, fenced_by: 'ns2' } });
    expect(store.instance).toMatchObject({ fenced: true, fenced_by: 'ns2', handover_to: null });
    expect(store.frozen).toBe(true);
    store.set({ instance: { mode: 'controller', members: 2, fenced: false, handover_to: 'ns2' } });
    expect(store.instance.handover_to).toBe('ns2');
    expect(store.frozen).toBe(true);
    // Only the literal true fences, and a member is read-only by its own rule.
    store.set({ instance: { mode: 'controller', members: 2, fenced: 'yes', handover_to: null } });
    expect(store.frozen).toBe(false);
    store.set({ instance: { mode: 'member', controller_name: 'ns1', handover_to: 'ns2' } });
    expect(store.frozen).toBe(false);
  });

  it('reset makes the next navigation read the features again', async () => {
    api.get.mockResolvedValue({ data: {} });
    const store = useFeaturesStore();
    await store.load();
    expect(store.loaded).toBe(true);
    store.reset();
    expect(store.loaded).toBe(false);
  });
});
