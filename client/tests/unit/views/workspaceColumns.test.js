import { describe, expect, it } from 'vitest';
import {
  LOCKED,
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

  it('offers every column on all three IP tables, differing only in what is locked', () => {
    const keys = (kind) => workspaceColumnCatalog(kind).map((column) => column.key);
    expect(keys('dns')).toEqual(keys('addresses'));
    expect(keys('dhcp')).toEqual(keys('addresses'));
    expect(keys('addresses')).toEqual(
      expect.arrayContaining(['dns_hostname', 'record_type', 'ttl', 'assignment', 'duid']),
    );
    for (const kind of ['addresses', 'dns', 'dhcp']) {
      const locked = workspaceColumnCatalog(kind)
        .filter((column) => column.locked)
        .map((column) => column.key);
      expect(locked.sort()).toEqual([...LOCKED[kind]].sort());
    }
  });

  it('gives each meaning its own column, one key per meaning', () => {
    const byKey = new Map(workspaceColumnCatalog('dns').map((column) => [column.key, column]));
    expect(byKey.has('enabled')).toBe(false);
    expect(byKey.get('record_enabled').field).toBe('enabled');
    expect(byKey.get('reservation_enabled').header).toBe('Reservation Enabled');
    expect(byKey.get('source').field).toBe('allocation_source_type');
    expect(byKey.get('record_source').field).toBe('dns_source');
    const headers = workspaceColumnCatalog('dns').map((column) => column.header);
    expect(new Set(headers).size).toBe(headers.length);
  });

  it('puts back a locked column a saved preference lacks, keeping the saved order', () => {
    expect(restoreWorkspaceColumnKeys('dhcp', ['network', 'hostname', 'ip_address'])).toEqual([
      'mac_address',
      'assignment',
      'lease',
      'expires',
      'type',
      'network',
      'hostname',
      'ip_address',
    ]);
  });

  it('maps a saved enabled or source column to its new meaning per table', () => {
    expect(restoreWorkspaceColumnKeys('dns', ['dns_hostname', 'enabled', 'source'])).toEqual([
      'record_type',
      'value',
      'dns_hostname',
      'record_enabled',
      'record_source',
    ]);
    expect(restoreWorkspaceColumnKeys('dhcp', [...LOCKED.dhcp, 'enabled', 'source'])).toEqual([
      ...LOCKED.dhcp,
      'reservation_enabled',
      'source',
    ]);
  });
});
