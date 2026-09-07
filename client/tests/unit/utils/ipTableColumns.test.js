import { beforeEach, describe, expect, it } from 'vitest';
import { useColumnPreferences } from '../../../src/composables/useColumnPreferences.js';
import {
  IP_TABLE_COLUMN_ALIASES,
  IP_TABLE_DEFAULT_KEYS,
  IP_TABLE_VIEW,
  ipTableColumns
} from '../../../src/utils/ipTableColumns.js';

describe('shared IP table column catalog', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('offers the same possible columns in every IP-bearing table', () => {
    const views = Object.values(IP_TABLE_VIEW);
    const expected = ipTableColumns(views[0]).map(column => column.key);

    for (const view of views.slice(1)) {
      expect(ipTableColumns(view).map(column => column.key)).toEqual(expected);
    }
    expect(expected).toContain('source');
    expect(expected).toContain('scanning_enabled');
    expect(expected).toContain('network_range_type');
    expect(expected).toEqual(expect.arrayContaining([
      'os_family',
      'device_type',
      'device_confidence',
      'dhcp_fingerprint',
      'dhcp_vendor_class',
      'dhcp_fingerprint_hostname',
      'device_fingerprint_source'
    ]));
  });

  it('keeps each current table combination as its reset default', () => {
    for (const view of Object.values(IP_TABLE_VIEW)) {
      const columns = ipTableColumns(view);
      const preferences = useColumnPreferences(`test_columns_${view}`, columns, {
        defaultKeys: IP_TABLE_DEFAULT_KEYS[view],
        aliases: IP_TABLE_COLUMN_ALIASES[view]
      });
      expect(preferences.visibleColumns.value.map(column => column.key))
        .toEqual(IP_TABLE_DEFAULT_KEYS[view]);
    }
  });

  it('migrates prior stored column keys without discarding preferences', () => {
    globalThis.localStorage.setItem('test_network_columns', JSON.stringify(['ip_address', 'dhcp_expires_at']));
    const preferences = useColumnPreferences(
      'test_network_columns',
      ipTableColumns(IP_TABLE_VIEW.NETWORKS),
      {
        defaultKeys: IP_TABLE_DEFAULT_KEYS[IP_TABLE_VIEW.NETWORKS],
        aliases: IP_TABLE_COLUMN_ALIASES[IP_TABLE_VIEW.NETWORKS]
      }
    );

    expect(preferences.visibleColumns.value.map(column => column.key)).toEqual(['ip_address', 'expires']);
  });
});
