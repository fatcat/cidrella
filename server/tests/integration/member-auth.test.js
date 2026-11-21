/**
 * Signing in on a member (docs/REDUNDANCY-PLAN.md, section 3): it works with
 * the controller away, and writes nothing to the data of record. The same
 * steps on a controller write what they always have.
 */
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../helpers/test-db.js';
import { makeController, makeMember } from '../helpers/member-mode.js';

const { default: request } = await import('supertest');
const { authMiddleware } = await import('../../src/auth/middleware.js');
const { actorMiddleware } = await import('../../src/utils/request-actor.js');
const { memberWriteGate } = await import('../../src/sync/write-gate.js');
const { default: authRouter } = await import('../../src/auth/routes.js');
const { generateToken: generateApiToken } = await import('../../src/auth/tokens.js');
const { generateTotpSecret, totpCode, totpStep, generateBackupCodes, hashBackupCode } =
  await import('../../src/auth/totp.js');
const { lastTotpStep } = await import('../../src/auth/totp-step.js');
const { replaceBackupCodes } = await import('../../src/models/backup-code.js');

let tmpDir;
let db;
let app;

const PASSWORD = 'Member-auth-2026!';
const ESTATE = ['audit_log', 'users', 'api_tokens', 'user_backup_codes'];

function addUser(username, role = 'admin') {
  return db
    .prepare(
      'INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 0)',
    )
    .run(username, bcrypt.hashSync(PASSWORD, 4), role).lastInsertRowid;
}

// A user with two-factor on and a set of backup codes.
function addTotpUser(username) {
  const id = addUser(username);
  const secret = generateTotpSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(secret, id);
  const codes = generateBackupCodes();
  replaceBackupCodes(db, id, codes.map(hashBackupCode));
  return { id, secret, codes };
}

function addToken(username) {
  const id = db
    .prepare(
      "INSERT INTO users (username, password_hash, role, kind) VALUES (?, 'x', 'readonly', 'service')",
    )
    .run(username).lastInsertRowid;
  const { token, hash, prefix } = generateApiToken();
  db.prepare('INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?)').run(
    id,
    'poller',
    hash,
    prefix,
  );
  return token;
}

// Every row of the estate tables sign-in could touch, as text.
const estate = () =>
  JSON.stringify(ESTATE.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const outbox = () =>
  db
    .prepare('SELECT kind, payload FROM sync_outbox ORDER BY id')
    .all()
    .map((row) => ({ kind: row.kind, ...JSON.parse(row.payload) }));
const auditActions = () =>
  db
    .prepare('SELECT action FROM audit_log ORDER BY id')
    .all()
    .map((row) => row.action);

const post = (path, body) => request(app).post(path).send(body);
const as = (token, req) => req.set('Authorization', `Bearer ${token}`);
const login = (username, password = PASSWORD) => post('/api/auth/login', { username, password });

async function challengeFor(username) {
  const res = await login(username);
  expect(res.body.totp_required).toBe(true);
  return res.body.challenge;
}

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(actorMiddleware);
  app.use(memberWriteGate);
  app.use('/api/auth', authRouter);
  app.get('/api/poll', (_req, res) => res.json({ ok: true }));
});

afterEach(() => {
  makeController(db);
  db.prepare('DELETE FROM sync_outbox').run();
});
afterAll(() => cleanupTestDb(tmpDir));

