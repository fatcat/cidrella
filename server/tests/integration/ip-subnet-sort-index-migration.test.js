/**
 * Migration 092: a (subnet_id, address_sort_key) index serves one network's
 * addresses in address order, the page the IPv6 address list reads in SQL,
 * and replaces the single-column subnet index it leads with.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { databaseThrough } from '../helpers/migrations.js';

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

const indexes = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ip_addresses'")
    .all()
    .map((row) => row.name);

describe('migration 092', () => {
  it('adds the per-network sort index, drops the redundant one, and pages through it', () => {
    const { db, migrate } = databaseThrough(91, { tmpDirs });
    expect(indexes(db)).toContain('idx_ip_addresses_subnet');
    migrate(92);
    expect(indexes(db)).toContain('idx_ip_addresses_subnet_sort');
    expect(indexes(db)).not.toContain('idx_ip_addresses_subnet');
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM ip_addresses WHERE subnet_id = ?
          ORDER BY address_sort_key, interface_id LIMIT 10 OFFSET 20`,
      )
      .all(1)
      .map((row) => row.detail)
      .join(' ');
    expect(plan).toContain('idx_ip_addresses_subnet_sort');
    expect(plan).not.toContain('TEMP B-TREE');
    // The range a CIDR search narrows to uses it too.
    const range = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM ip_addresses
          WHERE subnet_id = ? AND address_sort_key BETWEEN ? AND ?`,
      )
      .all(1, '6', '7')
      .map((row) => row.detail)
      .join(' ');
    expect(range).toContain(
      'idx_ip_addresses_subnet_sort (subnet_id=? AND address_sort_key>? AND address_sort_key<?)',
    );
  });
});
