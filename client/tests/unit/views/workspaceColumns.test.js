import { describe, expect, it } from 'vitest';
import {
  defaultWorkspaceColumnKeys,
  restoreWorkspaceColumnKeys,
  workspaceColumnCatalog,
} from '../../../src/views/networks-workspace/workspace-columns.js';

describe('workspace columns', () => {
  it('exposes canonical provenance and fingerprint columns', () => {
    const keys = workspaceColumnCatalog('addresses').map((column) => column.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'status',
        'type',
        'network_range_type',
        'scanning_enabled',
        'device_confidence',
        'dhcp_fingerprint',
        'source',
      ]),
    );
  });

  it('restores valid persisted order, removes retired keys, and keeps identity visible', () => {
    expect(restoreWorkspaceColumnKeys('addresses', ['hostname', 'retired', 'status'])).toEqual([
      'ip_address',
      'hostname',
      'status',
    ]);
    expect(restoreWorkspaceColumnKeys('addresses', null)).toEqual(
      defaultWorkspaceColumnKeys('addresses'),
    );
  });
});
