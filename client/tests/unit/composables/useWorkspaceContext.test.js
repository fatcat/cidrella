import { describe, expect, it, vi } from 'vitest';
import {
  decodeWorkspaceQuery,
  encodeWorkspaceQuery,
  useWorkspaceContext,
} from '../../../src/views/networks-workspace/composables/useWorkspaceContext.js';

describe('workspace route codec', () => {
  it('round trips valid non-default state with workspace URL naming', () => {
    const state = decodeWorkspaceQuery({
      context: 'network',
      network: '42',
      view: 'addresses',
      ip: '10.0.0.9',
      presentation: 'compact',
      q: 'printer',
      tableQ: 'online',
      page: '2',
      pageSize: '100',
      status: 'available',
      type: 'gateway',
      online: 'true',
      scan: 'false',
      range: '8',
      protocol: 'manual',
    });

    expect(state).toMatchObject({ network: 42, tableQ: 'online', page: 2, pageSize: 100 });
    expect(encodeWorkspaceQuery(state)).toEqual({
      context: 'network',
      network: '42',
      view: 'addresses',
      ip: '10.0.0.9',
      presentation: 'compact',
      q: 'printer',
      tableQ: 'online',
      page: '2',
      pageSize: '100',
      status: 'available',
      type: 'gateway',
      online: 'true',
      scan: 'false',
      range: '8',
      protocol: 'manual',
    });
  });

  it('rejects invalid identities and removes orphaned address details', () => {
    expect(
      decodeWorkspaceQuery({ context: 'network', network: '-1', ip: '10.0.0.9' }),
    ).toMatchObject({ context: 'all', network: null, ip: null });
    expect(encodeWorkspaceQuery(decodeWorkspaceQuery({}))).toEqual({});
    expect(encodeWorkspaceQuery(decodeWorkspaceQuery({ context: 'unallocated' }))).toEqual({
      context: 'unallocated',
    });
  });

  it('accepts internal state patches without letting an older table query win', async () => {
    const router = { push: vi.fn(), replace: vi.fn() };
    const workspace = useWorkspaceContext({ storageKey: 'workspace-codec-test', router });

    await workspace.navigate({
      context: 'network',
      network: 7,
      view: 'addresses',
      tableQ: 'new search',
    });

    expect(workspace.state.value.tableQ).toBe('new search');
    expect(router.push).toHaveBeenCalledWith({
      query: {
        context: 'network',
        network: '7',
        view: 'addresses',
        tableQ: 'new search',
      },
    });
  });
});
