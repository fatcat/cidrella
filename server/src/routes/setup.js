import { Router } from 'express';
import { effectivePasswordPolicy, validatePolicyPatch } from '../auth/password-policy.js';
import { getDb, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { validateInterfaceConfig } from '../utils/validation.js';
import { getSetupState, setSetupState, upsertSettings } from '../models/setting.js';

// First-run setup state. The wizard itself is a client concern; the server
// only keeps the step markers so an interrupted setup resumes, and hands the
// password policy to the password step.
//
// History: until v0.5.0 this file was a pre-auth endpoint that created the
// first admin account. v0.4.15 closed it the moment any user existed, and the
// server has seeded the admin at first boot ever since, so it could never
// run. It is mounted behind the auth middleware now. The API is never gated
// on setup state: scripted installs and the test harness keep working.

const router = Router();

const ROLES = new Set(['both', 'dns', 'dhcp']);
const IMPORT_KINDS = new Set(['fresh', 'pihole', 'cidrella']);
const TOTP_CHOICES = new Set(['enabled', 'skipped']);

function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  const patch = {};
  if ('password' in body) {
    if (typeof body.password !== 'boolean') return 'password must be a boolean';
    patch.password = body.password;
  }
  if ('deployment' in body) {
    const d = body.deployment;
    if (d === null) {
      patch.deployment = null;
    } else {
      if (!d || typeof d !== 'object' || Array.isArray(d)) return 'deployment must be an object';
      if (!ROLES.has(d.role)) return 'deployment.role must be both, dns or dhcp';
      const ifErr = validateInterfaceConfig(d.interfaces ?? {});
      if (ifErr) return `deployment.interfaces ${ifErr}`;
      patch.deployment = { role: d.role, interfaces: d.interfaces ?? {} };
    }
  }
  if ('import' in body) {
    const i = body.import;
    if (i === null) {
      patch.import = null;
    } else {
      if (!i || typeof i !== 'object' || Array.isArray(i)) return 'import must be an object';
      if (!IMPORT_KINDS.has(i.kind)) return 'import.kind must be fresh, pihole or cidrella';
      patch.import = { kind: i.kind };
    }
  }
  if ('totp' in body) {
    if (body.totp !== null && !TOTP_CHOICES.has(body.totp)) {
      return 'totp must be enabled, skipped or null';
    }
    patch.totp = body.totp;
  }
  if ('done' in body) {
    if (typeof body.done !== 'boolean') return 'done must be a boolean';
    patch.done = body.done;
  }
  // Not a marker: the password rule the password step owns, kept on this
  // endpoint because it is the only write the password-change gate lets
  // through before the password is changed. Partial; only the keys given
  // change.
  let policy;
  if ('password_policy' in body) {
    const result = validatePolicyPatch(body.password_policy);
    if (result.error) return result.error;
    policy = result.patch;
  }
  if (Object.keys(patch).length === 0 && !policy) return 'nothing to update';
  return { patch, policy };
}

function stateResponse(db) {
  return { ...getSetupState(db), password_policy: effectivePasswordPolicy(db) };
}

// GET /api/setup/state: where the first run stands, plus the password rule
// the password step validates against (served, not restated client-side).
router.get('/state', (req, res) => {
  res.json(stateResponse(getDb()));
});

// PUT /api/setup/state: merge step markers. Only the keys given change.
router.put('/state', requirePerm('system:write'), (req, res) => {
  const result = validatePatch(req.body);
  if (typeof result === 'string') return res.status(400).json({ error: result });
  const { patch, policy } = result;
  const db = getDb();
  if (Object.keys(patch).length > 0) setSetupState(db, patch);
  if (policy) upsertSettings(db, Object.entries(policy));
  audit(req.user.id, 'setup_step', 'system', null, {
    ...patch,
    ...(policy ? { password_policy: policy } : {}),
  });
  res.json(stateResponse(db));
});

export default router;
