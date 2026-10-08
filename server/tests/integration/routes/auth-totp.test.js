/**
 * Two-factor sign-in end to end: enrolment (setup, prove a code, receive the
 * backup codes once), the two-stage login (password earns a challenge, the
 * code or a backup code earns the session), replay and single-use rules,
 * and disabling with the password.
 */
import express from 'express';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';

const { default: request } = await import('supertest');
const { authMiddleware } = await import('../../../src/auth/middleware.js');
const { default: authRouter } = await import('../../../src/auth/routes.js');
const { default: usersRouter } = await import('../../../src/routes/users.js');
const { totpCode, totpStep } = await import('../../../src/auth/totp.js');

let tmpDir;
let db;
let app;
let token;
let secret;
let backupCodes;

const PASSWORD = 'TotpUser123';

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  db.prepare(
    "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 0)",
  ).run('totp-admin', bcrypt.hashSync(PASSWORD, 10));

  app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);

  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'totp-admin', password: PASSWORD });
  expect(login.status).toBe(200);
  expect(login.body.totp_required).toBeUndefined();
  expect(login.body.user.totp_enabled).toBe(false);
  token = login.body.token;
});

afterAll(() => cleanupTestDb(tmpDir));

const as = (req) => req.set('Authorization', `Bearer ${token}`);
const currentCode = () => totpCode(secret);
const bumpStepBack = () =>
  db
    .prepare('UPDATE users SET totp_last_step = ? WHERE username = ?')
    .run(totpStep() - 5, 'totp-admin');

describe('enrolment', () => {
  it('refuses to enable before setup', async () => {
    const res = await as(request(app).post('/api/auth/totp/enable')).send({ code: '000000' });
    expect(res.status).toBe(409);
  });

  it('setup hands over a secret and an otpauth URL, enabled stays off', async () => {
    const res = await as(request(app).post('/api/auth/totp/setup'));
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.otpauth_url).toContain('otpauth://totp/CIDRella%3Atotp-admin');
    secret = res.body.secret;
    const me = await as(request(app).get('/api/auth/me'));
    expect(me.body.totp_enabled).toBe(false);
  });

  it('a wrong code does not enable', async () => {
    const res = await as(request(app).post('/api/auth/totp/enable')).send({ code: '000000' });
    expect(res.status).toBe(400);
    expect(
      db.prepare("SELECT totp_enabled FROM users WHERE username = 'totp-admin'").get().totp_enabled,
    ).toBe(0);
  });

  it('the right code enables and returns ten backup codes, once', async () => {
    const res = await as(request(app).post('/api/auth/totp/enable')).send({ code: currentCode() });
    expect(res.status).toBe(200);
    expect(res.body.backup_codes).toHaveLength(10);
    backupCodes = res.body.backup_codes;
    const me = await as(request(app).get('/api/auth/me'));
    expect(me.body.totp_enabled).toBe(true);
    const again = await as(request(app).post('/api/auth/totp/enable')).send({
      code: currentCode(),
    });
    expect(again.status).toBe(409);
    const setupAgain = await as(request(app).post('/api/auth/totp/setup'));
    expect(setupAgain.status).toBe(409);
    const stored = db.prepare('SELECT code_hash FROM user_backup_codes').all();
    expect(stored).toHaveLength(10);
    expect(stored.map((r) => r.code_hash)).not.toContain(backupCodes[0]);
    const audit = db.prepare("SELECT details FROM audit_log WHERE action = 'totp_enabled'").get();
    expect(JSON.parse(audit.details)).toEqual({ backup_codes: 10 });
  });

  it('the users list shows who has two-factor on', async () => {
    const res = await as(request(app).get('/api/users'));
    expect(res.body.find((u) => u.username === 'totp-admin').totp_enabled).toBe(1);
  });
});

