import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { passwordPolicyError, PASSWORD_POLICY } from '../../../src/auth/password-policy.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');

/**
 * Duplicate-logic audit #39.
 *
 * The policy existed three times and the three disagreed. routes/setup.js
 * required uppercase + lowercase + digit, auth/routes.js change-password
 * required only a length, and SetupWizard.vue required only a length. So the
 * first-run wizard forced a complex admin password and change-password accepted
 * 'aaaaaaaa' seconds later. That is a policy escape, not a UX wrinkle, which is
 * why this has behavioural tests and not just a dedup note.
 */
describe('#39: the shared policy', () => {
  it('accepts a compliant password', () => {
    expect(passwordPolicyError('Passw0rdX')).toBeNull();
    expect(passwordPolicyError('A1' + 'b'.repeat(6))).toBeNull();
  });

  it('rejects too short and too long', () => {
    expect(passwordPolicyError('Ab1cdef')).toMatch(/8-1024/);
    expect(passwordPolicyError('A1' + 'b'.repeat(1023))).toMatch(/8-1024/);
  });

  it('rejects a long-but-simple password, which is what change-password used to allow', () => {
    expect(passwordPolicyError('aaaaaaaa')).toMatch(/uppercase/);
    expect(passwordPolicyError('AAAAAAAA')).toMatch(/uppercase/);
    expect(passwordPolicyError('Aaaaaaaa')).toMatch(/uppercase/);
    expect(passwordPolicyError('12345678')).toMatch(/uppercase/);
  });

  it('rejects empty and non-string input', () => {
    for (const v of ['', null, undefined, 12345678, {}]) {
      expect(passwordPolicyError(v), String(v)).toBeTruthy();
    }
  });
});

describe('#39: the enforcing route goes through the one module', () => {
  // A source-level guard. The behavioural half is covered by the integration
  // suite; this catches someone re-adding an inline rule next to the call.
  // routes/setup.js used to be the second enforcing route (the pre-auth
  // account wizard); since v0.5.0 it only SERVES the policy to the first-run
  // wizard and creates no account, so change-password is the one place left.
  const FILES = ['auth/routes.js'];

  it('routes/setup.js serves the policy and enforces nothing itself', () => {
    const src = fs.readFileSync(path.join(SRC, 'routes/setup.js'), 'utf8');
    expect(src).toMatch(/effectivePasswordPolicy/);
    expect(src).not.toMatch(/bcrypt|passwordPolicyError|\[A-Z\]/);
  });

  it.each(FILES)('%s imports passwordPolicyError', (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    expect(src).toMatch(/passwordPolicyError/);
  });

  it.each(FILES)('%s hardcodes no complexity rule of its own', (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    expect(src, `${rel} still tests for an uppercase letter itself`).not.toMatch(
      /\/\[A-Z\]\/\.test\(\s*(?:new_)?password/,
    );
  });

  it('the policy object is frozen, so a caller cannot loosen it at runtime', () => {
    expect(Object.isFrozen(PASSWORD_POLICY)).toBe(true);
    const before = PASSWORD_POLICY.requireDigit;
    try {
      PASSWORD_POLICY.requireDigit = false;
    } catch {
      /* strict mode throws */
    }
    expect(PASSWORD_POLICY.requireDigit).toBe(before);
  });

  it('the description matches what the rule actually enforces', () => {
    // The description is served to the client and shown under the field, so a
    // drift here is a lie to the operator rather than a broken check.
    if (PASSWORD_POLICY.requireUppercase) expect(PASSWORD_POLICY.description).toMatch(/uppercase/i);
    if (PASSWORD_POLICY.requireLowercase) expect(PASSWORD_POLICY.description).toMatch(/lowercase/i);
    if (PASSWORD_POLICY.requireDigit) expect(PASSWORD_POLICY.description).toMatch(/number|digit/i);
    expect(PASSWORD_POLICY.description).toContain(String(PASSWORD_POLICY.minLength));
  });
});
