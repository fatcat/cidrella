import { describe, expect, it, vi } from 'vitest';
import {
  decodeWorkspaceQuery,
  encodeWorkspaceQuery,
  useWorkspaceContext,
} from '../../../src/views/networks-workspace/composables/useWorkspaceContext.js';

describe('workspace route codec', () => {
  it('round trips valid non-default state with workspace URL naming', () => {
    const filters = JSON.stringify({ type: ['gateway'], record_enabled: [false], lease: [null] });
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
      filters,
    });

    expect(state).toMatchObject({
      network: 42,
      tableQ: 'online',
      page: 2,
      pageSize: 100,
      filters: { type: ['gateway'], record_enabled: [false], lease: [null] },
    });
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
      filters,
    });
  });

  it('reads the filter keys of older links as column filters for their table', () => {
    // The Dashboard's rogue link, and links saved before column filters.
    expect(
      decodeWorkspaceQuery({ context: 'network', network: '2', view: 'addresses', type: 'rogue' })
        .filters,
    ).toEqual({ type: ['rogue'] });
    expect(
      decodeWorkspaceQuery({ view: 'dns', type: 'A', status: 'disabled', protocol: 'manual' })
        .filters,
    ).toEqual({ record_type: ['A'], record_enabled: [false], record_source: ['manual'] });
    expect(
      decodeWorkspaceQuery({ view: 'dhcp', type: 'reserved', online: 'true' }).filters,
    ).toEqual({ assignment: ['reserved'], is_online: [true] });
  });

  it('drops what a hand-edited filters parameter should not carry', () => {
    expect(decodeWorkspaceQuery({ filters: 'not json' }).filters).toEqual({});
    expect(
      decodeWorkspaceQuery({
        filters: JSON.stringify({ status: ['in use', { $ne: 1 }, 3], 'bad key!': ['x'] }),
      }).filters,
    ).toEqual({ status: ['in use'] });
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
