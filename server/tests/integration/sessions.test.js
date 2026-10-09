/**
 * Sign-in sessions through the real auth middleware: inactivity, the 24 hour
 * limit, and every way an account change or a sign-out ends a session.
 */
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../helpers/test-db.js';

const { default: request } = await import('supertest');
const { authMiddleware } = await import('../../src/auth/middleware.js');
const { default: authRouter } = await import('../../src/auth/routes.js');
const { default: usersRouter } = await import('../../src/routes/users.js');
const { default: settingsRouter } = await import('../../src/routes/settings.js');
const { generateToken: generateApiToken } = await import('../../src/auth/tokens.js');

let tmpDir;
let db;
let app;

const MINUTE = 60 * 1000;
const PASSWORD = 'Sessions-test-2026!';

function setIdle(minutes) {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('session_idle_timeout_minutes', ?)",
  ).run(String(minutes));
}

function addUser(username, role = 'admin') {
  return db
    .prepare('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 0)')
    .run(username, bcrypt.hashSync(PASSWORD, 4), role).lastInsertRowid;
}

async function login(username) {
  const res = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body;
}

const as = (token, req) => req.set('Authorization', `Bearer ${token}`);
const sidOf = (token) => jwt.decode(token).sid;
const row = (sid) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/settings', settingsRouter);
  app.get('/api/poll', (_req, res) => res.json({ ok: true }));
});

afterAll(() => cleanupTestDb(tmpDir));

let now;
beforeEach(() => {
  // Whole seconds: stored times are, so deadlines come out exact.
  now = Math.floor(Date.now() / 1000) * 1000;
  vi.useFakeTimers({ toFake: ['Date'], now });
  setIdle(60);
});
afterEach(() => vi.useRealTimers());

const advance = (ms) => {
  now += ms;
  vi.setSystemTime(now);
};

describe('sign-in', () => {
  it('creates a session, names it in the token and returns its deadlines', async () => {
    addUser('s-login');
    const body = await login('s-login');
    const session = row(sidOf(body.token));
    expect(session).toMatchObject({ username: 's-login', ended_at: null });
    expect(session.ip).toBe('127.0.0.1');
    expect(body.session).toEqual({
      idle_timeout_seconds: 3600,
      idle_remaining_seconds: 3600,
      expires_in_seconds: 86400,
    });
    const audit = db
      .prepare("SELECT details FROM audit_log WHERE action = 'login' ORDER BY id DESC")
      .get();
    expect(JSON.parse(audit.details).session_id).toBe(session.id);
  });
});

describe('inactivity', () => {
  it('signs out an idle session, and polling does not keep it alive', async () => {
    setIdle(15);
    addUser('s-idle');
    const { token } = await login('s-idle');
    advance(10 * MINUTE);
    expect((await as(token, request(app).get('/api/poll'))).status).toBe(200);
    advance(5 * MINUTE);
    const res = await as(token, request(app).get('/api/poll'));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_ENDED', reason: 'idle' });
    expect(row(sidOf(token)).end_reason).toBe('idle');
  });

  it('keeps a session alive while activity is reported', async () => {
    setIdle(15);
    addUser('s-active');
    const { token } = await login('s-active');
    for (let i = 0; i < 4; i += 1) {
      advance(10 * MINUTE);
      const touched = await as(token, request(app).post('/api/auth/activity'));
      expect(touched.status).toBe(200);
      expect(touched.body.idle_remaining_seconds).toBe(15 * 60);
    }
    expect((await as(token, request(app).get('/api/poll'))).status).toBe(200);
  });

  it('reads the deadlines without moving them', async () => {
    setIdle(30);
    addUser('s-read');
    const { token } = await login('s-read');
    advance(10 * MINUTE);
    const res = await as(token, request(app).get('/api/auth/session'));
    expect(res.body.idle_remaining_seconds).toBe(20 * 60);
  });

  it('applies a changed setting to live sessions', async () => {
    addUser('s-change');
    const { token } = await login('s-change');
    advance(20 * MINUTE);
    setIdle(15);
    const res = await as(token, request(app).get('/api/poll'));
    expect(res.body.reason).toBe('idle');
  });
});

describe('the 24 hour limit', () => {
  it('ends the session at 24 hours with no inactivity limit', async () => {
    setIdle(0);
    addUser('s-day');
    const { token } = await login('s-day');
    advance(23 * 60 * MINUTE);
    expect((await as(token, request(app).get('/api/poll'))).status).toBe(200);
    advance(60 * MINUTE);
    const res = await as(token, request(app).get('/api/poll'));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_ENDED', reason: 'expired' });
  });
});

