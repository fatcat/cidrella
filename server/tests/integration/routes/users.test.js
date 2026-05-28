import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { default: request } = await import('supertest');

let tmpDir;
let db;
let app;

function makeApp(router, user = { id: 1, role: 'admin', username: 'admin' }) {
  const testApp = express();
  testApp.use(express.json());
  testApp.use((req, res, next) => {
    req.user = user;
    next();
  });
  testApp.use('/api/users', router);
  return testApp;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-'));
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'hosts.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'dhcp-hosts.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'conf.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'certs'), { recursive: true });
  process.env.DATA_DIR = tmpDir;

  vi.resetModules();
  const init = await import('../../../src/db/init.js');
  await init.initDb(tmpDir);
  db = init.getDb();
  const { default: usersRouter } = await import('../../../src/routes/users.js');
  app = makeApp(usersRouter);
});

afterAll(() => {
  if (tmpDir && tmpDir.includes('cidrella-test-')) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('users role management', () => {
  it('returns the backend role catalog used by the UI', async () => {
    const res = await request(app).get('/api/users/roles');

    expect(res.status).toBe(200);
    expect(res.body.map(r => r.value).sort()).toEqual([
      'admin',
      'dhcp_admin',
      'dns_admin',
      'readonly',
      'readonly_dhcp',
      'readonly_dns'
    ].sort());
    expect(res.body.find(r => r.value === 'dns_admin')).toMatchObject({
      label: 'DNS Administrator'
    });
    expect(res.body.find(r => r.value === 'dns_admin').permissions).toContain('dns:write');
  });

  it('rejects unknown roles on create and update', async () => {
    const create = await request(app)
      .post('/api/users')
      .send({ username: 'badrole', role: 'superuser' });
    expect(create.status).toBe(400);

    const user = await request(app)
      .post('/api/users')
      .send({ username: 'rolecheck', role: 'readonly' });
    expect(user.status).toBe(201);

    const update = await request(app)
      .put(`/api/users/${user.body.id}`)
      .send({ role: 'superuser' });
    expect(update.status).toBe(400);
  });

  it('stores role changes and prevents self-demotion', async () => {
    const user = await request(app)
      .post('/api/users')
      .send({ username: 'dhcpuser', role: 'readonly_dhcp' });
    expect(user.status).toBe(201);
    expect(user.body.role).toBe('readonly_dhcp');

    const update = await request(app)
      .put(`/api/users/${user.body.id}`)
      .send({ role: 'dhcp_admin' });
    expect(update.status).toBe(200);
    expect(update.body.role).toBe('dhcp_admin');

    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(user.body.id);
    expect(row.role).toBe('dhcp_admin');

    const selfUpdate = await request(app)
      .put('/api/users/1')
      .send({ role: 'readonly' });
    expect(selfUpdate.status).toBe(400);
  });

  it('requires admin for user administration routes', async () => {
    const { default: usersRouter } = await import('../../../src/routes/users.js');
    const nonAdminApp = makeApp(usersRouter, { id: 2, role: 'readonly', username: 'viewer' });

    const res = await request(nonAdminApp).get('/api/users/roles');
    expect(res.status).toBe(403);
  });
});
