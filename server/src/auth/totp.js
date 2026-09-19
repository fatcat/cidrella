import crypto from 'crypto';

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP) and one-time
 * backup codes, on node's crypto alone. SHA-1, 6 digits, 30-second steps:
 * the only profile every authenticator app agrees on.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ISSUER = 'CIDRella';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str || '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32, the size RFC 4226 recommends for SHA-1. */
export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secretBytes, counter, digits = TOTP_DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secretBytes).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secret, step = totpStep()) {
  return hotp(base32Decode(secret), step);
}

/**
 * Check a code against the current step and one step either side (clock
 * drift). Returns the step it matched, or null. `afterStep` rejects any step
 * at or before the last accepted one, so a code seen once is spent.
 */
export function verifyTotp(secret, code, { nowMs = Date.now(), afterStep = null } = {}) {
  const digits = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secret);
  if (key.length === 0) return null;
  const current = totpStep(nowMs);
  for (const step of [current, current - 1, current + 1]) {
    if (afterStep != null && step <= afterStep) continue;
    const expected = Buffer.from(hotp(key, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(digits))) return step;
  }
  return null;
}

export function otpauthUrl({ secret, account, issuer = TOTP_ISSUER }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Backup codes: ten groups of two five-character blocks from an alphabet
// without look-alikes (no 0/O, 1/I/L). 50 bits of entropy each.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const BACKUP_CODE_COUNT = 10;

function randomBlock(len) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  return Array.from({ length: count }, () => `${randomBlock(5)}-${randomBlock(5)}`);
}

export function normalizeBackupCode(code) {
  return String(code || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function hashBackupCode(code) {
  return crypto.createHash('sha256').update(normalizeBackupCode(code)).digest('hex');
}

/** Does this look like a backup code rather than a six-digit TOTP? */
export function looksLikeBackupCode(code) {
  return normalizeBackupCode(code).length === 10;
}
