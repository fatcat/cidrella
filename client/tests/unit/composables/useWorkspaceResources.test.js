import { describe, expect, it, vi } from 'vitest';
import api from '../../../src/api/client.js';
import { useWorkspaceResources } from '../../../src/views/networks-workspace/composables/useWorkspaceResources.js';

vi.mock('../../../src/api/client.js', () => ({ default: { get: vi.fn() } }));

describe('workspace resource reads', () => {
  it('does not request resources denied by server-projected permissions', async () => {
    const workspace = useWorkspaceResources({ can: (permission) => permission === 'subnets:read' });

    expect(await workspace.loadDns()).toBeNull();
    expect(await workspace.loadDhcp()).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('discards a late response after a newer keyed request completes', async () => {
    let resolveFirst;
    api.get
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ data: { items: [{ id: 2 }], total: 1 } });
    const workspace = useWorkspaceResources({ can: () => true });

    const first = workspace.loadNetworks({ q: 'old' });
    await workspace.loadNetworks({ q: 'new' });
    resolveFirst({ data: { items: [{ id: 1 }], total: 1 } });
    await first;

    expect(workspace.resources.networks.data.items).toEqual([{ id: 2 }]);
  });

  it('refreshes capabilities after a forbidden read without clearing prior data', async () => {
    const onForbidden = vi.fn();
    const workspace = useWorkspaceResources({ can: () => true, onForbidden });
    workspace.resources.networks.data = { items: [{ id: 7 }], total: 1 };
    api.get.mockRejectedValueOnce({ response: { status: 403, data: { error: 'Forbidden' } } });

    await workspace.loadDns();

    expect(onForbidden).toHaveBeenCalledWith('dns:read');
    expect(workspace.resources.networks.data.items).toEqual([{ id: 7 }]);
  });
});
