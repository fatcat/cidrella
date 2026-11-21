import { Router } from 'express';
import { requireRole } from '../auth/roles.js';
import { countMembers } from '../models/sync-instance.js';
import { isMember } from '../sync/mode.js';
import { joinController, JoinError } from '../sync/member.js';
import { effectivePasswordPolicy, validatePolicyPatch } from '../auth/password-policy.js';
import { getDb } from '../db/init.js';
import { recordAudit } from '../services/audit.js';
import { requirePerm } from '../auth/require-perm.js';
import { validateInterfaceConfig } from '../utils/validation.js';
import { getSetupState, setSetupState, upsertSettings } from '../models/setting.js';
import { STACKS } from '../backends/index.js';

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
const GATEWAY_POSITIONS = new Set(['first', 'last']);

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
      if (d.gateway_position !== undefined && !GATEWAY_POSITIONS.has(d.gateway_position)) {
        return 'deployment.gateway_position must be first or last';
      }
      if (d.stack !== undefined && !Object.hasOwn(STACKS, d.stack)) {
        return `deployment.stack must be one of: ${Object.keys(STACKS).join(', ')}`;
      }
      patch.deployment = { role: d.role, interfaces: d.interfaces ?? {} };
      if (d.gateway_position) patch.deployment.gateway_position = d.gateway_position;
      // The server stack is only remembered here; Start switches to it.
      if (d.stack) patch.deployment.stack = d.stack;
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
  recordAudit({
    action: 'setup_step',
    entityType: 'system',
    details: {
      ...patch,
      ...(policy ? { password_policy: policy } : {}),
    },
  });
  res.json(stateResponse(db));
});

// POST /api/setup/join: make this box a member of an existing CIDRella. Only
// while the first run is unfinished: joining replaces everything here with
// the controller's data, sign-in accounts included.
router.post('/join', requireRole('admin'), async (req, res) => {
  const db = getDb();
  if (isMember() || getSetupState(db).done || countMembers(db) > 0) {
    return res.status(400).json({
      error: 'This CIDRella is already set up. Only a new install can join another.',
      code: 'already_set_up',
    });
  }
  const { address, token } = req.body || {};
  const port = req.body?.port === undefined ? 443 : Number(req.body.port);
  if (typeof address !== 'string' || !address.trim() || address.length > 255) {
    return res.status(400).json({ error: 'Enter the controller’s address.', code: 'unreachable' });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'The port must be 1 to 65535.', code: 'unreachable' });
  }
  try {
    const joined = await joinController(db, { address, port, token });
    // This box is a member now, so the row waits for its controller.
    recordAudit({
      action: 'instance_joined_controller',
      entityType: 'instance',
      details: { controller: joined.controller.name, address: address.trim(), port },
    });
    res.json(joined);
  } catch (err) {
    if (!(err instanceof JoinError)) throw err;
    res.status(400).json({ error: err.message, code: err.code });
  }
});

export default router;
