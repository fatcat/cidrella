import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useWorkspaceActions } from '../../../../src/views/networks-workspace/composables/useWorkspaceActions.js';

vi.mock('../../../../src/api/client.js', () => ({ default: { get: vi.fn(), put: vi.fn() } }));

// Create > Add DHCP scope opens the scope dialog on the network in view, so
// an estate with hundreds of networks never sends the user to the picker for
// the one already open.
describe('Add DHCP scope from the workspace', () => {
  function setup({ network, contextKind = 'network' }) {
    const openScopeDialog = vi.fn();
    const { invoke } = useWorkspaceActions({
      can: () => true,
      router: { push: vi.fn(), currentRoute: ref({ fullPath: '/' }) },
      state: { selectedNetwork: ref(network), contextKind: ref(contextKind) },
      dialogs: {
        protocolDialogsMounted: ref(true),
        dnsDialogs: ref({}),
        dhcpDialogs: ref({ openScopeDialog }),
      },
      showLiveNotice: vi.fn(),
    });
    return { invoke, openScopeDialog };
  }

  const v4 = {
    id: 11,
    cidr: '10.0.0.0/24',
    gateway_address: '10.0.0.1',
    domain_name: 'lab.test',
    status: 'allocated',
  };
  const v6 = { id: 12, cidr: 'fd00:1234::/64', domain_name: 'six.test', status: 'allocated' };

  it('opens on the selected network, IPv4 or IPv6', async () => {
    for (const network of [v4, v6]) {
      const { invoke, openScopeDialog } = setup({ network });
      await invoke('dhcp.scope.create', { kind: 'workspace' });
      expect(openScopeDialog).toHaveBeenCalledWith(null, network);
    }
  });

  it('opens on the picker outside a network, or on a divided network', async () => {
    let { invoke, openScopeDialog } = setup({ network: v4, contextKind: 'estate' });
    await invoke('dhcp.scope.create', { kind: 'workspace' });
    expect(openScopeDialog).toHaveBeenCalledWith(null, undefined);

    ({ invoke, openScopeDialog } = setup({
      network: { ...v6, children: [{ id: 13, cidr: 'fd00:1234::/65' }] },
    }));
    await invoke('dhcp.scope.create', { kind: 'workspace' });
    expect(openScopeDialog).toHaveBeenCalledWith(null, undefined);
  });
});
