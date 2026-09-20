/**
 * The password policy, in one place.
 *
 * It used to exist three times and the three disagreed (duplicate-logic audit
 * #39). One module means the enforcing route cannot drift from what the
 * first-run wizard and Settings show, and the description is served to the
 * client rather than restated there.
 *
 * Four operator-set parts, each its own setting so they can be changed one at
 * a time: a minimum length (0 means none), mixed case, a number, a symbol.
 * The maximum length is fixed: bcrypt only reads 72 bytes, and 1024 leaves a
 * passphrase plenty of room while bounding the hash work per request.
 */

export const PASSWORD_MAX_LENGTH = 1024;

export const PASSWORD_POLICY_SETTINGS = Object.freeze({
  minLength: 'password_min_length',
  requireMixedCase: 'password_require_mixed_case',
  requireNumber: 'password_require_number',
  requireSymbol: 'password_require_symbol',
});

export function describePolicy(p) {
  const parts = [];
  if (p.minLength > 0) parts.push(`at least ${p.minLength} characters`);
  const needs = [];
  if (p.requireMixedCase) needs.push('upper and lower case letters');
  if (p.requireNumber) needs.push('a number');
  if (p.requireSymbol) needs.push('a symbol');
  if (needs.length) parts.push(`including ${needs.join(', ')}`);
  if (!parts.length) return 'Any password up to 1024 characters.';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

function build(fields) {
  const p = { maxLength: PASSWORD_MAX_LENGTH, ...fields };
  return Object.freeze({ ...p, description: describePolicy(p) });
}

/** What a fresh appliance starts with; the setting defaults mirror it. */
export const PASSWORD_POLICY = build({
  minLength: 8,
  requireMixedCase: true,
  requireNumber: true,
  requireSymbol: false,
});

/**
 * Validate a password. Returns an operator-facing error string, or null when it
 * passes. Returning the message rather than a boolean keeps the wording in one
 * place too.
 */
export function passwordPolicyError(password, policy = PASSWORD_POLICY) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required';
  }
  if (password.length > policy.maxLength) {
    return `Password must be at most ${policy.maxLength} characters`;
  }
  if (policy.minLength > 0 && password.length < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters`;
  }
  if (policy.requireMixedCase && !(/[A-Z]/.test(password) && /[a-z]/.test(password))) {
    return 'Password must contain upper and lower case letters';
  }
  if (policy.requireNumber && !/\d/.test(password)) {
    return 'Password must contain a number';
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    return 'Password must contain a symbol';
  }
  return null;
}

function readBool(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row?.value === 'true') return true;
  if (row?.value === 'false') return false;
  return fallback;
}

function readInt(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const n = Number.parseInt(row?.value, 10);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, PASSWORD_MAX_LENGTH) : fallback;
}

/** The policy this appliance enforces right now, for the route and the client. */
export function effectivePasswordPolicy(db) {
  return build({
    minLength: readInt(db, PASSWORD_POLICY_SETTINGS.minLength, PASSWORD_POLICY.minLength),
    requireMixedCase: readBool(
      db,
      PASSWORD_POLICY_SETTINGS.requireMixedCase,
      PASSWORD_POLICY.requireMixedCase,
    ),
    requireNumber: readBool(
      db,
      PASSWORD_POLICY_SETTINGS.requireNumber,
      PASSWORD_POLICY.requireNumber,
    ),
    requireSymbol: readBool(
      db,
      PASSWORD_POLICY_SETTINGS.requireSymbol,
      PASSWORD_POLICY.requireSymbol,
    ),
  });
}

/**
 * Validate a partial policy from a client. Returns { patch } with only the
 * keys given, in setting form, or { error }.
 */
export function validatePolicyPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'password_policy must be an object' };
  }
  const patch = {};
  if ('minLength' in body) {
    const n = body.minLength;
    if (!Number.isInteger(n) || n < 0 || n > PASSWORD_MAX_LENGTH) {
      return { error: `password_policy.minLength must be an integer 0-${PASSWORD_MAX_LENGTH}` };
    }
    patch[PASSWORD_POLICY_SETTINGS.minLength] = String(n);
  }
  for (const key of ['requireMixedCase', 'requireNumber', 'requireSymbol']) {
    if (key in body) {
      if (typeof body[key] !== 'boolean')
        return { error: `password_policy.${key} must be a boolean` };
      patch[PASSWORD_POLICY_SETTINGS[key]] = body[key] ? 'true' : 'false';
    }
  }
  if (Object.keys(patch).length === 0) return { error: 'password_policy has nothing to update' };
  return { patch };
}
