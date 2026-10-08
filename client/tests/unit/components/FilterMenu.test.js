import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import FilterMenu from '../../../src/components/table/FilterMenu.vue';

const ButtonStub = {
  props: ['label', 'type', 'disabled'],
  emits: ['click'],
  template:
    '<button :type="type || \'button\'" :disabled="disabled" @click="$emit(\'click\', $event)">{{ label }}</button>',
};
// The popover's content is always rendered here; show/hide are no-ops.
const PopoverStub = {
  emits: ['show', 'hide'],
  methods: {
    toggle() {
      this.$emit('show');
    },
    hide() {
      this.$emit('hide');
    },
  },
  template: '<div><slot /></div>',
};
const CheckboxStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', !modelValue)" />',
};
const InputTextStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

const columns = [
  { key: 'record_enabled', header: 'Record Enabled', kind: 'enum' },
  { key: 'hostname', header: 'Hostname', kind: 'text' },
];
const facets = {
  record_enabled: [
    { value: true, count: 1067 },
    { value: false, count: 1 },
  ],
};
const label = (key, value) => (value === null ? 'None' : value ? 'Enabled' : 'Disabled');

function mountMenu(modelValue = {}) {
  return mount(FilterMenu, {
    props: { columns, facets, modelValue, valueLabel: label },
    global: {
      stubs: {
        Button: ButtonStub,
        Popover: PopoverStub,
        Checkbox: CheckboxStub,
        InputText: InputTextStub,
      },
    },
  });
}

describe('FilterMenu', () => {
  it("lists columns, then a column's values with their counts, and toggles them", async () => {
    const wrapper = mountMenu();
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('open')).toHaveLength(1);
    const columnButton = (header) =>
      wrapper.findAll('.filter-row').find((row) => row.text().includes(header));
    await columnButton('Record Enabled').trigger('click');

    const rows = wrapper.findAll('.filter-value');
    expect(rows.map((row) => row.findAll('span').map((span) => span.text()))).toEqual([
      ['Enabled', '1,067'],
      ['Disabled', '1'],
    ]);
    await rows[1].find('input').trigger('change');
    expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual({ record_enabled: [false] });
  });

  it('keeps a picked value listed when nothing carries it any more, so it can be unticked', async () => {
    const wrapper = mountMenu({ record_enabled: [null] });
    await wrapper.find('button').trigger('click');
    await wrapper
      .findAll('.filter-row')
      .find((row) => row.text().includes('Record Enabled'))
      .trigger('click');
    const none = wrapper.findAll('.filter-value').find((row) => row.text().includes('None'));
    expect(none.text()).toContain('0');
    await none.find('input').trigger('change');
    expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual({});
  });

  it('filters a text column by what it contains', async () => {
    const wrapper = mountMenu();
    await wrapper.find('button').trigger('click');
    await wrapper
      .findAll('.filter-row')
      .find((row) => row.text().includes('Hostname'))
      .trigger('click');
    await wrapper.find('form input').setValue('hass');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual({ hostname: ['hass'] });
  });
});
