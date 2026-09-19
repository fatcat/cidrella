import { Router } from 'express';
import { passwordPolicyError, effectivePasswordPolicy } from './password-policy.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { getDb, audit } from '../db/init.js';
import * as User from '../models/user.js';
import { permissionProjection, isSuperuser } from './roles.js';
import { isSetupRequired } from '../models/setting.js';
import * as BackupCode from '../models/backup-code.js';
import {
  generateTotpSecret,
  verifyTotp,
  otpauthUrl,
  generateBackupCodes,
  hashBackupCode,
  looksLikeBackupCode,
} from './totp.js';

const router = Router();

// First-run setup is an admin's job. A non-admin signing in to a half-set-up
// appliance gets the normal flow; the wizard never asks them for anything.
function setupRequiredFor(db, user) {
  return isSuperuser(user.role) && isSetupRequired(db);
}

// v0.4.15: `skipSuccessfulRequests: true` so a legitimate login after a few
// mistakes doesn't count against the lockout, closing the "1 bad IP DoSes
// the admin" vector the auth-security-tester flagged in v0.4.14. Burst raised
// from 10 → 20 for the same reason. Per-username counters were considered
// and rejected, they let an attacker lock the admin out by spraying bad
// passwords at the username, which is a worse foot-gun than the per-IP bound.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// New in v0.4.15: `/change-password` was unlimited in v0.4.14, letting a
// stolen-token holder brute-force the current password and pivot to a
// persistent takeover.
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many password change attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Dummy bcrypt hash used when the username is unknown so the response-time
// shape matches the valid-user path (defeats ~80ms-vs-~10ms user enumeration).
// Cost 10 matches the live password hash cost.
const DUMMY_HASH = bcrypt.hashSync('__cidrella_dummy__' + Math.random().toString(36), 10);

function getJwtSecret() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
  return row.value;
}

function generateToken(user) {
  const secret = getJwtSecret();
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      must_change_password: !!user.must_change_password,
    },
    secret,
    { expiresIn: '24h' },
  );
}

