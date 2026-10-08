import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => ({ add: vi.fn() }) }));
vi.mock('../../../src/api/client.js', () => ({ default: { get: vi.fn() } }));

const DhcpOptionTable = (await import('../../../src/components/dhcp/DhcpOptionTable.vue')).default;
const { UiPlugin } = await import('../../../src/ui/plugin.js');
const InputNumber = (await import('../../../src/ui/InputNumber.js')).default;

const rows = [
  { code: 26, label: 'Interface MTU', type: 'number', _group: 'Common' },
  { code: 66, label: 'TFTP Server', type: 'text', _group: 'Common' },
];

function mountTable(props = {}) {
  const values = reactive({});
  const enabled = reactive({});
  const wrapper = mount(DhcpOptionTable, {
    props: { rows, values, enabled, ...props },
    global: {
      plugins: [[UiPlugin, { unstyled: true }]],
      stubs: { Popover: true, EmptyState: true },
    },
  });
  const row = (code) =>
    wrapper
      .findAll('tbody tr')
      .find((tr) => tr.find('td').exists() && tr.find('td').text() === String(code));
  return { wrapper, values, enabled, row };
}

describe('DhcpOptionTable', () => {
  it('takes a number while it is typed, not only on blur', async () => {
    const { values, enabled, row } = mountTable({ checkOnValue: true });
    await flushPromises();
    // InputNumber reports each keystroke as an `input` event and moves its
    // model only on blur.
    row(26).findComponent(InputNumber).vm.$emit('input', { value: 1500 });
    await flushPromises();
    expect(values[26]).toBe(1500);
    expect(enabled[26]).toBe(true);
  });

  it('ticks a blank row when a value is typed into it, with check-on-value', async () => {
    const { values, enabled, row } = mountTable({ checkOnValue: true });
    await flushPromises();
    await row(66).find('input:not([type="checkbox"])').setValue('tftp.test');
    expect(values[66]).toBe('tftp.test');
    expect(enabled[66]).toBe(true);
    // Unticking it afterwards sticks: only a blank row is ticked for you.
    enabled[66] = false;
    await row(66).find('input:not([type="checkbox"])').setValue('tftp2.test');
    expect(enabled[66]).toBe(false);
  });

  it('leaves the checkbox alone without check-on-value', async () => {
    const { enabled, row } = mountTable();
    await flushPromises();
    await row(66).find('input:not([type="checkbox"])').setValue('tftp.test');
    expect(enabled[66]).toBeUndefined();
  });
});
