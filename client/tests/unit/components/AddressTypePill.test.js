/**
 * First component test, and the smoke test for the harness itself.
 *
 * Until now `client/tests/` held two files, both testing pure functions, so
 * nothing in the client was defended at the component level. This proves the
 * pieces work end to end: happy-dom provides a DOM, @vitejs/plugin-vue compiles
 * the SFC, @vue/test-utils mounts it, and the global `v-tooltip` stub from
 * tests/setup.js keeps the mount from failing on an unresolved directive.
 *
 * AddressTypePill is deliberately the first target: 18 lines, no store, no
 * router, no PrimeVue components. If this file fails, the harness is broken
 * rather than the app.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AddressTypePill from '../../../src/components/table/AddressTypePill.vue';

describe('AddressTypePill', () => {
  it('renders the label and class from the display object', () => {
    const w = mount(AddressTypePill, {
      props: { display: { label: 'rogue', className: 'type-rogue' } },
    });
    expect(w.text()).toBe('rogue');
    expect(w.classes()).toContain('address-type-pill');
    expect(w.classes()).toContain('type-rogue');
  });

  it('falls back to the empty placeholder when there is no label', () => {
    const w = mount(AddressTypePill, { props: { display: null } });
    expect(w.text()).toBe('—');
    expect(w.classes()).toContain('cell-muted');
  });

  it('treats a display object with no label as empty', () => {
    const w = mount(AddressTypePill, { props: { display: { className: 'x' } } });
    expect(w.text()).toBe('—');
  });

  it('passes the tooltip through', () => {
    const w = mount(AddressTypePill, {
      props: { display: { label: 'system', className: 'type-system' }, tooltip: 'This CIDRella interface' },
    });
    expect(w.attributes('data-tooltip')).toBe('This CIDRella interface');
  });
});
