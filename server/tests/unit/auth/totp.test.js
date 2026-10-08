/**
 * TOTP on node crypto alone, checked against the RFC 6238 reference vectors
 * (SHA-1, secret "12345678901234567890"), plus the acceptance window, replay
 * protection and the backup-code helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  base32Encode,
  base32Decode,
  hotp,
  totpCode,
  verifyTotp,
  otpauthUrl,
  generateTotpSecret,
  generateBackupCodes,
  normalizeBackupCode,
  hashBackupCode,
  looksLikeBackupCode,
} from '../../../src/auth/totp.js';

const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips arbitrary bytes and ignores padding, case and spaces on decode', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    const enc = base32Encode(bytes);
    expect(base32Decode(enc)).toEqual(bytes);
    expect(base32Decode(enc.toLowerCase() + '====')).toEqual(bytes);
    expect(base32Decode(enc.replace(/(.{4})/g, '$1 '))).toEqual(bytes);
  });

  it('matches the RFC 4648 vector', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });
});

describe('RFC 6238 vectors, six digits', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('T=%s gives %s', (seconds, expected) => {
    expect(totpCode(RFC_SECRET, Math.floor(seconds / 30))).toBe(expected);
  });

  it('hotp at counter 0 with the RFC 4226 secret is 755224', () => {
    expect(hotp(Buffer.from('12345678901234567890', 'ascii'), 0)).toBe('755224');
  });
});

describe('verifyTotp', () => {
  const now = 1234567890 * 1000;
  const step = Math.floor(1234567890 / 30);

  it('accepts the current step and one either side, nothing further', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), { nowMs: now })).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), { nowMs: now })).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), { nowMs: now })).toBeNull();
  });

  it('refuses a code from a step already accepted, and anything before it', () => {
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now, afterStep: step })).toBeNull();
    expect(
      verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), { nowMs: now, afterStep: step }),
    ).toBeNull();
    expect(
      verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), { nowMs: now, afterStep: step }),
    ).toBe(step + 1);
  });

  it('tolerates spaces in the typed code and rejects anything that is not six digits', () => {
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs: now })).toBe(
      step,
    );
    expect(verifyTotp(RFC_SECRET, '12345', { nowMs: now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', { nowMs: now })).toBeNull();
    expect(verifyTotp('', code, { nowMs: now })).toBeNull();
  });
});

describe('enrolment helpers', () => {
  it('makes a 160-bit base32 secret and a standard otpauth URL', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const url = otpauthUrl({ secret, account: 'admin' });
    expect(url.startsWith('otpauth://totp/CIDRella%3Aadmin?')).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('secret')).toBe(secret);
    expect(params.get('issuer')).toBe('CIDRella');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });

  it('backup codes are ten unique xxxxx-xxxxx codes with no look-alike characters', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
  });

  it('normalizes and hashes the same whatever the user typed around it', () => {
    expect(normalizeBackupCode(' AbCdE-fGh23 ')).toBe('abcdefgh23');
    expect(hashBackupCode('abcde-fgh23')).toBe(hashBackupCode('ABCDE FGH23'));
    expect(looksLikeBackupCode('abcde-fgh23')).toBe(true);
    expect(looksLikeBackupCode('123456')).toBe(false);
  });
});
