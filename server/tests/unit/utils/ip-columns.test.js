import { describe, expect, it } from 'vitest';
import {
  FILTERABLE,
  IP_COLUMNS,
  columnFacets,
  columnValue,
  compareByColumn,
  matchesColumnFilters,
  parseColumnFilters,
} from '../../../src/utils/ip-columns.js';
import { workspaceColumnCatalog } from '../../../../client/src/views/networks-workspace/workspace-columns.js';

describe('ip-columns', () => {
  it('knows every column of the client catalog, and no other', () => {
    // Cross-tier: the client offers a column, the server must be able to
    // filter, count and sort it.
    const clientKeys = workspaceColumnCatalog('addresses').map((column) => column.key);
    expect(Object.keys(IP_COLUMNS).sort()).toEqual([...clientKeys].sort());
  });

  it('reads a column the same way whichever table the row is from', () => {
    const record = { record_fqdn: 'hass.example.test', record_type: 'A', enabled: 0 };
    const addressRow = { ip_address: '10.0.3.228', dns_record: record, dhcp: null };
    const dnsRow = { ip_address: '10.0.3.228', ...record, dhcp: null };
    for (const [row, table] of [
      [addressRow, 'addresses'],
      [dnsRow, 'dns'],
    ]) {
      expect(columnValue(row, 'dns_hostname', table)).toBe('hass.example.test');
      expect(columnValue(row, 'record_enabled', table)).toBe(false);
      expect(columnValue(row, 'assignment', table)).toBeNull();
    }
    const held = { allocation_state: 'reserved', allocation_source_type: 'dns' };
    expect(columnValue(held, 'source', 'addresses')).toBe('dns_hold');
  });

  it('parses the filters parameter and refuses what it does not know', () => {
    expect(parseColumnFilters(undefined)).toEqual({ value: {} });
    expect(parseColumnFilters('{"record_enabled":[false],"status":["in use"]}').value).toEqual({
      record_enabled: [false],
      status: ['in use'],
    });
    expect(parseColumnFilters('{"lease":[null]}').value).toEqual({ lease: [null] });
    expect(parseColumnFilters('not json').error).toMatch(/JSON/);
    expect(parseColumnFilters('["status"]').error).toMatch(/JSON object/);
    expect(parseColumnFilters('{"password":["x"]}').error).toMatch(/unknown column/);
    expect(parseColumnFilters('{"ttl":["300"]}').error).toMatch(/unknown column/);
    expect(parseColumnFilters('{"status":[{"$ne":1}]}').error).toMatch(/strings, booleans/);
    expect(parseColumnFilters(`{"status":["${'x'.repeat(201)}"]}`).error).toMatch(/strings/);
    expect(parseColumnFilters('{"hostname":["a","b"]}').error).toMatch(/one string/);
  });

  it('matches enum values exactly and text columns by substring', () => {
    const row = { hostname: 'Hass.Example.test', ip_display_status: 'in use', is_online: 1 };
    expect(matchesColumnFilters(row, { hostname: ['hass'] }, 'addresses')).toBe(true);
    expect(matchesColumnFilters(row, { status: ['in use', 'available'] }, 'addresses')).toBe(true);
    expect(matchesColumnFilters(row, { status: ['available'] }, 'addresses')).toBe(false);
    expect(matchesColumnFilters(row, { is_online: [true] }, 'addresses')).toBe(true);
    expect(matchesColumnFilters(row, { lease: [null] }, 'addresses')).toBe(true);
  });

  it('counts values over weighted rows, each column ignoring its own filter', () => {
    const entries = [
      { row: { ip_display_status: 'in use', is_online: 1 } },
      { row: { ip_display_status: 'in use', is_online: 0 } },
      { row: { ip_display_status: 'available', is_online: 0 }, weight: 250 },
    ];
    const facets = columnFacets(entries, { status: ['in use'] }, 'addresses');
    // Status ignores its own filter: every status still offered.
    expect(facets.status).toEqual([
      { value: 'available', count: 250 },
      { value: 'in use', count: 2 },
    ]);
    // Online counts only rows the status filter lets through.
    expect(facets.is_online).toEqual([
      { value: false, count: 1 },
      { value: true, count: 1 },
    ]);
    expect(Object.keys(facets)).not.toContain('hostname');
  });

  it('sorts any column with empty values last', () => {
    const rows = [{ hostname: 'b' }, { hostname: null }, { hostname: 'A' }];
    rows.sort(compareByColumn('hostname', 'asc', 'addresses'));
    expect(rows.map((row) => row.hostname)).toEqual(['A', 'b', null]);
    expect(FILTERABLE).not.toContain('ttl');
  });
});
