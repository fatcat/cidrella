/**
 * First-run setup state: GET /api/setup/state hands the client the step
 * markers and the password policy, PUT merges the markers it is given and
 * validates each one. The API is never gated on this state; that is the
 * router's job on the client.
 */
import express from 'express';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

const { default: request } = await import('supertest');
const { default: setupRouter } = await import('../../../src/routes/setup.js');
const { default: authRouter } = await import('../../../src/auth/routes.js');
const { getSetupState, setSetupState } = await import('../../../src/models/setting.js');

let tmpDir;
let db;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createTestApp(setupRouter, '/api/setup');
});

afterAll(() => cleanupTestDb(tmpDir));

describe('GET /api/setup/state', () => {
  it('starts with nothing done on a fresh database and serves the password policy', async () => {
    const res = await request(app).get('/api/setup/state');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      password: false,
      totp: null,
      deployment: null,
      import: null,
      done: false,
    });
    expect(res.body.password_policy).toMatchObject({
      minLength: 8,
      maxLength: 1024,
      requireMixedCase: true,
      requireNumber: true,
      requireSymbol: false,
    });
    expect(res.body.password_policy.description).toContain('At least 8 characters');
  });
});

describe('password policy', () => {
  it('changes one part at a time, serves the result, and leaves the markers alone', async () => {
    let res = await request(app)
      .put('/api/setup/state')
      .send({ password_policy: { requireMixedCase: false, requireNumber: false, minLength: 0 } });
    expect(res.status).toBe(200);
    expect(res.body.password_policy).toMatchObject({
      minLength: 0,
      requireMixedCase: false,
      requireNumber: false,
      requireSymbol: false,
    });
    expect(res.body.password_policy.description).toBe('Any password up to 1024 characters.');
    expect(res.body.password).toBe(false);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'password_min_length'").get().value,
    ).toBe('0');
    res = await request(app)
      .put('/api/setup/state')
      .send({ password_policy: { requireSymbol: true } });
    expect(res.body.password_policy).toMatchObject({ requireSymbol: true, requireNumber: false });
    res = await request(app)
      .put('/api/setup/state')
      .send({
        password_policy: {
          minLength: 8,
          requireMixedCase: true,
          requireNumber: true,
          requireSymbol: false,
        },
      });
    expect(res.body.password_policy.description).toContain('a number');
  });

  it('rejects bad parts', async () => {
    for (const body of [
      { password_policy: { minLength: -1 } },
      { password_policy: { minLength: 'eight' } },
      { password_policy: { requireSymbol: 'yes' } },
      { password_policy: {} },
      { password_policy: 'strict' },
    ]) {
      const res = await request(app).put('/api/setup/state').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('totp marker', () => {
  it('takes enabled, skipped or null and nothing else', async () => {
    for (const totp of ['enabled', 'skipped', null]) {
      const res = await request(app).put('/api/setup/state').send({ totp });
      expect(res.status).toBe(200);
      expect(res.body.totp).toBe(totp);
    }
    const bad = await request(app).put('/api/setup/state').send({ totp: 'maybe' });
    expect(bad.status).toBe(400);
  });
});

describe('PUT /api/setup/state', () => {
  it('merges one marker at a time and leaves the others alone', async () => {
    let res = await request(app).put('/api/setup/state').send({ password: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ password: true, deployment: null, done: false });

    res = await request(app)
      .put('/api/setup/state')
      .send({ deployment: { role: 'dns', interfaces: { eth0: { dns: true, dhcp: false } } } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      password: true,
      deployment: { role: 'dns', interfaces: { eth0: { dns: true, dhcp: false } } },
    });

    res = await request(app)
      .put('/api/setup/state')
      .send({ import: { kind: 'pihole' } });
    expect(res.body.import).toEqual({ kind: 'pihole' });
    expect(res.body.deployment.role).toBe('dns');

    expect(getSetupState(db)).toMatchObject({ password: true, done: false });
  });

  it('records each step in the audit log', () => {
    const rows = db
      .prepare("SELECT details FROM audit_log WHERE action = 'setup_step' ORDER BY id")
      .all()
      .map((r) => JSON.parse(r.details));
    expect(rows.slice(-3)).toEqual([
      { password: true },
      { deployment: { role: 'dns', interfaces: { eth0: { dns: true, dhcp: false } } } },
      { import: { kind: 'pihole' } },
    ]);
  });

  it('rejects an unknown role, a bad interface map, a bad import kind and an empty body', async () => {
    for (const [body, message] of [
      [{ deployment: { role: 'all' } }, 'deployment.role'],
      [{ deployment: { role: 'both', interfaces: { 'bad name': {} } } }, 'deployment.interfaces'],
      [
        { deployment: { role: 'both', interfaces: { eth0: { dns: 'yes' } } } },
        'dns must be boolean',
      ],
      [{ import: { kind: 'csv' } }, 'import.kind'],
      [{ password: 'yes' }, 'password must be a boolean'],
      [{ done: 1 }, 'done must be a boolean'],
      [{}, 'nothing to update'],
      [{ unrelated: true }, 'nothing to update'],
    ]) {
      const res = await request(app).put('/api/setup/state').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toContain(message);
    }
    expect(getSetupState(db).deployment.role).toBe('dns');
  });

  it('needs system:write', async () => {
    const viewer = express();
    viewer.use(express.json());
    viewer.use((req, _res, next) => {
      req.user = { id: 1, role: 'viewer', username: 'viewer' };
      next();
    });
    viewer.use('/api/setup', setupRouter);
    const read = await request(viewer).get('/api/setup/state');
    expect(read.status).toBe(200);
    const write = await request(viewer).put('/api/setup/state').send({ done: true });
    expect(write.status).toBe(403);
    expect(getSetupState(db).done).toBe(false);
  });

  it('can clear a step and finish', async () => {
    let res = await request(app).put('/api/setup/state').send({ import: null });
    expect(res.body.import).toBeNull();
    res = await request(app).put('/api/setup/state').send({ done: true });
    expect(res.body.done).toBe(true);
    expect(getSetupState(db).done).toBe(true);
  });

  it('treats a corrupt stored value as a fresh state', () => {
    db.prepare("UPDATE settings SET value = 'not json' WHERE key = 'setup_state'").run();
    expect(getSetupState(db)).toEqual({
      password: false,
      totp: null,
      deployment: null,
      import: null,
      done: false,
    });
    setSetupState(db, { done: true });
  });
});

describe('setup_required on the auth payloads', () => {
  let authApp;
  let adminId;
  let dnsAdminId;

  beforeAll(() => {
    const hash = bcrypt.hashSync('SetupFlow123', 10);
    adminId = Number(
      db
        .prepare(
          "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 1)",
        )
        .run('setup-admin', hash).lastInsertRowid,
    );
    dnsAdminId = Number(
      db
        .prepare(
          "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'dns_admin', 1)",
        )
        .run('setup-dns', hash).lastInsertRowid,
    );
    authApp = express();
    authApp.use(express.json());
    authApp.use((req, _res, next) => {
      const id = Number(req.headers['x-test-user']);
      if (id) req.user = { id, role: id === adminId ? 'admin' : 'dns_admin' };
      next();
    });
    authApp.use('/api/auth', authRouter);
  });

  it('is true for an admin while setup is unfinished, on login, /me and change-password', async () => {
    setSetupState(db, { done: false });
    const login = await request(authApp)
      .post('/api/auth/login')
      .send({ username: 'setup-admin', password: 'SetupFlow123' });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ must_change_password: true, setup_required: true });

    const me = await request(authApp).get('/api/auth/me').set('x-test-user', String(adminId));
    expect(me.body.setup_required).toBe(true);

    const changed = await request(authApp)
      .post('/api/auth/change-password')
      .set('x-test-user', String(adminId))
      .send({ current_password: 'SetupFlow123', new_password: 'SetupFlow456' });
    expect(changed.status).toBe(200);
    expect(changed.body.user).toMatchObject({ must_change_password: false, setup_required: true });
  });

  it('is false for a non-admin even while setup is unfinished', async () => {
    const me = await request(authApp).get('/api/auth/me').set('x-test-user', String(dnsAdminId));
    expect(me.body).toMatchObject({ must_change_password: true, setup_required: false });
  });

  it('is false for everyone once setup is done', async () => {
    setSetupState(db, { done: true });
    const me = await request(authApp).get('/api/auth/me').set('x-test-user', String(adminId));
    expect(me.body.setup_required).toBe(false);
  });
});
