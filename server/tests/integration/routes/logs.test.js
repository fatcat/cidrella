/**
 * /api/logs: the log of the backend filling a role, asked per request so a
 * stack switch moves the viewer with it; DHCP or DNS lines picked out where
 * one log serves both; an audit log never cleared.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { default: request } = await import('supertest');
const { backend } = await import('../../../src/backends/index.js');
const { setupTestDb, cleanupTestDb } = await import('../../helpers/test-db.js');
const { actorMiddleware } = await import('../../../src/utils/request-actor.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-route-'));
const file = path.join(dir, 'backend.log');
let app;
let server;
let role;
let db;
let dbDir;
beforeAll(async () => {
  ({ db, tmpDir: dbDir } = await setupTestDb());
  const { default: router } = await import('../../../src/routes/logs.js');
  app = express();
  app.use((req, res, next) => {
    req.user = { id: 1, role, username: 'tester' };
    next();
  });
  app.use(actorMiddleware);
  app.use('/api/logs', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
});
afterAll(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  cleanupTestDb(dbDir);
});
beforeEach(() => {
  role = 'admin';
  fs.writeFileSync(
    file,
    ['query[A] web.lab.test from 10.5.0.9', 'DHCPACK(eth0) 10.5.0.9 aa:bb:cc:00:00:01', ''].join(
      '\n',
    ),
  );
  backend.logSource = () => ({
    path: file,
    isDhcpLine: (line) => line.startsWith('DHCP'),
    querySourceIp: () => null,
    dhcpMessage: () => null,
    createDhcpParser: () => null,
  });
});

// The SSE backlog, up to its end marker.
async function backlog(query) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/logs/stream?${query}`);
  if (res.status !== 200) return { status: res.status, body: await res.json() };
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('event: backlog-end')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await reader.cancel();
  const lines = [...text.matchAll(/^data: (.*)$/gm)].map((m) => m[1]).filter((l) => l !== 'ok');
  return { status: 200, lines };
}

describe('GET /api/logs/stream', () => {
  it('shows the DHCP lines for the DHCP role where one log serves both', async () => {
    expect((await backlog('role=dhcp')).lines).toEqual([
      'DHCPACK(eth0) 10.5.0.9 aa:bb:cc:00:00:01',
    ]);
    expect((await backlog('role=dns')).lines).toEqual(['query[A] web.lab.test from 10.5.0.9']);
  });

  it('keeps the filter parameter for a request without a role', async () => {
    expect((await backlog('filter=all')).lines).toHaveLength(2);
  });

  it('says when the backend keeps no log, and refuses an unknown role', async () => {
    backend.logSource = () => null;
    expect(await backlog('role=dhcp')).toEqual({
      status: 404,
      body: { error: 'fake keeps no DHCP log to show' },
    });
    expect((await backlog('role=ra')).status).toBe(400);
  });
});

describe('POST /api/logs/clear', () => {
  it('truncates the role log', async () => {
    const bytes = fs.statSync(file).size;
    const res = await request(app).post('/api/logs/clear?role=dhcp');
    expect(res.status).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    const row = db
      .prepare("SELECT actor, details FROM audit_log WHERE action = 'log_cleared'")
      .get();
    expect(row.actor).toBe('tester');
    expect(JSON.parse(row.details)).toEqual({ role: 'dhcp', file: 'backend.log', bytes });
  });

  it('never clears an audit log', async () => {
    const source = backend.logSource();
    backend.logSource = () => ({ ...source, clearable: false });
    const res = await request(app).post('/api/logs/clear?role=dhcp');
    expect(res).toMatchObject({
      status: 409,
      body: { error: 'fake keeps this log as an audit trail' },
    });
    expect(fs.readFileSync(file, 'utf8')).not.toBe('');
  });

  it('is for admins only', async () => {
    role = 'viewer';
    expect((await request(app).post('/api/logs/clear')).status).toBe(403);
  });
});

describe('GET /api/logs/sources', () => {
  it('names the backend of each role, and whether it has a log to show and clear', async () => {
    let res = await request(app).get('/api/logs/sources');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { role: 'dns', label: 'fake', available: true, clearable: true, message: null },
      { role: 'dhcp', label: 'fake', available: true, clearable: true, message: null },
    ]);
    const source = backend.logSource();
    backend.logSource = () => ({ ...source, clearable: false });
    res = await request(app).get('/api/logs/sources');
    expect(res.body.map((s) => s.clearable)).toEqual([false, false]);
    backend.logSource = () => null;
    res = await request(app).get('/api/logs/sources');
    expect(res.body[1]).toEqual({
      role: 'dhcp',
      label: 'fake',
      available: false,
      clearable: false,
      message: 'fake keeps no DHCP log to show',
    });
  });
});
