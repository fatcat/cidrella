import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import WorkspaceTable from '../../../../src/views/networks-workspace/WorkspaceTable.vue';

describe('WorkspaceTable', () => {
  it('marks a disabled row so it recedes, and leaves rows without the flag alone', () => {
    const wrapper = mount(WorkspaceTable, {
      props: {
        columns: [
          { key: 'name', label: 'Hostname' },
          { key: 'enabled', label: 'Enabled' },
        ],
        rows: [
          { id: 1, name: 'hass', enabled: false },
          { id: 2, name: 'nas', enabled: true },
          { id: 3, name: '10.0.0.4' },
        ],
      },
    });
    const classes = wrapper.findAll('tbody tr').map((tr) => tr.classes('disabled'));
    expect(classes).toEqual([true, false, false]);
  });
});