describe('ending sessions', () => {
  it("signing out ends only this browser's session", async () => {
    addUser('s-logout');
    const a = (await login('s-logout')).token;
    const b = (await login('s-logout')).token;
    expect((await as(a, request(app).post('/api/auth/logout'))).status).toBe(200);
    expect(row(sidOf(a)).end_reason).toBe('logout');
    const after = await as(a, request(app).get('/api/poll'));
    expect(after.body).toMatchObject({ code: 'SESSION_ENDED', reason: 'logout' });
    expect((await as(b, request(app).get('/api/poll'))).status).toBe(200);
  });

  it('a password change keeps this session and ends the others', async () => {
    addUser('s-pw');
    const a = (await login('s-pw')).token;
    const b = (await login('s-pw')).token;
    const res = await as(a, request(app).post('/api/auth/change-password')).send({
      current_password: PASSWORD,
      new_password: 'Changed-pass-2026!',
    });
    expect(res.status).toBe(200);
    expect(sidOf(res.body.token)).toBe(sidOf(a));
    expect((await as(res.body.token, request(app).get('/api/poll'))).status).toBe(200);
    expect((await as(b, request(app).get('/api/poll'))).body.reason).toBe('password_changed');
  });

  it.each([
    [
      'an admin password reset',
      'password_reset',
      (id) => request(app).post(`/api/users/${id}/reset-password`),
    ],
    [
      'a role change',
      'role_changed',
      (id) => request(app).put(`/api/users/${id}`).send({ role: 'readonly' }),
    ],
  ])('%s ends every session of that user', async (_label, reason, act) => {
    addUser(`admin-${reason}`);
    const admin = (await login(`admin-${reason}`)).token;
    const id = addUser(`target-${reason}`);
    const target = (await login(`target-${reason}`)).token;
    expect((await as(admin, act(id))).status).toBe(200);
    expect((await as(target, request(app).get('/api/poll'))).body.reason).toBe(reason);
    expect((await as(admin, request(app).get('/api/poll'))).status).toBe(200);
  });

  it('deleting a user ends their sessions and keeps the record', async () => {
    addUser('admin-del');
    const admin = (await login('admin-del')).token;
    const id = addUser('target-del');
    const target = (await login('target-del')).token;
    expect((await as(admin, request(app).delete(`/api/users/${id}`))).status).toBe(200);
    expect(row(sidOf(target))).toMatchObject({
      user_id: null,
      username: 'target-del',
      end_reason: 'user_deleted',
    });
    expect((await as(target, request(app).get('/api/poll'))).status).toBe(401);
  });

  it('records every end in the audit log', async () => {
    addUser('s-audit');
    const { token } = await login('s-audit');
    await as(token, request(app).post('/api/auth/logout'));
    const audit = db
      .prepare("SELECT details FROM audit_log WHERE action = 'session_ended' ORDER BY id DESC")
      .get();
    expect(JSON.parse(audit.details)).toMatchObject({ session_id: sidOf(token), reason: 'logout' });
  });
});

describe('tokens', () => {
  it('saving preferences no longer signs the user out', async () => {
    addUser('s-prefs');
    const { token } = await login('s-prefs');
    advance(2000);
    const saved = await as(token, request(app).put('/api/auth/preferences')).send({
      time_format: '24h',
    });
    expect(saved.status).toBe(200);
    expect((await as(token, request(app).get('/api/poll'))).status).toBe(200);
  });

  it('refuses a token from before sessions existed', async () => {
    const id = addUser('s-legacy');
    const secret = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get().value;
    const legacy = jwt.sign({ id, username: 's-legacy', role: 'admin' }, secret, {
      expiresIn: '24h',
    });
    const res = await as(legacy, request(app).get('/api/poll'));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_ENDED');
  });

  it('never idles out a service account token', async () => {
    setIdle(15);
    const id = db
      .prepare(
        "INSERT INTO users (username, password_hash, role, kind) VALUES ('s-svc', 'x', 'readonly', 'service')",
      )
      .run().lastInsertRowid;
    const { token, hash, prefix } = generateApiToken();
    db.prepare('INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?)').run(
      id,
      'poller',
      hash,
      prefix,
    );
    advance(120 * MINUTE);
    expect((await as(token, request(app).get('/api/poll'))).status).toBe(200);
  });
});

describe('admin list and setting', () => {
  it('lists live sessions for an admin only', async () => {
    addUser('s-list-admin');
    addUser('s-list-ro', 'readonly');
    const admin = (await login('s-list-admin')).token;
    const ro = (await login('s-list-ro')).token;
    const res = await as(admin, request(app).get('/api/auth/sessions?live=1'));
    expect(res.status).toBe(200);
    expect(res.body.map((s) => s.id)).toContain(sidOf(admin));
    expect(res.body.every((s) => s.ended_at === null)).toBe(true);
    expect((await as(ro, request(app).get('/api/auth/sessions'))).status).toBe(403);
  });

  it('accepts 0, 15, 30 and 60 minutes and nothing else', async () => {
    addUser('s-setting');
    const admin = (await login('s-setting')).token;
    for (const value of ['0', '15', '30', '60']) {
      const res = await as(
        admin,
        request(app).put('/api/settings/session_idle_timeout_minutes'),
      ).send({ value });
      expect(res.status).toBe(200);
    }
    for (const value of ['5', '-1', '15.5', 'never']) {
      const res = await as(
        admin,
        request(app).put('/api/settings/session_idle_timeout_minutes'),
      ).send({ value });
      expect(res.status).toBe(400);
    }
  });
});