describe('on a member', () => {
  it('signs in with a password and writes no estate data', async () => {
    const id = addUser('m-admin');
    makeMember(db);
    const before = estate();

    const res = await login('m-admin');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'm-admin', is_admin: true, read_only: true });
    expect(estate()).toBe(before);

    const sid = jwt.decode(res.body.token).sid;
    expect(db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sid)).toEqual({
      user_id: id,
    });
    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'audit',
      action: 'login',
      entityType: 'user',
      entityId: id,
      userId: id,
      actor: 'm-admin',
      origin: 'ui',
      source: null,
      details: { session_id: sid },
    });
    expect(new Date(rows[0].at).toISOString()).toBe(rows[0].at);

    // The session works, and the projection says nothing can be changed here.
    const me = await as(res.body.token, request(app).get('/api/auth/me'));
    expect(me.status).toBe(200);
    expect(me.body.read_only).toBe(true);
    expect(estate()).toBe(before);
  });

  it('drops the write permissions from what the client is told', async () => {
    addUser('m-dns', 'dns_admin');
    makeMember(db);
    const res = await login('m-dns');
    expect(res.body.user.permissions).toEqual([
      'dns:read',
      'subnets:read',
      'system:read',
      'analytics:read',
    ]);
    expect(res.body.user.read_only).toBe(true);
  });

  it('queues a failed sign-in for the controller too', async () => {
    addUser('m-wrong');
    makeMember(db);
    const before = estate();
    expect((await login('m-wrong', 'not-the-password')).status).toBe(401);
    expect((await login('m-nobody', 'whatever')).status).toBe(401);
    expect(estate()).toBe(before);
    expect(outbox().map((row) => [row.action, row.details.reason])).toEqual([
      ['login_failed', 'invalid_password'],
      ['login_failed', 'unknown_user'],
    ]);
  });

  it('signs in with two-factor, and takes a code once', async () => {
    const { id, secret } = addTotpUser('m-totp');
    makeMember(db);
    const before = estate();
    const code = totpCode(secret);

    const first = await post('/api/auth/login/totp', {
      challenge: await challengeFor('m-totp'),
      code,
    });
    expect(first.status).toBe(200);
    expect(first.body.user.read_only).toBe(true);

    const again = await post('/api/auth/login/totp', {
      challenge: await challengeFor('m-totp'),
      code,
    });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('That code did not work');

    // The step is this box's own note; the user row is as the controller sent it.
    expect(estate()).toBe(before);
    expect(db.prepare('SELECT totp_last_step FROM users WHERE id = ?').get(id)).toEqual({
      totp_last_step: null,
    });
    const kept = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(`totp_step:${id}`);
    expect(Math.abs(Number(kept.value) - totpStep())).toBeLessThanOrEqual(1);
    expect(outbox().map((row) => row.action)).toEqual(['login', 'login_failed']);
  });

  it('believes the later of its own step and the one the controller sent', () => {
    const { id } = addTotpUser('m-steps');
    const user = (step) => ({ id, totp_last_step: step });
    expect(lastTotpStep(db, user(40))).toBe(40);
    makeMember(db);
    expect(lastTotpStep(db, user(null))).toBe(null);
    expect(lastTotpStep(db, user(40))).toBe(40);
    db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(`totp_step:${id}`, '50');
    expect(lastTotpStep(db, user(null))).toBe(50);
    expect(lastTotpStep(db, user(40))).toBe(50);
    expect(lastTotpStep(db, user(60))).toBe(60);
    makeController(db);
    expect(lastTotpStep(db, user(40))).toBe(40);
  });

  it('sends a backup code to the controller', async () => {
    const { codes } = addTotpUser('m-backup');
    makeMember(db, { name: 'rack-a' });
    const before = estate();
    const res = await post('/api/auth/login/totp', {
      challenge: await challengeFor('m-backup'),
      code: codes[0],
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Sign in with a backup code on rack-a.',
      code: 'member_read_only',
    });
    expect(res.body.token).toBeUndefined();
    expect(estate()).toBe(before);
    expect(outbox()).toEqual([]);
  });

  it('takes an API token without stamping it', async () => {
    const token = addToken('m-svc');
    makeMember(db);
    const before = estate();
    expect((await as(token, request(app).get('/api/poll'))).status).toBe(200);
    expect(estate()).toBe(before);
    expect(db.prepare('SELECT last_used_at FROM api_tokens').all().at(-1).last_used_at).toBe(null);
  });

  it('signs out, with the rows queued', async () => {
    addUser('m-out');
    makeMember(db);
    const { token } = (await login('m-out')).body;
    const before = estate();
    expect((await as(token, post('/api/auth/logout', {}))).status).toBe(200);
    expect((await as(token, request(app).get('/api/poll'))).status).toBe(401);
    expect(estate()).toBe(before);
    expect(outbox().map((row) => row.action)).toEqual(['login', 'session_ended', 'logout']);
  });

  it('keeps a session alive, and refuses what would change the account', async () => {
    addUser('m-keep');
    makeMember(db);
    const { token } = (await login('m-keep')).body;
    const before = estate();
    expect((await as(token, post('/api/auth/activity', {}))).status).toBe(200);
    for (const [method, path] of [
      ['post', '/api/auth/change-password'],
      ['put', '/api/auth/preferences'],
      ['post', '/api/auth/totp/setup'],
      ['post', '/api/auth/totp/disable'],
    ]) {
      const res = await as(token, request(app)[method](path).send({}));
      expect(res.status, path).toBe(409);
      expect(res.body).toEqual({
        error: 'This is a member of ctl-1. Make changes there.',
        code: 'member_read_only',
      });
    }
    expect(estate()).toBe(before);
  });
});

describe('on a controller', () => {
  it('signs in and records it in the audit log', async () => {
    const id = addUser('c-admin');
    const res = await login('c-admin');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ permissions: ['*'], is_admin: true, read_only: false });
    expect(outbox()).toEqual([]);
    const row = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();
    expect(row).toMatchObject({ action: 'login', user_id: id, actor: 'c-admin' });
  });

  it('keeps the two-factor step on the user row', async () => {
    const { id, secret } = addTotpUser('c-totp');
    const code = totpCode(secret);
    const first = await post('/api/auth/login/totp', {
      challenge: await challengeFor('c-totp'),
      code,
    });
    expect(first.status).toBe(200);
    const { totp_last_step: step } = db
      .prepare('SELECT totp_last_step FROM users WHERE id = ?')
      .get(id);
    expect(Math.abs(step - totpStep())).toBeLessThanOrEqual(1);
    expect(db.prepare('SELECT 1 FROM sync_state WHERE key = ?').get(`totp_step:${id}`)).toBe(
      undefined,
    );
    const again = await post('/api/auth/login/totp', {
      challenge: await challengeFor('c-totp'),
      code,
    });
    expect(again.status).toBe(401);
  });

  it('spends a backup code', async () => {
    const { id, codes } = addTotpUser('c-backup');
    const res = await post('/api/auth/login/totp', {
      challenge: await challengeFor('c-backup'),
      code: codes[0],
    });
    expect(res.status).toBe(200);
    expect(res.body.backup_codes_remaining).toBe(codes.length - 1);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM user_backup_codes WHERE user_id = ? AND used_at IS NOT NULL',
        )
        .get(id).n,
    ).toBe(1);
    expect(auditActions().slice(-2)).toEqual(['login_backup_code', 'login']);
  });

  it('stamps an API token when it is used', async () => {
    const token = addToken('c-svc');
    expect((await as(token, request(app).get('/api/poll'))).status).toBe(200);
    expect(db.prepare('SELECT last_used_at FROM api_tokens').all().at(-1).last_used_at).not.toBe(
      null,
    );
  });

  it('lets an account change through the gate', async () => {
    addUser('c-prefs');
    const { token } = (await login('c-prefs')).body;
    const res = await as(
      token,
      request(app).put('/api/auth/preferences').send({ time_format: '24h' }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ time_format: '24h' });
  });
});
