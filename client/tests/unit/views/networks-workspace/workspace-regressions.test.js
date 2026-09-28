import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../../../src/api/client.js';
import AddressDetailsPanel from '../../../../src/views/networks-workspace/AddressDetailsPanel.vue';
import ResourceExplorer from '../../../../src/views/networks-workspace/ResourceExplorer.vue';
import { menuActions } from '../../../../src/views/networks-workspace/workspace-actions.js';
import {
  decodeWorkspaceQuery,
  useWorkspaceContext,
} from '../../../../src/views/networks-workspace/composables/useWorkspaceContext.js';
import { useWorkspaceResources } from '../../../../src/views/networks-workspace/composables/useWorkspaceResources.js';

vi.mock('../../../../src/api/client.js', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

const ok = (data) => Promise.resolve({ data });

describe('workspace P1 regression contracts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('T06 ignores a late address response from the previous network context', async () => {
    let resolveOld;
    api.get
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValueOnce({
        data: { ips: [{ ip_address: '10.2.0.1' }], totalIps: 1, totalPages: 1 },
      });
    const workspace = useWorkspaceResources({ can: () => true });

    const oldRequest = workspace.loadAddresses(1);
    await workspace.loadAddresses(2);
    resolveOld({ data: { ips: [{ ip_address: '10.1.0.1' }], totalIps: 1, totalPages: 1 } });
    await oldRequest;

    expect(workspace.resources.addresses.data.items[0].ip_address).toBe('10.2.0.1');
  });

  it('T08 reports a successful save even when lifecycle refresh fails', async () => {
    api.get.mockRejectedValue(new Error('refresh unavailable'));
    api.put.mockResolvedValue({ data: {} });
    const wrapper = mount(AddressDetailsPanel, {
      props: {
        row: {
          address: '10.0.0.9',
          status: 'available',
          raw: { allocation_state: 'unassigned', scanning_enabled: true, scan_enabled: null },
        },
        subnetId: 4,
        networkName: 'Lab',
        canWrite: true,
      },
    });
    await flushPromises();

    await wrapper.find('[data-track="workspace-create-ip-reservation"]').trigger('click');
    await wrapper.find('textarea').setValue('printer');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledOnce();
    expect(wrapper.emitted('changed')?.[0]).toEqual(['IP Reservation created']);
  });

  it.each([
    { name: 'read only', folders: false, defaults: false, range: false, reserve: false },
    { name: 'subnet writer', folders: true, defaults: true, range: true, reserve: true },
  ])('T32 applies the $name write-control matrix', ({ folders, defaults, range, reserve }) => {
    const explorer = mount(ResourceExplorer, {
      props: {
        contextKind: 'estate',
        folders: [],
        expandedFolders: new Set(),
        canManageFolders: folders,
        canManageDefaults: defaults,
      },
    });
    expect(explorer.text().includes('Manage folders')).toBe(folders);
    expect(explorer.text().includes('Defaults')).toBe(defaults);

    // A checked selection's actions live in its row menu, gated the same way.
    const selectionMenu = menuActions({
      menu: 'row',
      target: { kind: 'address-selection', count: 1, allocationStates: ['unassigned'] },
      can: () => range && reserve,
    }).map((item) => item.label);
    expect(selectionMenu.includes('Set range type')).toBe(range);
    expect(selectionMenu.includes('Reserve')).toBe(reserve);
  });

  it('renders subdivided unallocated parents as nonallocatable search-highlighted containers', async () => {
    const wrapper = mount(ResourceExplorer, {
      props: {
        contextKind: 'unallocated',
        folders: [
          {
            id: 1,
            name: 'Lab',
            networks: [
              {
                id: 10,
                cidr: '10.0.0.0/24',
                name: '10.0.0.0/24',
                allocatable: false,
                children: [
                  {
                    id: 11,
                    cidr: '10.0.0.0/25',
                    name: '10.0.0.0/25',
                    allocatable: true,
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
        expandedFolders: new Set([1]),
        query: '0.0/25',
      },
    });

    const rows = wrapper.findAll('[data-track="workspace-network-select"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].attributes()).toHaveProperty('disabled');
    expect(rows[0].attributes('aria-label')).toContain('subdivided container');
    expect(rows[1].find('mark').text()).toBe('0.0/25');
    await rows[1].trigger('click');
    expect(wrapper.emitted('select-unallocated-network')?.[0]?.[0].id).toBe(11);
  });

  it('shows only the allocatable leaves when Show hierarchy is off, and remembers it', async () => {
    globalThis.localStorage?.removeItem('cidrella_workspace_unallocated_hierarchy');
    const leaf = (id, cidr) => ({ id, cidr, name: cidr, allocatable: true, children: [] });
    const folders = [
      {
        id: 1,
        name: 'Lab',
        networks: [
          {
            id: 10,
            cidr: '10.0.0.0/23',
            name: '10.0.0.0/23',
            allocatable: false,
            children: [
              {
                id: 11,
                cidr: '10.0.0.0/24',
                name: '10.0.0.0/24',
                allocatable: false,
                children: [leaf(12, '10.0.0.0/25'), leaf(13, '10.0.0.128/25')],
              },
              leaf(14, '10.0.1.0/24'),
            ],
          },
        ],
      },
    ];
    const ToggleSwitch = {
      props: ['modelValue'],
      emits: ['update:modelValue'],
      template:
        '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
    };
    const mountExplorer = (contextKind = 'unallocated') =>
      mount(ResourceExplorer, {
        props: { contextKind, folders, expandedFolders: new Set([1]) },
        global: { stubs: { ToggleSwitch } },
      });
    const cidrs = (wrapper) =>
      wrapper
        .findAll('[data-track="workspace-network-select"] small')
        .map((small) => small.text().replace(' · subdivided', ''));

    const wrapper = mountExplorer();
    const toggle = wrapper.find('.hierarchy-toggle');
    expect(toggle.text()).toContain('Show hierarchy');
    // On by default: the containers above the leaves are drawn too.
    expect(cidrs(wrapper)).toEqual([
      '10.0.0.0/23',
      '10.0.0.0/24',
      '10.0.0.0/25',
      '10.0.0.128/25',
      '10.0.1.0/24',
    ]);
    // The folder counts networks that can be allocated, in either mode.
    expect(wrapper.find('.folder-row small').text()).toBe('3');

    await toggle.find('input').setValue(false);
    expect(cidrs(wrapper)).toEqual(['10.0.0.0/25', '10.0.0.128/25', '10.0.1.0/24']);
    expect(wrapper.find('.resource-node.container').exists()).toBe(false);
    // Remembered for the next visit.
    expect(cidrs(mountExplorer())).toEqual(['10.0.0.0/25', '10.0.0.128/25', '10.0.1.0/24']);
    // Allocated folders are flat already; the toggle is not offered there.
    expect(mountExplorer('estate').find('.hierarchy-toggle').exists()).toBe(false);
    globalThis.localStorage?.removeItem('cidrella_workspace_unallocated_hierarchy');
  });

  it('picks allocated explorer networks with Ctrl and Shift, and opens a plain click', async () => {
    const network = (id, cidr) => ({ id, cidr, name: cidr, state: 'allocated', used: 0 });
    const wrapper = mount(ResourceExplorer, {
      props: {
        contextKind: 'estate',
        folders: [
          { id: 1, name: 'Lab', networks: [network(5, '10.5.0.0/24'), network(6, '10.6.0.0/24')] },
          { id: 2, name: 'Closed', networks: [network(7, '10.7.0.0/24')] },
        ],
        expandedFolders: new Set([1]),
        selectedRows: ['network:6'],
      },
    });
    const rows = wrapper.findAll('[data-track="workspace-network-select"]');
    expect(rows.map((row) => row.classes().includes('checked'))).toEqual([false, true]);

    await rows[0].trigger('click', { ctrlKey: true });
    await rows[0].trigger('click', { metaKey: true });
    expect(wrapper.emitted('toggle-network')).toEqual([['network:5'], ['network:5']]);
    // Shift ranges over what the explorer shows: collapsed folders are out.
    await rows[1].trigger('click', { shiftKey: true });
    expect(wrapper.emitted('range-network')).toEqual([['network:6', ['network:5', 'network:6']]]);
    expect(wrapper.emitted('select-network')).toBeUndefined();
    await rows[1].trigger('click');
    expect(wrapper.emitted('select-network')?.[0]?.[0].id).toBe(6);
  });

  it('opens the menu of an unallocated network from the tree, not of a container', async () => {
    const wrapper = mount(ResourceExplorer, {
      props: {
        contextKind: 'unallocated',
        folders: [
          {
            id: 1,
            name: 'Lab',
            networks: [
              {
                id: 10,
                cidr: '10.0.0.0/24',
                allocatable: false,
                children: [{ id: 11, cidr: '10.0.0.0/25', allocatable: true, children: [] }],
              },
            ],
          },
        ],
        expandedFolders: new Set([1]),
        selectedRows: ['network:11'],
      },
    });
    const [container, leaf] = wrapper.findAll('[data-track="workspace-network-select"]');
    expect(leaf.classes()).toContain('checked');
    await container.trigger('contextmenu');
    expect(wrapper.emitted('network-menu')).toBeUndefined();
    await leaf.trigger('contextmenu');
    expect(wrapper.emitted('network-menu')?.[0]?.[0].id).toBe(11);
    await leaf.trigger('keydown', { key: 'F10', shiftKey: true });
    expect(wrapper.emitted('network-menu')).toHaveLength(2);
    await leaf.trigger('click', { ctrlKey: true });
    expect(wrapper.emitted('toggle-network')).toEqual([['network:11']]);
  });

  it('T33 refreshes permissions after 403 and preserves successful domains', async () => {
    const onForbidden = vi.fn();
    const workspace = useWorkspaceResources({ can: () => true, onForbidden });
    workspace.resources.networks.data = { items: [{ id: 9 }], total: 1 };
    api.get.mockRejectedValue({ response: { status: 403, data: { error: 'Forbidden' } } });

    await workspace.loadDns();

    expect(onForbidden).toHaveBeenCalledWith('dns:read');
    expect(workspace.resources.networks.data.items).toEqual([{ id: 9 }]);
  });

  it('T34 rejects deleted or invalid route identities without preserving orphan details', () => {
    expect(
      decodeWorkspaceQuery({ context: 'network', network: 'deleted', ip: '10.0.0.9' }),
    ).toMatchObject({ context: 'all', network: null, ip: null });
    expect(decodeWorkspaceQuery({ context: 'folder', folder: '0', zone: '-7' })).toMatchObject({
      context: 'all',
      folder: null,
      zone: null,
    });
  });

  it('T42 restores Back/Forward state and saves the latest workspace URL state', async () => {
    const route = reactive({ query: {} });
    const router = {
      push: vi.fn(async ({ query }) => Object.assign(route, { query })),
      replace: vi.fn(async ({ query }) => Object.assign(route, { query })),
    };
    const workspace = useWorkspaceContext({ storageKey: 'workspace-history-test', route, router });

    await workspace.navigate({ context: 'network', network: 8, view: 'dns', zone: 3 });
    expect(workspace.state.value).toMatchObject({ network: 8, view: 'dns', zone: 3 });

    route.query = { context: 'folder', folder: '2', view: 'dhcp', scope: '7', page: '3' };
    await flushPromises();
    expect(workspace.state.value).toMatchObject({
      context: 'folder',
      folder: 2,
      view: 'dhcp',
      scope: 7,
      page: 3,
    });

    await workspace.navigate({ tableQ: 'printer' }, { replace: true });
    expect(JSON.parse(localStorage.getItem('workspace-history-test'))).toMatchObject({
      context: 'folder',
      folder: '2',
      scope: '7',
      tableQ: 'printer',
    });
  });

  it('sends the canonical address protocol filter to the server', async () => {
    api.get.mockReturnValue(
      ok({ ips: [], ranges: [], totalIps: 0, filteredTotal: 0, totalPages: 1 }),
    );
    const workspace = useWorkspaceResources({ can: () => true });
    await workspace.loadAddresses(6, { allocation_source_type: 'dhcp_lease' });

    expect(api.get).toHaveBeenCalledWith('/subnets/6/ips', {
      params: { allocation_source_type: 'dhcp_lease' },
    });
  });
});
