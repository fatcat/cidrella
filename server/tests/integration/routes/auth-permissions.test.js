import express from 'express';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';

const { default: request } = await import('supertest');
const { default: authRouter } = await import('../../../src/auth/routes.js');

let app;
let tmpDir;
let userId;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  const passwordHash = bcrypt.hashSync('PermissionTest123', 10);
  const inserted = setup.db
    .prepare(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'dns_admin', 0)",
    )
    .run('permission-test', passwordHash);
  userId = Number(inserted.lastInsertRowid);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.path !== '/login') req.user = { id: userId, role: 'dns_admin' };
    next();
  });
  app.use('/api/auth', authRouter);
});

afterAll(() => cleanupTestDb(tmpDir));

function expectDnsAdminProjection(user) {
  expect(user.permissions).toEqual([
    'dns:read',
    'dns:write',
    'subnets:read',
    'system:read',
    'analytics:read',
  ]);
  expect(user.is_admin).toBe(false);
}

describe('auth capability projection', () => {
  it('includes permissions in login and /me without removing existing fields', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'permission-test', password: 'PermissionTest123' });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
    expect(login.body.user).toMatchObject({ username: 'permission-test', role: 'dns_admin' });
    expectDnsAdminProjection(login.body.user);

    const me = await request(app).get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ username: 'permission-test', role: 'dns_admin' });
    expectDnsAdminProjection(me.body);
  });

  it('includes the same server-owned projection after changing a password', async () => {
    const changed = await request(app).post('/api/auth/change-password').send({
      current_password: 'PermissionTest123',
      new_password: 'ChangedPermission456',
    });
    expect(changed.status).toBe(200);
    expect(changed.body.token).toBeTruthy();
    expect(changed.body.user).toMatchObject({ username: 'permission-test', role: 'dns_admin' });
    expectDnsAdminProjection(changed.body.user);
  });
});
