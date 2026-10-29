/**
 * Allocate next free prefix (docs/IPV6-HANDLING.md, rule 4): the dialog finds
 * the lowest free block of a size in a container and hands it on, to allocate
 * as it stands or to carve first. Both families.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import NextPrefixDialog from '../../../../src/views/networks-workspace/dialogs/NextPrefixDialog.vue';

const stubs = {
  Dialog: { template: '<section><slot /></section>' },
  Button: {
    props: ['label', 'disabled'],
    template:
      '<button :type="$attrs.type" :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
  },
  Select: {
    props: ['modelValue', 'options'],
    emits: ['update:modelValue'],
    template: `<select class="parent" :value="modelValue"
      @change="$emit('update:modelValue', Number($event.target.value))">
      <option v-for="o in options" :key="o.id" :value="o.id">{{ o.label }}</option></select>`,
  },
  InputNumber: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: `<input class="prefix" :value="modelValue"
      @input="$emit('update:modelValue', Number($event.target.value))" />`,
  },
};

const leaf = (id, cidr) => ({ id, cidr, status: 'unallocated', allocatable: true, children: [] });
// The explorer's unallocated tree: allocated networks are not in it, so a
// container carries its coverage from the whole subtree.
const FOLDERS = [
  {
    id: 1,
    name: 'Lab',
    networks: [
      {
        id: 10,
        cidr: 'fd00:aa::/48',
        status: 'unallocated',
        allocatable: false,
        coverage: { percent: 0.0015, byPrefix: [{ prefix: 64, count: 1 }] },
        children: [leaf(11, 'fd00:aa:0:1::/64'), leaf(12, 'fd00:aa:0:100::/56')],
      },
      {
        id: 20,
        cidr: '10.90.0.0/16',
        status: 'unallocated',
        allocatable: false,
        coverage: { percent: 0.39, byPrefix: [{ prefix: 24, count: 1 }] },
        children: [leaf(21, '10.90.1.0/24'), leaf(22, '10.90.2.0/23')],
      },
    ],
  },
];

function mountDialog(parentId) {
  return mount(NextPrefixDialog, {
    props: { visible: true, folders: FOLDERS, parentId },
    global: { stubs },
  });
}

describe('NextPrefixDialog', () => {
  it('IPv6: offers the free /64 as it stands under a /48 container', async () => {
    const wrapper = mountDialog(10);
    await flushPromises();
    // A /48 parent starts at /56: the free /56 is allocated as it stands.
    expect(wrapper.find('.prefix').element.value).toBe('56');
    expect(wrapper.text()).toContain('fd00:aa:0:100::/56 is free as it stands');
    await wrapper.find('.prefix').setValue('64');
    expect(wrapper.text()).toContain('fd00:aa:0:1::/64 is free as it stands');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.emitted('continue')[0][0]).toMatchObject({
      cidr: 'fd00:aa:0:1::/64',
      exact: true,
      leaf: { id: 11 },
    });
  });

  it('IPv4: carves a /24 from the lowest free /23 when /24 is asked under it', async () => {
    const wrapper = mountDialog(20);
    await flushPromises();
    expect(wrapper.find('.prefix').element.value).toBe('24');
    expect(wrapper.text()).toContain('10.90.1.0/24 is free as it stands');
    await wrapper.find('.parent').setValue('22');
    await flushPromises();
    // The /23 leaf itself as a parent: its default is eight bits down.
    await wrapper.find('.prefix').setValue('24');
    expect(wrapper.text()).toContain('10.90.2.0/24, carved from the free 10.90.2.0/23');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.emitted('continue')[0][0]).toMatchObject({ cidr: '10.90.2.0/24', exact: false });
  });

  it('says so and cannot continue when nothing of that size is free', async () => {
    const wrapper = mountDialog(20);
    await flushPromises();
    await wrapper.find('.prefix').setValue('22');
    expect(wrapper.text()).toContain('No free /22 is left in 10.90.0.0/16');
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
  });

  it('lists containers and free blocks with how much of each is allocated', async () => {
    const wrapper = mountDialog(null);
    await flushPromises();
    const labels = wrapper.findAll('.parent option').map((option) => option.text());
    expect(labels).toContain('fd00:aa::/48 · <0.01% allocated');
    expect(labels).toContain('10.90.0.0/16 · 0.39% allocated');
    expect(labels).toContain('10.90.2.0/23 · free');
  });
});
