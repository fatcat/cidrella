import { describe, it, expect } from 'vitest';
import {
  activeLeaseSql,
  reservedLeaseFirstSql,
  isLeaseActive,
  leaseExpiryMs,
} from '../../../src/utils/lease-sql.js';

/**
 * Duplicate-logic audit #26. The active-lease predicate was hand-written in 13
 * queries across five files.
 *
 * The important property is that the extraction changed NOTHING: these assert
 * the emitted text against the exact strings that were in the source before, so
 * a "tidy up the SQL" edit that alters semantics has to fail here rather than
 * quietly change which leases count as active across sixteen queries at once.
 */
describe('#26: emitted SQL is byte-identical to the copies it replaced', () => {
  it('predicate with a table alias', () => {
    expect(activeLeaseSql('dl')).toBe(
      "(dl.expires_at = 'infinite' OR datetime(dl.expires_at) > datetime('now'))",
    );
    expect(activeLeaseSql('l')).toBe(
      "(l.expires_at = 'infinite' OR datetime(l.expires_at) > datetime('now'))",
    );
  });

  it('predicate with no alias', () => {
    expect(activeLeaseSql()).toBe(
      "(expires_at = 'infinite' OR datetime(expires_at) > datetime('now'))",
    );
    expect(activeLeaseSql('')).toBe(activeLeaseSql());
  });

  it('is parenthesised, so it can be dropped into a WHERE next to AND', () => {
    expect(activeLeaseSql('dl').startsWith('(')).toBe(true);
    expect(activeLeaseSql('dl').endsWith(')')).toBe(true);
  });
});

describe('#26: the predicate actually runs and selects the right rows', () => {
  it('accepts infinite and future leases, rejects past ones', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE dhcp_leases (ip_address TEXT, expires_at TEXT)');
    db.prepare('INSERT INTO dhcp_leases VALUES (?,?)').run('10.0.0.1', 'infinite');
    db.prepare("INSERT INTO dhcp_leases VALUES (?, datetime('now','+1 hour'))").run('10.0.0.2');
    db.prepare("INSERT INTO dhcp_leases VALUES (?, datetime('now','-1 hour'))").run('10.0.0.3');
    db.prepare('INSERT INTO dhcp_leases VALUES (?,?)').run('10.0.0.4', null);

    const rows = db
      .prepare(`SELECT ip_address FROM dhcp_leases WHERE ${activeLeaseSql()} ORDER BY ip_address`)
      .pluck()
      .all();
    expect(rows).toEqual(['10.0.0.1', '10.0.0.2']);

    // A NULL expires_at is not active. datetime(NULL) is NULL and NULL > x is
    // NULL, which WHERE drops, so this falls out of the predicate rather than
    // being special-cased. Worth pinning because it is not obvious by reading.
    expect(rows).not.toContain('10.0.0.4');

    db.close();
  });
});

describe('reservedLeaseFirstSql', () => {
  // Two leases on one address: another client's later one, and the reserved
  // client's. dnsmasq marks the reserved one 'infinite'; Kea gives it a real,
  // earlier expiry. Either way the reserved client's lease comes first.
  async function rank({ alias, reservedExpiry, family }) {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE dhcp_leases (subnet_id INTEGER, ip_address TEXT, mac_address TEXT,
      duid TEXT, expires_at TEXT, hostname TEXT)`);
    db.exec(`CREATE TABLE dhcp_reservations (subnet_id INTEGER, ip_address TEXT,
      mac_address TEXT, duid TEXT, enabled INTEGER)`);
    const ip = family === 4 ? '10.0.0.5' : 'fd00:5::5';
    const reserved = family === 4 ? ['AA:BB:CC:00:00:05', null] : [null, '00:01:00:01:aa:bb:00:05'];
    const other = family === 4 ? ['aa:bb:cc:00:00:99', null] : [null, '00:01:00:01:aa:bb:00:99'];
    db.prepare('INSERT INTO dhcp_reservations VALUES (1, ?, ?, ?, 1)').run(ip, ...reserved);
    const insert = db.prepare('INSERT INTO dhcp_leases VALUES (1, ?, ?, ?, ?, ?)');
    insert.run(ip, ...other, '2100-01-02 00:00:00', 'other');
    insert.run(ip, reserved[0]?.toLowerCase() ?? null, reserved[1], reservedExpiry, 'reserved');
    const from = alias ? `dhcp_leases ${alias}` : 'dhcp_leases';
    const ref = alias ? `${alias}.` : '';
    const first = db
      .prepare(
        `SELECT hostname FROM ${from} ORDER BY ${reservedLeaseFirstSql(alias)},
           datetime(${ref}expires_at) DESC LIMIT 1`,
      )
      .pluck()
      .get();
    db.close();
    return first;
  }

  for (const family of [4, 6]) {
    for (const alias of ['', 'l']) {
      it(`ranks the reserved IPv${family} client first, dnsmasq or Kea (alias '${alias}')`, async () => {
        expect(await rank({ alias, family, reservedExpiry: 'infinite' })).toBe('reserved');
        expect(await rank({ alias, family, reservedExpiry: '2100-01-01 00:00:00' })).toBe(
          'reserved',
        );
      });
    }
  }
});

describe('#26: the known divergence from the JS twin', () => {
  it('is a sub-second boundary only, and is recorded on purpose', async () => {
    // isLeaseActive() uses millisecond precision and >=.
    // The SQL truncates to whole seconds and uses >. They can therefore
    // disagree only about a lease expiring within the current second. This
    // test exists so the divergence stays a decision rather than becoming a
    // surprise; if the two are ever unified, delete it deliberately.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE dhcp_leases (expires_at TEXT)');
    db.prepare("INSERT INTO dhcp_leases VALUES (datetime('now'))").run();
    const sqlSaysActive = db
      .prepare(`SELECT COUNT(*) FROM dhcp_leases WHERE ${activeLeaseSql()}`)
      .pluck()
      .get();
    // SQL: expires exactly now is NOT active, because it uses strict >.
    expect(sqlSaysActive).toBe(0);
    db.close();
  });
});

describe('JavaScript lease expiry parsing', () => {
  it('treats SQLite datetime text as UTC rather than server local time', () => {
    expect(leaseExpiryMs('2031-05-20 12:00:00')).toBe(Date.parse('2031-05-20T12:00:00Z'));
    expect(isLeaseActive('2031-05-20 12:00:00', Date.parse('2031-05-20T12:00:01Z'))).toBe(false);
  });

  it('supports ISO, infinite, empty, and invalid values', () => {
    expect(isLeaseActive('2031-05-20T12:00:00.000Z', Date.parse('2031-05-20T11:59:59Z'))).toBe(
      true,
    );
    expect(isLeaseActive('infinite')).toBe(true);
    expect(isLeaseActive(null)).toBe(false);
    expect(isLeaseActive('not-a-date')).toBe(false);
  });
});