// POST /api/auth/login
// The token plus the user projection every successful sign-in answers with.
function sessionPayload(db, user) {
  const token = generateToken(user);
  audit(user.id, 'login', 'user', user.id, null);

  let preferences = {};
  try {
    preferences = JSON.parse(user.preferences || '{}');
  } catch {
    /* ignore */
  }

  const payload = {
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      ...permissionProjection(user.role),
      must_change_password: !!user.must_change_password,
      setup_required: setupRequiredFor(db, user),
      totp_enabled: !!user.totp_enabled,
      preferences,
    },
  };
  if (user.password_reset_by) {
    payload.user.password_reset_by = user.password_reset_by;
  }
  return payload;
}

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const { username, password } = body;

    // Strict type check BEFORE any bcrypt or SQL call. Non-string values
    // crashed the Node process in v0.4.14 via the unhandled bcrypt type
    // error, this guard is the primary fix for the unauthenticated DoS.
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password must be strings' });
    }
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (username.length > 255 || password.length > 1024) {
      return res.status(400).json({ error: 'Username or password too long' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    // Always run bcrypt, even on unknown users, so response timing doesn't
    // leak whether the username exists.
    const hash = user ? user.password_hash : DUMMY_HASH;
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      if (user) {
        audit(user.id, 'login_failed', 'user', user.id, { reason: 'invalid_password' });
      } else {
        // Audit unknown-user attempts so an operator watching the log can see
        // enumeration probes. Truncate the submitted username to avoid giant
        // entries from adversarial input.
        audit(null, 'login_failed', 'user', null, {
          reason: 'unknown_user',
          attempted_username: username.slice(0, 64),
        });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // A service account has no usable password and must never obtain a login
    // JWT. Its password_hash is a discarded random value, so bcrypt above can
    // never match anyway, but refusing by kind means the rule is stated rather
    // than relied upon as a side effect.
    if (user.kind === 'service') {
      audit(user.id, 'login_failed', 'user', user.id, { reason: 'service_account' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Two-factor: the password alone earns a short-lived challenge, not a
    // session. The code (or a backup code) turns it into one at /login/totp.
    if (user.totp_enabled) {
      const challenge = jwt.sign({ id: user.id, purpose: 'totp' }, getJwtSecret(), {
        expiresIn: '5m',
      });
      return res.json({ totp_required: true, challenge });
    }

    res.json(sessionPayload(db, user));
  } catch (err) {
    console.error('Login error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login/totp: second stage of a two-factor sign-in. Takes the
// challenge from /login and a six-digit code, or a backup code, which is
// spent on use. Same limiter as /login: a challenge is a foothold, not a pass.
router.post('/login/totp', loginLimiter, (req, res) => {
  try {
    const body = req.body || {};
    const { challenge, code } = body;
    if (typeof challenge !== 'string' || typeof code !== 'string' || !challenge || !code) {
      return res.status(400).json({ error: 'Challenge and code are required' });
    }
    let decoded;
    try {
      decoded = jwt.verify(challenge, getJwtSecret(), { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'Sign in again' });
    }
    if (decoded.purpose !== 'totp') {
      return res.status(401).json({ error: 'Sign in again' });
    }
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      return res.status(401).json({ error: 'Sign in again' });
    }

    if (looksLikeBackupCode(code)) {
      if (BackupCode.consumeBackupCode(db, user.id, hashBackupCode(code))) {
        const remaining = BackupCode.countUnusedBackupCodes(db, user.id);
        audit(user.id, 'login_backup_code', 'user', user.id, { remaining });
        return res.json({ ...sessionPayload(db, user), backup_codes_remaining: remaining });
      }
    } else {
      const step = verifyTotp(user.totp_secret, code, { afterStep: user.totp_last_step });
      if (step != null) {
        User.recordTotpStep(db, user.id, step);
        return res.json(sessionPayload(db, user));
      }
    }
    audit(user.id, 'login_failed', 'user', user.id, { reason: 'totp' });
    return res.status(401).json({ error: 'That code did not work' });
  } catch (err) {
    console.error('TOTP login error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/totp/setup: start enrolling an authenticator. The secret is
// stored but counts for nothing until /totp/enable proves a code from it.
router.post('/totp/setup', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.totp_enabled) {
    return res.status(409).json({ error: 'Two-factor is already on. Turn it off to enrol again.' });
  }
  const secret = generateTotpSecret();
  User.setPendingTotpSecret(db, user.id, secret);
  res.json({ secret, otpauth_url: otpauthUrl({ secret, account: user.username }) });
});

// POST /api/auth/totp/enable: prove the authenticator works, turn two-factor
// on, and hand over the backup codes. They are shown exactly once.
router.post('/totp/enable', changePasswordLimiter, (req, res) => {
  const code = req.body?.code;
  if (typeof code !== 'string' || !code) {
    return res.status(400).json({ error: 'Code is required' });
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.totp_enabled) {
    return res.status(409).json({ error: 'Two-factor is already on.' });
  }
  if (!user.totp_secret) {
    return res.status(409).json({ error: 'Start enrolment first.' });
  }
  const step = verifyTotp(user.totp_secret, code);
  if (step == null) {
    return res.status(400).json({
      error: 'That code did not match. Check the time on your phone and try the next one.',
    });
  }
  const codes = generateBackupCodes();
  db.transaction(() => {
    User.enableTotp(db, user.id, step);
    BackupCode.replaceBackupCodes(db, user.id, codes.map(hashBackupCode));
  })();
  audit(user.id, 'totp_enabled', 'user', user.id, { backup_codes: codes.length });
  res.json({ ok: true, backup_codes: codes });
});

// POST /api/auth/totp/backup-codes: a fresh set, replacing every old one.
// Needs the password for the same reason disable does.
router.post('/totp/backup-codes', changePasswordLimiter, async (req, res) => {
  try {
    const password = req.body?.password;
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Password is required' });
    }
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.totp_enabled) return res.status(409).json({ error: 'Two-factor is off.' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Password is incorrect' });
    const codes = generateBackupCodes();
    BackupCode.replaceBackupCodes(db, user.id, codes.map(hashBackupCode));
    audit(user.id, 'backup_codes_regenerated', 'user', user.id, { backup_codes: codes.length });
    res.json({ ok: true, backup_codes: codes });
  } catch (err) {
    console.error('Backup codes error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/totp: the caller's own two-factor status.
router.get('/totp', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    enabled: !!user.totp_enabled,
    backup_codes_remaining: user.totp_enabled
      ? BackupCode.countUnusedBackupCodes(db, req.user.id)
      : 0,
  });
});

// POST /api/auth/totp/disable: needs the password, so a stolen session cannot
// quietly strip the second factor.
router.post('/totp/disable', changePasswordLimiter, async (req, res) => {
  try {
    const password = req.body?.password;
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Password is required' });
    }
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      audit(user.id, 'totp_disable_failed', 'user', user.id, { reason: 'invalid_password' });
      return res.status(401).json({ error: 'Password is incorrect' });
    }
    db.transaction(() => {
      User.disableTotp(db, user.id);
      BackupCode.deleteBackupCodes(db, user.id);
    })();
    audit(user.id, 'totp_disabled', 'user', user.id, null);
    res.json({ ok: true });
  } catch (err) {
    console.error('TOTP disable error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', changePasswordLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const { current_password, new_password } = body;

    if (typeof current_password !== 'string' || typeof new_password !== 'string') {
      return res.status(400).json({ error: 'Current and new passwords must be strings' });
    }
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    // Same policy the first-run wizard enforces. These two used to disagree:
    // setup demanded uppercase + lowercase + digit and this route demanded only
    // a length, so the policy could be escaped by changing the password
    // immediately after install (duplicate-logic audit #39).
    const db = getDb();
    {
      const pwErr = passwordPolicyError(new_password, effectivePasswordPolicy(db));
      if (pwErr) return res.status(400).json({ error: pwErr });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    const updatedUser = User.changePassword(db, user.id, hash);

    audit(user.id, 'password_changed', 'user', user.id, null);

    const token = generateToken(updatedUser);

    res.json({
      message: 'Password changed successfully',
      token,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        role: updatedUser.role,
        ...permissionProjection(updatedUser.role),
        must_change_password: false,
        setup_required: setupRequiredFor(db, updatedUser),
        totp_enabled: !!updatedUser.totp_enabled,
      },
    });
  } catch (err) {
    console.error('Change-password error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout: invalidate the caller's token by bumping
// users.updated_at PAST the token's iat. The auth middleware refuses
// tokens with `iat < updated_at`; because SQLite datetime() is 1-second
// granular, a login followed by an immediate logout in the same wall-
// clock second would leave `iat == updated_at` and the token would
// still verify. Bumping updated_at by 1 second closes the race.
// A proper blacklist would need persistent state; this approach is
// equivalent for a single-admin tool and doesn't grow unbounded.
router.post('/logout', (req, res) => {
  try {
    const db = getDb();
    User.bumpTokenVersion(db, req.user.id);
    audit(req.user.id, 'logout', 'user', req.user.id, null);
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  const db = getDb();
  const user = db
    .prepare(
      'SELECT id, username, role, must_change_password, totp_enabled, preferences, password_reset_by, created_at FROM users WHERE id = ?',
    )
    .get(req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  let preferences = {};
  try {
    preferences = JSON.parse(user.preferences || '{}');
  } catch {
    /* ignore */
  }

  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    ...permissionProjection(user.role),
    must_change_password: !!user.must_change_password,
    setup_required: setupRequiredFor(db, user),
    totp_enabled: !!user.totp_enabled,
    preferences,
    created_at: user.created_at,
  };
  if (user.password_reset_by) {
    payload.password_reset_by = user.password_reset_by;
  }
  res.json(payload);
});

// PUT /api/auth/preferences: update current user's preferences
router.put('/preferences', (req, res) => {
  const ALLOWED_KEYS = ['time_format'];
  const VALID_TIME_FORMATS = ['locale', 'ampm', '24h'];

  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Request body must be an object' });
  }

  for (const key of Object.keys(updates)) {
    if (!ALLOWED_KEYS.includes(key)) {
      return res.status(400).json({ error: `Unknown preference: ${key}` });
    }
  }

  if (updates.time_format && !VALID_TIME_FORMATS.includes(updates.time_format)) {
    return res
      .status(400)
      .json({ error: `time_format must be one of: ${VALID_TIME_FORMATS.join(', ')}` });
  }

  const db = getDb();
  const user = db.prepare('SELECT preferences FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let prefs = {};
  try {
    prefs = JSON.parse(user.preferences || '{}');
  } catch {
    /* ignore */
  }

  Object.assign(prefs, updates);

  User.updatePreferences(db, req.user.id, prefs);

  res.json(prefs);
});

export default router;
