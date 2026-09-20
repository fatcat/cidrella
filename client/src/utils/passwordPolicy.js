// The password rule as the server serves it: { minLength, maxLength,
// requireMixedCase, requireNumber, requireSymbol, description }. These two
// helpers mirror server/src/auth/password-policy.js so a form can check as
// the user types and describe a rule it has just changed, before the server
// has answered.

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

/** Per-rule pass/fail for a candidate password; only rules the policy has are listed. */
export function policyChecks(password, p) {
  const v = password || '';
  const max = p?.maxLength ?? 1024;
  const checks = [];
  if (p?.minLength > 0) {
    checks.push({
      id: 'length',
      label: `at least ${p.minLength} characters`,
      ok: v.length >= p.minLength,
    });
  }
  if (p?.requireMixedCase) {
    checks.push({
      id: 'mixed',
      label: 'upper and lower case letters',
      ok: /[A-Z]/.test(v) && /[a-z]/.test(v),
    });
  }
  if (p?.requireNumber) checks.push({ id: 'number', label: 'a number', ok: /\d/.test(v) });
  if (p?.requireSymbol)
    checks.push({ id: 'symbol', label: 'a symbol', ok: /[^A-Za-z0-9]/.test(v) });
  const ok = v.length > 0 && v.length <= max && checks.every((c) => c.ok);
  return { checks, ok };
}
