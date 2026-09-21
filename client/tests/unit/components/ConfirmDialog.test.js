import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ConfirmDialog from '../../../src/components/ConfirmDialog.vue';

const DialogStub = {
  props: ['visible', 'header'],
  emits: ['update:visible', 'hide'],
  template:
    '<section v-if="visible"><h2>{{ header }}</h2><slot /><footer><slot name="footer" /></footer><button class="x" @click="$emit(\'update:visible\', false)">x</button></section>',
};
const ButtonStub = {
  props: ['label', 'disabled', 'severity', 'loading'],
  emits: ['click'],
  template:
    '<button type="button" :class="severity" :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
};
const InputStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

function mountDialog(props = {}, slot = '<p>Delete it?</p>') {
  return mount(ConfirmDialog, {
    props: { visible: true, header: 'Delete Thing', ...props },
    slots: { default: slot },
    attrs: { 'data-track': 'dialog-thing-delete' },
    global: { stubs: { Dialog: DialogStub, Button: ButtonStub, InputText: InputStub } },
  });
}

describe('ConfirmDialog', () => {
  it('renders the body, a Cancel and a danger confirm, and forwards data-track', () => {
    const w = mountDialog();
    expect(w.find('[data-track="dialog-thing-delete"]').exists()).toBe(true);
    expect(w.find('h2').text()).toBe('Delete Thing');
    expect(w.text()).toContain('Delete it?');
    const buttons = w.findAll('footer button');
    expect(buttons.map((b) => b.text())).toEqual(['Cancel', 'Delete']);
    expect(buttons[1].classes()).toContain('danger');
  });

  it('emits confirm on the primary button and closes with cancel on the secondary', async () => {
    const w = mountDialog({ confirmLabel: 'Deallocate', severity: 'warn' });
    const [cancel, confirm] = w.findAll('footer button');
    expect(confirm.text()).toBe('Deallocate');
    expect(confirm.classes()).toContain('warn');
    await confirm.trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);
    expect(w.emitted('update:visible')).toBeUndefined();
    await cancel.trigger('click');
    expect(w.emitted('update:visible')).toEqual([[false]]);
    expect(w.emitted('cancel')).toHaveLength(1);
  });

  it('treats closing the dialog by any other route as a cancel', async () => {
    const w = mountDialog();
    await w.find('button.x').trigger('click');
    expect(w.emitted('update:visible')).toEqual([[false]]);
    expect(w.emitted('cancel')).toHaveLength(1);
  });

  it('holds the confirm until the word is typed, and honors disabled on its own', async () => {
    const w = mountDialog({ typeToConfirm: 'RESET' });
    expect(w.text()).toContain('Type RESET to confirm');
    const confirm = w.findAll('footer button')[1];
    expect(confirm.attributes('disabled')).toBeDefined();
    await w.find('input').setValue('reset');
    expect(confirm.attributes('disabled')).toBeDefined();
    await w.find('input').setValue('RESET');
    expect(confirm.attributes('disabled')).toBeUndefined();

    const blocked = mountDialog({ disabled: true });
    expect(blocked.findAll('footer button')[1].attributes('disabled')).toBeDefined();
    expect(blocked.find('input').exists()).toBe(false);
  });
});
