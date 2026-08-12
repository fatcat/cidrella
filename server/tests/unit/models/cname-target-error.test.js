import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { cnameTargetError } from '../../../src/models/dns-record.js';

/**
 * The CNAME-target rules, which used to be enforced on only one of the two
 * paths that create CNAMEs.
 *
 * routes/dns.js (the UI) called a local cnameTargetError enforcing three rules:
 * fully qualified, inside the zone, and the target already exists as an enabled
 * A or CNAME. routes/pihole.js validated an imported CNAME with isValidDomain
 * alone, so an import could write a CNAME in a local zone pointing at an
 * arbitrary external domain, or at nothing, that the same appliance refuses if
 * you type it into the DNS page.
 *
 * The batch argument is the reason the shared function needed a parameter
 * rather than being called as-is: a bulk import validates every record BEFORE
 * inserting any, so the "already exists" rule would reject a CNAME pointing at
 * an A record in the same file. That is the ordinary Pi-hole case, so getting
 * this wrong breaks real imports rather than merely being strict.
 *
 * See REVIEW.md, duplicate-logic audit #18.
 */

let db, tmpDir, zone;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
});
afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
  const id = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('lab.lan', 'forward', 1)").run().lastInsertRowid;
  zone = { id, name: 'lab.lan', type: 'forward', enabled: 1 };
  db.prepare("INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, 'nas', 'A', '10.0.0.5', 1)").run(id);
});

describe('cnameTargetError', () => {
  it('accepts a target that exists in the zone', () => {
    expect(cnameTargetError(db, 'nas.lab.lan', zone)).toBeNull();
  });

  it('refuses a target outside the zone', () => {
    // The import hole: this is a syntactically valid domain, so isValidDomain
    // alone passed it straight through.
    const err = cnameTargetError(db, 'evil.example.com', zone);
    expect(err).toMatch(/must be inside lab\.lan/);
  });

  it('refuses a target that does not exist', () => {
    expect(cnameTargetError(db, 'ghost.lab.lan', zone)).toMatch(/must already exist/);
  });

  it('refuses an unqualified target', () => {
    expect(cnameTargetError(db, 'nas', zone)).toMatch(/fully qualified|must be inside/);
  });

  it('refuses a syntactically invalid target', () => {
    expect(cnameTargetError(db, 'not a domain', zone)).toMatch(/Invalid target domain/);
  });

  it('ignores a disabled record when deciding the target exists', () => {
    db.prepare("UPDATE dns_records SET enabled = 0 WHERE name = 'nas'").run();
    expect(cnameTargetError(db, 'nas.lab.lan', zone)).toMatch(/must already exist/);
  });

  describe('batch awareness (the import path)', () => {
    it('accepts a target present only in the batch, not yet in the DB', () => {
      // Without this the ordinary Pi-hole file (a host plus a CNAME pointing at
      // it) would be rejected wholesale, because nothing is inserted until
      // every record has been validated.
      const batch = new Set(['printer.lab.lan']);
      expect(cnameTargetError(db, 'printer.lab.lan', zone, batch)).toBeNull();
    });

    it('still refuses an out-of-zone target even when the batch lists it', () => {
      // The batch relaxes existence, NOT the zone boundary. If it relaxed both,
      // the fix would have reopened the hole it was written to close.
      const batch = new Set(['evil.example.com']);
      expect(cnameTargetError(db, 'evil.example.com', zone, batch)).toMatch(/must be inside lab\.lan/);
    });

    it('still refuses a target in neither the DB nor the batch', () => {
      expect(cnameTargetError(db, 'ghost.lab.lan', zone, new Set(['other.lab.lan'])))
        .toMatch(/must already exist/);
    });

    it('matches the batch case-insensitively', () => {
      expect(cnameTargetError(db, 'Printer.Lab.LAN', zone, new Set(['printer.lab.lan']))).toBeNull();
    });
  });
});
