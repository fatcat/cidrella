import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useWorkspaceActions } from '../../../../src/views/networks-workspace/composables/useWorkspaceActions.js';

vi.mock('../../../../src/api/client.js', () => ({ default: { get: vi.fn(), put: vi.fn() } }));

// Create network starts with no folder unless it was asked for from a folder.
function setup() {
  const openCreateNetwork = vi.fn();
  const { invoke } = useWorkspaceActions({
    can: () => true,
    router: { push: vi.fn(), currentRoute: ref({ fullPath: '/' }) },
    state: {
      selectedRow: ref(null),
      selectedFolder: ref({ id: 5, name: 'Lab' }),
      contextKind: ref('folder'),
    },
    dialogs: {
      networkDialogsMounted: ref(true),
      networkDialogs: ref({ openCreateNetwork }),
    },
    showLiveNotice: vi.fn(),
  });
  return { invoke, openCreateNetwork };
}

describe('Create network and its folder', () => {
  it('leaves the folder empty from the Create menu, even inside a folder', async () => {
    const { invoke, openCreateNetwork } = setup();
    await invoke('network.allocate', { kind: 'workspace' });
    expect(openCreateNetwork).toHaveBeenCalledWith(null);
  });

  it("fills the folder in from that folder's own menu", async () => {
    const { invoke, openCreateNetwork } = setup();
    await invoke('network.allocate', { kind: 'folder', id: 5 });
    expect(openCreateNetwork).toHaveBeenCalledWith(5);
  });
});