describe('two-stage sign-in', () => {
  let challenge;

  it('the password alone earns a challenge, not a session', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'totp-admin', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totp_required: true, challenge: expect.any(String) });
    challenge = res.body.challenge;
    // The challenge is not a session token.
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${challenge}`);
    expect(me.status).toBe(401);
  });

  it('a wrong code is refused and audited', async () => {
    const res = await request(app).post('/api/auth/login/totp').send({ challenge, code: '000000' });
    expect(res.status).toBe(401);
    const row = db
      .prepare(
        "SELECT details FROM audit_log WHERE action = 'login_failed' ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(JSON.parse(row.details)).toEqual({ reason: 'totp' });
  });

  it('a garbage or wrong-purpose challenge is refused', async () => {
    const res = await request(app)
      .post('/api/auth/login/totp')
      .send({ challenge: token, code: currentCode() });
    expect(res.status).toBe(401);
    const bad = await request(app)
      .post('/api/auth/login/totp')
      .send({ challenge: 'nope', code: '123456' });
    expect(bad.status).toBe(401);
  });

  it('the current code earns a session, and cannot be replayed', async () => {
    bumpStepBack();
    const code = currentCode();
    const res = await request(app).post('/api/auth/login/totp').send({ challenge, code });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toMatchObject({ username: 'totp-admin', totp_enabled: true });
    const replay = await request(app).post('/api/auth/login/totp').send({ challenge, code });
    expect(replay.status).toBe(401);
  });

  it('a backup code earns a session once, and reports how many are left', async () => {
    const first = await request(app)
      .post('/api/auth/login/totp')
      .send({ challenge, code: backupCodes[3].toUpperCase() });
    expect(first.status).toBe(200);
    expect(first.body.backup_codes_remaining).toBe(9);
    const spent = await request(app)
      .post('/api/auth/login/totp')
      .send({ challenge, code: backupCodes[3] });
    expect(spent.status).toBe(401);
    const row = db
      .prepare("SELECT details FROM audit_log WHERE action = 'login_backup_code'")
      .get();
    expect(JSON.parse(row.details)).toEqual({ remaining: 9 });
  });
});

describe('status and fresh backup codes', () => {
  it('reports the remaining count', async () => {
    const res = await as(request(app).get('/api/auth/totp'));
    expect(res.body).toEqual({ enabled: true, backup_codes_remaining: 9 });
  });

  it('regenerates a full set with the password, invalidating the old ones', async () => {
    const wrong = await as(request(app).post('/api/auth/totp/backup-codes')).send({
      password: 'nope',
    });
    expect(wrong.status).toBe(401);
    const res = await as(request(app).post('/api/auth/totp/backup-codes')).send({
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.body.backup_codes).toHaveLength(10);
    expect(res.body.backup_codes).not.toContain(backupCodes[0]);
    const status = await as(request(app).get('/api/auth/totp'));
    expect(status.body.backup_codes_remaining).toBe(10);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'totp-admin', password: PASSWORD });
    const old = await request(app)
      .post('/api/auth/login/totp')
      .send({ challenge: login.body.challenge, code: backupCodes[5] });
    expect(old.status).toBe(401);
    const fresh = await request(app)
      .post('/api/auth/login/totp')
      .send({ challenge: login.body.challenge, code: res.body.backup_codes[0] });
    expect(fresh.status).toBe(200);
  });
});

describe('disable', () => {
  it('needs the password', async () => {
    const wrong = await as(request(app).post('/api/auth/totp/disable')).send({ password: 'nope' });
    expect(wrong.status).toBe(401);
    const res = await as(request(app).post('/api/auth/totp/disable')).send({ password: PASSWORD });
    expect(res.status).toBe(200);
    const me = await as(request(app).get('/api/auth/me'));
    expect(me.body.totp_enabled).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS c FROM user_backup_codes').get().c).toBe(0);
    const codes = await as(request(app).post('/api/auth/totp/backup-codes')).send({
      password: PASSWORD,
    });
    expect(codes.status).toBe(409);
    const status = await as(request(app).get('/api/auth/totp'));
    expect(status.body).toEqual({ enabled: false, backup_codes_remaining: 0 });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'totp-admin', password: PASSWORD });
    expect(login.body.token).toBeTruthy();
  });
});
