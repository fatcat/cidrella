/**
 * The password policy, in one place.
 *
 * It used to exist three times and the three disagreed (duplicate-logic audit
 * #39):
 *
 *   routes/setup.js        8 to 1024, plus uppercase + lowercase + digit
 *   auth/routes.js         8 to 1024, no complexity rule at all
 *   SetupWizard.vue        at least 8, no complexity rule
 *
 * That is not only a UX wrinkle. The first-run wizard forced a complex admin
 * password and then change-password accepted 'aaaaaaaa', so the policy could be
 * escaped seconds after install by the same admin it applied to. One module
 * means the enforcing routes cannot drift apart again, and the description is
 * served to the client so the wizard stops carrying its own copy of the rule.
 */

export const PASSWORD_POLICY = Object.freeze({
  minLength: 8,
  maxLength: 1024,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  // Shown by the client. Kept next to the rule it describes so the two cannot
  // drift, which is the whole point of this module.
  description:
    'At least 8 characters, including an uppercase letter, a lowercase letter, and a number.',
});

/**
 * Validate a password. Returns an operator-facing error string, or null when it
 * passes. Returning the message rather than a boolean keeps the wording in one
 * place too: both routes previously worded the same failure differently.
 */
export function passwordPolicyError(password, policy = PASSWORD_POLICY) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required';
  }
  if (password.length < policy.minLength || password.length > policy.maxLength) {
    return `Password must be ${policy.minLength}-${policy.maxLength} characters`;
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    return 'Password must contain uppercase, lowercase, and a number';
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    return 'Password must contain uppercase, lowercase, and a number';
  }
  if (policy.requireDigit && !/\d/.test(password)) {
    return 'Password must contain uppercase, lowercase, and a number';
  }
  return null;
}

// The complexity half of the rule is optional, per appliance. The length
// bounds are not. Off, the policy is "8 to 1024 characters" and nothing else.
export const PASSWORD_POLICY_LENGTH_ONLY = Object.freeze({
  ...PASSWORD_POLICY,
  requireUppercase: false,
  requireLowercase: false,
  requireDigit: false,
  description: 'At least 8 characters.',
});

export function passwordComplexityEnabled(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'password_complexity'").get();
  return row?.value !== 'false';
}

/** The policy this appliance enforces right now, for both routes and the client. */
export function effectivePasswordPolicy(db) {
  return passwordComplexityEnabled(db) ? PASSWORD_POLICY : PASSWORD_POLICY_LENGTH_ONLY;
}
