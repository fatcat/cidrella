import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import {
  BULK_SAMPLE,
  SECRET_MASK,
  changedFields,
  recordAudit,
  sample,
} from '../../../src/services/audit.js';
import { actorMiddleware } from '../../../src/utils/request-actor.js';

// Run fn as a request would: after authentication, with its context set.
const asRequest = (req, fn) => actorMiddleware(req, null, fn);

describe('recordAudit', () => {
  let db;
  let tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await setupTestDb());
  });
  afterEach(() => cleanupTestDb(tmpDir));

  const lastRow = () => {
    const row = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();
    return row && { ...row, details: row.details ? JSON.parse(row.details) : null };
  };

  it('names the signed-in user, the session origin and the client address', () => {
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
    asRequest({ user: { id: admin.id, username: 'admin' }, ip: '::ffff:10.0.0.5' }, () =>
      recordAudit({ action: 'vlan_created', entityType: 'vlan', entityId: 7 }),
    );
    expect(lastRow()).toMatchObject({
      action: 'vlan_created',
      actor: 'admin',
      user_id: admin.id,
      origin: 'ui',
      source: null,
      source_ip: '10.0.0.5',
      entity_id: 7,
    });
  });

  it('marks a request made with an API token, and an IPv6 client', () => {
    asRequest({ user: { id: null, username: 'ci-bot', token_id: 3 }, ip: '2001:db8::5' }, () =>
      recordAudit({ action: 'dns_record_created', entityType: 'dns_record' }),
    );
    expect(lastRow()).toMatchObject({
      actor: 'ci-bot',
      origin: 'api-token',
      source_ip: '2001:db8::5',
    });
  });

  it('records work outside any request as the system, with its source', () => {
    recordAudit({ action: 'dns_proxy_bypass_activated', source: 'proxy-health' });
    expect(lastRow()).toMatchObject({
      actor: 'system',
      origin: 'system',
      source: 'proxy-health',
      user_id: null,
      source_ip: null,
    });
  });

  it('keeps only the fields an edit changed, old and new', () => {
    recordAudit({
      action: 'subnet_updated',
      before: { name: 'lab', description: 'x', vlan_id: 10 },
      after: { name: 'lab', description: 'y', vlan_id: 20 },
    });
    expect(lastRow().details).toEqual({ changes: { description: ['x', 'y'], vlan_id: [10, 20] } });
  });

  it('compares only the fields named in only', () => {
    recordAudit({
      action: 'folder_updated',
      before: { name: 'a', sort_order: 1 },
      after: { name: 'b', sort_order: 9 },
      only: ['name'],
    });
    expect(lastRow().details.changes).toEqual({ name: ['a', 'b'] });
  });

  it('writes nothing for a save that changed nothing', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    const written = recordAudit({
      action: 'vlan_updated',
      before: { name: 'a' },
      after: { name: 'a' },
      details: { vlan_id: 300 },
    });
    expect(written).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n).toBe(before);
  });

  it('says a secret changed without its value', () => {
    recordAudit({
      action: 'setting_updated',
      before: { forwarder_dot_password: 'old', smtp_api_key: 'k1' },
      after: { forwarder_dot_password: 'new', smtp_api_key: 'k1' },
      details: { password: 'hunter2', password_set: true },
    });
    const { details } = lastRow();
    expect(details.changes).toEqual({ forwarder_dot_password: [SECRET_MASK, SECRET_MASK] });
    expect(details.password).toBe(SECRET_MASK);
    expect(details.password_set).toBe(true);
    expect(JSON.stringify(details)).not.toMatch(/old|new|hunter2/);
  });

  it('caps a bulk list at a count and the first few', () => {
    const many = Array.from({ length: BULK_SAMPLE + 5 }, (_, i) => `10.0.0.${i}`);
    expect(sample(many)).toEqual({ count: many.length, first: many.slice(0, BULK_SAMPLE) });
    expect(sample(['2001:db8::1'])).toEqual({ count: 1, items: ['2001:db8::1'] });
  });

  it('keeps an explicit null user id', () => {
    asRequest({ user: { id: 99, username: 'gone' }, ip: '10.0.0.1' }, () =>
      recordAudit({ action: 'database_reset', userId: null }),
    );
    expect(lastRow()).toMatchObject({ actor: 'gone', user_id: null });
  });
});

describe('changedFields', () => {
  it('counts a field only one side has', () => {
    expect(changedFields({ a: 1 }, { a: 1, b: 2 })).toEqual({ b: [null, 2] });
  });

  it('compares arrays and objects by value', () => {
    expect(changedFields({ list: [1, 2] }, { list: [1, 2] })).toEqual({});
    expect(changedFields({ list: [1, 2] }, { list: [2, 1] })).toEqual({
      list: [
        [1, 2],
        [2, 1],
      ],
    });
  });
});
