/**
 * The forwarder-IP gate in DNS.vue must range-check octets.
 *
 * DNS.vue carried its own /^(\d{1,3}\.){3}\d{1,3}$/ next to a file that already
 * exports a range-checking predicate. Shape-only means 999.999.999.999 passed
 * the gate and got handed to the forwarder-test endpoint as an upstream
 * resolver address.
 *
 * Same defect as #51, different file: a local regex that looks like an IP check
 * and only checks the punctuation.
 *
 * See REVIEW.md, duplicate-logic audit #43.
 */
import { describe, it, expect } from 'vitest';
import { isValidIpv4 } from '../../../src/utils/ip.js';

// The regex DNS.vue used to carry, kept here to show what it let through.
const SHAPE_ONLY = /^(\d{1,3}\.){3}\d{1,3}$/;

describe('forwarder IP gate', () => {
  it('rejects the out-of-range addresses the old local regex accepted', () => {
    for (const bad of ['999.999.999.999', '256.0.0.1', '300.1.1.1', '8.8.8.999']) {
      expect(SHAPE_ONLY.test(bad), `${bad} should expose the old hole`).toBe(true);
      expect(isValidIpv4(bad), `${bad} must be rejected now`).toBe(false);
    }
  });

  it('still accepts real forwarder addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '9.9.9.10', '192.168.1.1']) {
      expect(isValidIpv4(ip), ip).toBe(true);
    }
  });

  it('rejects the non-address shapes too', () => {
    for (const bad of ['', '8.8.8', '8.8.8.8.8', 'dns.example.com', '8.8.8.a']) {
      expect(isValidIpv4(bad), bad).toBe(false);
    }
  });

  // The cases above pin the utility, and the utility was never the broken part.
  // Without this, re-adding the local regex to DNS.vue leaves this file green,
  // which is the "passes while testing nothing" shape worth avoiding. Reading
  // the source is crude, but it is what actually covers the wiring, and
  // mounting DNS.vue costs the router, the store and a dozen PrimeVue parts for
  // one `if`.
  it('DNS.vue uses the shared predicate and carries no local IPv4 regex', async () => {
    // Vite's ?raw import, deliberately, after two worse attempts: import.meta.url
    // is an http:// URL under happy-dom so fileURLToPath throws, and
    // process.cwd() is the repo root here but the client dir under
    // `npm run test:client`, so a cwd-relative path passes one way and ENOENTs
    // the other. ?raw resolves through Vite's module graph and depends on
    // neither.
    const { default: src } = await import('../../../src/views/DNS.vue?raw');
    expect(src).toMatch(/isValidIpv4\s*\(\s*ip\s*\)/);
    // Match the regex being EXECUTED, not merely mentioned: the comment above
    // the import quotes the old pattern on purpose, and a bare text search for
    // it fails against that comment rather than against real code.
    expect(src).not.toMatch(/\{1,3\}\$\/\s*\.test\s*\(/);
  });
});
