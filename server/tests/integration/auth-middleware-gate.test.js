/**
 * The must-change-password gate in the auth middleware. A user who still has
 * to change their password can reach change-password, /me and, read-only, the
 * first-run setup state (the wizard's password step needs the policy and the
 * markers before the change). Everything else, including writing markers, is
 * a 403 until the password is changed.
 */
import express from 'express';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../helpers/test-db.js';

const { default: request } = await import('supertest');
const { authMiddleware } = await import('../../src/auth/middleware.js');
const { default: authRouter } = await import('../../src/auth/routes.js');
const { default: setupRouter } = await import('../../src/routes/setup.js');

let tmpDir;
let app;
let token;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  setup.db
    .prepare(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 1)",
    )
    .run('gate-admin', bcrypt.hashSync('GateAdmin123', 10));

  app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use('/api/auth', authRouter);
  app.use('/api/setup', setupRouter);
  app.get('/api/anything', (_req, res) => res.json({ ok: true }));

  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'gate-admin', password: 'GateAdmin123' });
  expect(login.status).toBe(200);
  token = login.body.token;
});

afterAll(() => cleanupTestDb(tmpDir));

const as = (req) => req.set('Authorization', `Bearer ${token}`);

describe('must-change-password gate', () => {
  it('lets the setup state be read before the password is changed', async () => {
    const res = await as(request(app).get('/api/setup/state'));
    expect(res.status).toBe(200);
    expect(res.body.password_policy).toBeDefined();
  });

  it('lets the password step switch complexity off before the change, and nothing else through', async () => {
    const put = await as(request(app).put('/api/setup/state')).send({ password_complexity: false });
    expect(put.status).toBe(200);
    expect(put.body.password_policy.requireDigit).toBe(false);
    const other = await as(request(app).get('/api/anything'));
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('MUST_CHANGE_PASSWORD');
  });

  it('change-password then honors the length-only policy', async () => {
    const weak = await as(request(app).post('/api/auth/change-password')).send({
      current_password: 'GateAdmin123',
      new_password: 'aaaaaaaa',
    });
    expect(weak.status).toBe(200);
    token = weak.body.token;
    // Back to the strict rule for the rest of the suite.
    const put = await as(request(app).put('/api/setup/state')).send({ password_complexity: true });
    expect(put.status).toBe(200);
    const strict = await as(request(app).post('/api/auth/change-password')).send({
      current_password: 'aaaaaaaa',
      new_password: 'bbbbbbbb',
    });
    expect(strict.status).toBe(400);
    const ok = await as(request(app).post('/api/auth/change-password')).send({
      current_password: 'aaaaaaaa',
      new_password: 'GateAdmin123',
    });
    expect(ok.status).toBe(200);
    token = ok.body.token;
  });

  it('opens up once the password is changed', async () => {
    const put = await as(request(app).put('/api/setup/state')).send({ password: true });
    expect(put.status).toBe(200);
    expect(put.body.password).toBe(true);
    const other = await as(request(app).get('/api/anything'));
    expect(other.status).toBe(200);
  });
});
