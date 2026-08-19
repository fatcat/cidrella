/**
 * The Pi-hole import flow, now in one place.
 *
 * It existed twice: PiholeImportPanel.vue (Settings > Integrations) and inline
 * in NetworkDialogs.vue (wizard step 3), roughly 120 lines of near-identical
 * script each. They had already parted company on one line. The wizard fell
 * back to the domain typed in step 2 when the pihole.toml declared no
 * `dns.domain`; the panel did not. So the same file imported cleanly through
 * the wizard and failed with "No zone found" through Settings.
 *
 * That difference is contextual and legitimate, which is why it is now a
 * parameter rather than a reason to keep a second copy of everything around it.
 *
 * See REVIEW.md, duplicate-logic audit #47.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';

const post = vi.fn();
vi.mock('../../../src/api/client.js', () => ({
  default: { post: (...a) => post(...a), get: vi.fn() },
}));

const fetchZones = vi.fn();
const createZone = vi.fn();
const zones = [];
vi.mock('../../../src/stores/dns.js', () => ({
  useDnsStore: () => ({ zones, fetchZones, createZone }),
}));

const { usePiholeImport } = await import('../../../src/composables/usePiholeImport.js');

const toast = { add: vi.fn() };

/**
 * Run a composable inside a real component instance.
 *
 * usePiholeImport registers `onUnmounted` to clear its debounce timer, and the
 * comment where it does so records that the timer used to outlive the
 * component. Calling the composable bare, as these tests originally did, means
 * Vue has no instance to attach that hook to: it warned nine times per run
 * ("onUnmounted is called when there is no active component instance"), and the
 * cleanup path was never executed by any test.
 *
 * So this is not warning suppression. It puts the composable in the context it
 * is written for, which is also the only way the unmount behavior can be
 * asserted at all (see the teardown test at the bottom).
 */
const mounted = [];
function inSetup(fn) {
  let result;
  mounted.push(mount({ setup() { result = fn(); return () => null; } }));
  return result;
}
afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount());
});

beforeEach(() => {
  setActivePinia(createPinia());
  post.mockReset();
  fetchZones.mockReset().mockResolvedValue();
  createZone.mockReset();
  toast.add.mockReset();
  zones.length = 0;
});

// A preview with no zoneName is the case that told the two copies apart.
const previewWithoutZone = { zoneName: null, hosts: [], cnames: [], dhcpHosts: [] };

describe('zone resolution', () => {
  it('uses the zone the file declares', () => {
    const pi = inSetup(() => usePiholeImport({ toast }));
    pi.preview.value = { ...previewWithoutZone, zoneName: 'declared.lan' };
    expect(pi.resolveZoneName()).toBe('declared.lan');
  });

  it('falls back to the caller-supplied zone when the file declares none', () => {
    // The wizard case. Without this, the import failed with "No zone found".
    const pi = inSetup(() => usePiholeImport({ toast, fallbackZoneName: () => 'from-step-2.lan' }));
    pi.preview.value = previewWithoutZone;
    expect(pi.resolveZoneName()).toBe('from-step-2.lan');
  });

  it('prefers the declared zone over the fallback', () => {
    const pi = inSetup(() => usePiholeImport({ toast, fallbackZoneName: () => 'from-step-2.lan' }));
    pi.preview.value = { ...previewWithoutZone, zoneName: 'declared.lan' };
    expect(pi.resolveZoneName()).toBe('declared.lan');
  });

  it('has no fallback when the caller supplies none', () => {
    // The Settings case: there is no wizard domain, and inventing one would be
    // worse than saying so.
    const pi = inSetup(() => usePiholeImport({ toast }));
    pi.preview.value = previewWithoutZone;
    expect(pi.resolveZoneName()).toBeFalsy();
  });
});

describe('executeImport', () => {
  it('creates the fallback zone and imports, rather than failing', async () => {
    const pi = inSetup(() => usePiholeImport({ toast, fallbackZoneName: () => 'from-step-2.lan' }));
    pi.preview.value = previewWithoutZone;
    createZone.mockResolvedValue({ id: 42, name: 'from-step-2.lan', type: 'forward' });
    post.mockResolvedValue({ data: { results: { hosts: 1 } } });

    await pi.executeImport();

    expect(createZone).toHaveBeenCalledWith({ name: 'from-step-2.lan', type: 'forward' });
    expect(post).toHaveBeenCalledWith('/pihole/import', expect.objectContaining({ zoneId: 42 }));
    expect(pi.importResults.value).toEqual({ hosts: 1 });
  });

  it('reuses an existing forward zone instead of creating a duplicate', async () => {
    const pi = inSetup(() => usePiholeImport({ toast }));
    pi.preview.value = { ...previewWithoutZone, zoneName: 'existing.lan' };
    zones.push({ id: 7, name: 'existing.lan', type: 'forward' });
    post.mockResolvedValue({ data: { results: {} } });

    await pi.executeImport();

    expect(createZone).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('/pihole/import', expect.objectContaining({ zoneId: 7 }));
  });

  it('reports when there is no zone and nothing to fall back to', async () => {
    const pi = inSetup(() => usePiholeImport({ toast }));
    pi.preview.value = previewWithoutZone;
    await pi.executeImport();
    expect(post).not.toHaveBeenCalled();
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: 'No zone found' }));
  });

  it('does nothing without a preview', async () => {
    const pi = inSetup(() => usePiholeImport({ toast }));
    await pi.executeImport();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('cleanUrl', () => {
  it('normalizes what the operator types', () => {
    const { cleanUrl } = inSetup(() => usePiholeImport({ toast }));
    expect(cleanUrl('pi.hole')).toBe('http://pi.hole');
    expect(cleanUrl('  https://pi.hole/admin/  ')).toBe('https://pi.hole');
    expect(cleanUrl('http://10.0.0.5:8080/x')).toBe('http://10.0.0.5:8080');
    expect(cleanUrl('')).toBe('');
  });
});

describe('teardown', () => {
  // The composable clears its debounce timer in onUnmounted, and the comment at
  // that line records that the timer used to outlive the component. Nothing
  // asserted it, because every test called the composable outside a component
  // instance, so the hook was never registered and Vue warned instead. Now that
  // the tests run it in a real instance, the guarantee is testable.
  it('clears the pending URL probe when the component unmounts', () => {
    vi.useFakeTimers();
    try {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const wrapper = mount({
        setup() {
          const pi = usePiholeImport({ toast });
          // Typing schedules the debounced probe (600ms in the composable).
          pi.url.value = 'http://pi.hole';
          return () => null;
        },
      });

      const clearsBefore = clearSpy.mock.calls.length;
      wrapper.unmount();
      expect(
        clearSpy.mock.calls.length,
        'unmount should clear the debounce timer'
      ).toBeGreaterThan(clearsBefore);

      // And the probe must not fire after the component is gone.
      post.mockReset();
      vi.advanceTimersByTime(5000);
      expect(post, 'no probe should run after unmount').not.toHaveBeenCalled();
      clearSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
