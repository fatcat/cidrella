/**
 * Service accounts and their API tokens.
 *
 * The behaviour worth pinning is mostly negative: a machine credential must not
 * become an interactive login, a person must not quietly acquire a long-lived
 * key, and a revoked or expired token must stop working without the account
 * being touched.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { default: request } = await import('supertest');

let tmpDir;
let db;
let app;
let tokens;

function makeApp(router, user = { id: 1, role: 'admin', username: 'admin' }) {
  const testApp = express();
  testApp.use(express.json());
  testApp.use((req, res, next) => { req.user = user; next(); });
  testApp.use('/api/users', router);
  return testApp;
}

async function makeServiceAccount(username, role = 'readonly_dhcp') {
  const res = await request(app).post('/api/users').send({ username, role, kind: 'service' });
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-'));
  for (const d of ['dnsmasq/hosts.d', 'dnsmasq/dhcp-hosts.d', 'dnsmasq/conf.d', 'certs']) {
    fs.mkdirSync(path.join(tmpDir, d), { recursive: true });
  }
  process.env.DATA_DIR = tmpDir;

  vi.resetModules();
  const init = await import('../../../src/db/init.js');
  await init.initDb(tmpDir);
  db = init.getDb();
  tokens = await import('../../../src/auth/tokens.js');
  const { default: usersRouter } = await import('../../../src/routes/users.js');
  app = makeApp(usersRouter);
});

afterAll(() => {
  if (tmpDir && tmpDir.includes('cidrella-test-')) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('service accounts', () => {
  it('creates one without handing back a password', async () => {
    const acct = await makeServiceAccount('switchmap');
    expect(acct.kind).toBe('service');
    // A machine has nobody to perform a first-login password change, so the
    // flag that would block every route must not be set.
    expect(acct.must_change_password).toBe(0);
    expect(acct.password).toBeUndefined();
  });

  it('still hands a person a one-time password and the change-on-login flag', async () => {
    const res = await request(app).post('/api/users').send({ username: 'alice', role: 'readonly' });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('person');
    expect(res.body.must_change_password).toBe(1);
    expect(typeof res.body.password).toBe('string');
  });

  it('refuses to mint a token for a person', async () => {
    const alice = db.prepare("SELECT id FROM users WHERE username = 'alice'").get();
    const res = await request(app).post(`/api/users/${alice.id}/tokens`).send({ name: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service accounts/i);
  });
});

describe('api tokens', () => {
  it('returns the secret exactly once and never again', async () => {
    const acct = await makeServiceAccount('poller-once');
    const made = await request(app).post(`/api/users/${acct.id}/tokens`).send({ name: 'switchmap' });

    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^cidr_pat_/);

    const list = await request(app).get(`/api/users/${acct.id}/tokens`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].token).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(made.body.token);
  });

  it('stores only a hash, so the database never holds a working credential', async () => {
    const acct = await makeServiceAccount('poller-hash');
    const made = await request(app).post(`/api/users/${acct.id}/tokens`).send({ name: 'k' });

    const row = db.prepare('SELECT token_hash FROM api_tokens WHERE user_id = ?').get(acct.id);
    expect(row.token_hash).not.toContain(made.body.token);
    expect(row.token_hash).toBe(tokens.hashToken(made.body.token));
  });

  it('resolves a good token to its account and role', async () => {
    const acct = await makeServiceAccount('poller-resolve');
    const made = await request(app).post(`/api/users/${acct.id}/tokens`).send({ name: 'k' });

    const { user, error } = tokens.resolveApiToken(db, made.body.token);
    expect(error).toBeUndefined();
    expect(user).toMatchObject({ id: acct.id, role: 'readonly_dhcp', kind: 'service' });
    expect(user.must_change_password).toBe(false);
  });

  it('reads the role from the account each time, so a change takes effect at once', async () => {
    const acct = await makeServiceAccount('poller-role');
    const made = await request(app).post(`/api/users/${acct.id}/tokens`).send({ name: 'k' });

    db.prepare("UPDATE users SET role = 'readonly' WHERE id = ?").run(acct.id);
    expect(tokens.resolveApiToken(db, made.body.token).user.role).toBe('readonly');
  });

  it('treats an expiry of zero as never', async () => {
    const acct = await makeServiceAccount('poller-never');
    const made = await request(app).post(`/api/users/${acct.id}/tokens`)
      .send({ name: 'forever', expires_in_days: 0 });

    expect(made.status).toBe(201);
    expect(made.body.expires_at).toBeNull();
    expect(tokens.resolveApiToken(db, made.body.token).error).toBeUndefined();
  });

  it('treats an absent expiry as never too', () => {
    expect(tokens.expiryFromDays(undefined)).toBeNull();
    expect(tokens.expiryFromDays(null)).toBeNull();
    expect(tokens.expiryFromDays(0)).toBeNull();
    expect(tokens.expiryFromDays(30)).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it('rejects a nonsense expiry rather than silently making it never', async () => {
    const acct = await makeServiceAccount('poller-badexp');
    for (const bad of [-1, 1.5, 'soon']) {
      const res = await request(app).post(`/api/users/${acct.id}/tokens`)
        .send({ name: 'k', expires_in_days: bad });
      expect(res.status).toBe(400);
    }
  });

  it('rejects an expired token', async () => {
    const acct = await makeServiceAccount('poller-expired');
    const made = await request(app).post(`/api/users/${acct.id}/tokens`).send({ name: 'k' });

    db.prepare("UPDATE api_tokens SET expires_at = datetime('now', '-1 day') WHERE id = ?")
      .run(made.body.id);
    expect(tokens.resolveApiToken(db, made.body.token).error).toBe('Token expired');
  });

  it('rejects a revoked token and keeps the row as history', async () => {
    const acct = await makeServiceAccount('poller-revoked');
    const made = await request(app).post(`/api/users/${acct.id}/tokens`).send({ name: 'k' });

    const del = await request(app).delete(`/api/users/${acct.id}/tokens/${made.body.id}`);
    expect(del.status).toBe(200);
    expect(tokens.resolveApiToken(db, made.body.token).error).toBe('Token revoked');

    const list = await request(app).get(`/api/users/${acct.id}/tokens`);
    expect(list.body[0].revoked_at).toBeTruthy();

    // revoking twice is a conflict, not a silent success
    const again = await request(app).delete(`/api/users/${acct.id}/tokens/${made.body.id}`);
    expect(again.status).toBe(409);
  });

  it('rejects an unknown token', () => {
    expect(tokens.resolveApiToken(db, 'cidr_pat_notarealtoken').error).toBe('Invalid token');
  });

  it('drops every token when the account is deleted', async () => {
    const acct = await makeServiceAccount('poller-doomed');
    await request(app).post(`/api/users/${acct.id}/tokens`).send({ name: 'k' });

    db.prepare('PRAGMA foreign_keys = ON').run();
    const res = await request(app).delete(`/api/users/${acct.id}`);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM api_tokens WHERE user_id = ?').get(acct.id).c).toBe(0);
  });

  it('requires a usable name', async () => {
    const acct = await makeServiceAccount('poller-name');
    for (const bad of ['', '   ', 'x'.repeat(65), 'semi;colon']) {
      const res = await request(app).post(`/api/users/${acct.id}/tokens`).send({ name: bad });
      expect(res.status).toBe(400);
    }
  });

  it('only recognises its own token shape', () => {
    expect(tokens.looksLikeApiToken('cidr_pat_abc')).toBe(true);
    expect(tokens.looksLikeApiToken('eyJhbGciOiJIUzI1NiIs')).toBe(false);
    expect(tokens.looksLikeApiToken(undefined)).toBe(false);
  });
});
