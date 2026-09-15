import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AddressGrid from '../../../../src/views/networks-workspace/AddressGrid.vue';
import {
  MAX_BULK_ADDRESSES,
  addressIdentity,
  contiguousIpv4Runs,
  useWorkspaceSelection,
} from '../../../../src/views/networks-workspace/composables/useWorkspaceSelection.js';

describe('workspace address selection', () => {
  it('uses the same canonical selection ID for table rows and both grid cell shapes', () => {
    expect(addressIdentity({ address: '10.0.0.4' })).toBe('address:10.0.0.4');
    expect(addressIdentity({ ip: '10.0.0.4' })).toBe('address:10.0.0.4');
    expect(addressIdentity({ ip_address: '10.0.0.4' })).toBe('address:10.0.0.4');
    expect(addressIdentity('address:10.0.0.4')).toBe('address:10.0.0.4');
  });

  it('keeps disjoint selections as exact runs without including gaps', () => {
    expect(
      contiguousIpv4Runs([
        'address:10.0.0.33',
        'address:10.0.0.34',
        'address:10.0.0.40',
        'address:10.0.0.42',
        'address:10.0.0.41',
      ]),
    ).toEqual([
      { start_ip: '10.0.0.33', end_ip: '10.0.0.34', count: 2 },
      { start_ip: '10.0.0.40', end_ip: '10.0.0.42', count: 3 },
    ]);
  });

  it('chunks contiguous addresses into requests of no more than 1024', () => {
    const addresses = Array.from({ length: MAX_BULK_ADDRESSES + 2 }, (_, index) => {
      const third = Math.floor(index / 256);
      const fourth = index % 256;
      return `10.0.${third}.${fourth}`;
    });
    const runs = contiguousIpv4Runs(addresses);

    expect(runs).toEqual([
      { start_ip: '10.0.0.0', end_ip: '10.0.3.255', count: 1024 },
      { start_ip: '10.0.4.0', end_ip: '10.0.4.1', count: 2 },
    ]);
  });

  it('shares selection across presentations and shift-selects only visible identities', () => {
    const selection = useWorkspaceSelection();
    selection.toggle({ address: '10.0.0.1' });
    expect(selection.isSelected({ ip: '10.0.0.1' })).toBe(true);

    selection.selectVisibleRange([{ ip: '10.0.0.1' }, { ip: '10.0.0.3' }, { ip: '10.0.0.4' }], {
      ip_address: '10.0.0.4',
    });

    expect(selection.selectedIds.value).toEqual([
      'address:10.0.0.1',
      'address:10.0.0.3',
      'address:10.0.0.4',
    ]);
    expect(selection.runs.value).toEqual([
      { start_ip: '10.0.0.1', end_ip: '10.0.0.1', count: 1 },
      { start_ip: '10.0.0.3', end_ip: '10.0.0.4', count: 2 },
    ]);
  });

  it('can clear only visible rows or the full selection', () => {
    const selection = useWorkspaceSelection();
    selection.replace(['10.0.0.1', '10.0.0.2', '10.0.0.8']);
    selection.toggleVisible([{ address: '10.0.0.1' }, { address: '10.0.0.2' }], false);
    expect(selection.selectedIds.value).toEqual(['address:10.0.0.8']);
    selection.clear();
    expect(selection.selectedCount.value).toBe(0);
  });

  it('supports roving keyboard focus, selection, opening, and context actions', async () => {
    const cells = Array.from({ length: 20 }, (_, index) => ({
      ip: `10.0.0.${index}`,
      last: String(index),
      kind: 'available',
      label: 'Available',
      row: { id: `address:10.0.0.${index}`, address: `10.0.0.${index}` },
    }));
    const wrapper = mount(AddressGrid, {
      attachTo: globalThis.document.body,
      props: { cells, density: 'spacious' },
    });
    const buttons = wrapper.findAll('.address-grid button');

    await buttons[0].trigger('keydown', { key: 'ArrowDown' });
    expect(globalThis.document.activeElement).toBe(buttons[16].element);
    await buttons[16].trigger('keydown', { key: ' ' });
    expect(wrapper.emitted('toggle')?.[0]).toEqual(['address:10.0.0.16']);
    await buttons[16].trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('open')?.[0]?.[0].ip).toBe('10.0.0.16');
    await buttons[16].trigger('contextmenu');
    expect(wrapper.emitted('row-menu')?.[0]?.[0].address).toBe('10.0.0.16');
    wrapper.unmount();
  });

  it.each(['spacious', 'compact'])(
    'drag-selects the exact visible run in %s mode',
    async (density) => {
      const cells = Array.from({ length: 6 }, (_, index) => ({
        ip: `10.0.0.${index}`,
        last: String(index),
        kind: 'available',
        label: 'Available',
        row: { id: `address:10.0.0.${index}`, address: `10.0.0.${index}` },
      }));
      const wrapper = mount(AddressGrid, {
        attachTo: globalThis.document.body,
        props: { cells, density },
      });
      const buttons = wrapper.findAll('button');

      await buttons[1].trigger('pointerdown', { button: 0, ctrlKey: true });
      await buttons[4].trigger('pointerenter', { buttons: 1 });
      globalThis.window.dispatchEvent(new Event('pointerup'));
      await wrapper.vm.$nextTick();

      expect(wrapper.emitted('drag-select')?.[0]).toEqual([
        {
          ids: ['address:10.0.0.1', 'address:10.0.0.2', 'address:10.0.0.3', 'address:10.0.0.4'],
          additive: true,
        },
      ]);
      await buttons[4].trigger('click');
      expect(wrapper.emitted('open')).toBeUndefined();
      wrapper.unmount();
    },
  );
});
