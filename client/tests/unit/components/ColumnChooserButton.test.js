import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ColumnChooserButton from '../../../src/components/table/ColumnChooserButton.vue';

const ButtonStub = {
  props: ['label'],
  emits: ['click'],
  template: '<button type="button" @click="$emit(\'click\')">{{ label }}</button>'
};

const DialogStub = {
  template: '<section><slot /><slot name="footer" /></section>'
};

const InputTextStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
};

const PickListStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: `
    <div>
      <slot name="sourceheader" />
      <ol class="available"><li v-for="column in modelValue[0]" :key="column.key">{{ column.header }}</li></ol>
      <ol class="visible"><li v-for="column in modelValue[1]" :key="column.key">{{ column.header }}</li></ol>
    </div>
  `
};

describe('ColumnChooserButton', () => {
  it('filters alphabetized available columns without reordering visible columns', async () => {
    const allColumns = [
      { key: 'zebra', header: 'Zebra' },
      { key: 'beta', header: 'Beta' },
      { key: 'middle', header: 'Middle' },
      { key: 'alpha', header: 'Alpha' },
      { key: 'gamma', header: 'Gamma' }
    ];
    const visibleColumns = [allColumns[4], allColumns[1]];
    const wrapper = mount(ColumnChooserButton, {
      props: { tableName: 'Networks', allColumns, visibleColumns },
      global: {
        stubs: {
          Button: ButtonStub,
          Dialog: DialogStub,
          InputText: InputTextStub,
          PickList: PickListStub
        }
      }
    });

    await wrapper.findAll('button').find(button => button.text() === 'Columns').trigger('click');
    expect(wrapper.findAll('.available li').map(item => item.text()))
      .toEqual(['Alpha', 'Middle', 'Zebra']);
    expect(wrapper.findAll('.visible li').map(item => item.text()))
      .toEqual(['Gamma', 'Beta']);

    await wrapper.find('input').setValue('mid');
    expect(wrapper.findAll('.available li').map(item => item.text())).toEqual(['Middle']);
    expect(wrapper.findAll('.visible li').map(item => item.text()))
      .toEqual(['Gamma', 'Beta']);
  });
});
