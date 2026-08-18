import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPO = path.resolve(ROOT, '..');

/**
 * Duplicate-logic audit #38.
 *
 * SOA defaults live on the server. The client used to carry a fallback copy for
 * when GET /api/dns/soa-defaults failed, and that copy had drifted:
 * soa_minimum_ttl was 900 in four client places against 1800 in
 * server/src/config/defaults.js and 86400 as the SQL column default.
 *
 * docs/CROSS-TIER-DUPLICATION.md calls this out by name: the fallback literal
 * IS the duplicate, and it is where drift lands because nobody reviews the sad
 * path. The rule is that the UI refuses the control rather than inventing a
 * value.
 *
 * This is a source-level guard rather than a mounted-component test, because
 * the property is "no second copy of these numbers exists in the client", which
 * a behavioural test cannot express.
 */
const CLIENT_FILES = [
  'src/views/DNS.vue',
  'src/components/DnsPanel.vue',
];

const SOA_KEYS = ['soa_refresh', 'soa_retry', 'soa_expire', 'soa_minimum_ttl'];

describe('#38: the client holds no copy of the server SOA defaults', () => {
  it.each(CLIENT_FILES)('%s assigns no numeric literal to an SOA field', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const key of SOA_KEYS) {
      // Matches `soa_refresh: 3600` and `soa_refresh ?? 3600`, but not
      // `soa_refresh: soaDefaults.soa_refresh` or `soa_refresh: null`.
      const bad = new RegExp(`${key}\\s*(?::|\\?\\?)\\s*\\d+`);
      const m = src.match(bad);
      expect(m, `${rel} still hardcodes ${key}: ${m && m[0]}`).toBeNull();
    }
  });

  it('the server value this drifted from is still where the client expects it', () => {
    // If dns_soa_defaults ever moves or is renamed, the client's fetch breaks
    // and the temptation to re-add a literal comes back. Fail loudly here.
    const defaults = fs.readFileSync(path.join(REPO, 'server/src/config/defaults.js'), 'utf8');
    expect(defaults).toMatch(/dns_soa_defaults:\s*\{/);
    for (const key of SOA_KEYS) {
      expect(defaults, `server defaults should define ${key}`).toContain(key);
    }
  });

  it('the guard actually catches a reintroduced literal', () => {
    // Proves the regex is not vacuous. This is the shape that was removed.
    const sample = 'soa_refresh: 3600, soa_retry: 900, soa_expire: 604800, soa_minimum_ttl: 900';
    const hits = SOA_KEYS.filter(k => new RegExp(`${k}\\s*(?::|\\?\\?)\\s*\\d+`).test(sample));
    expect(hits).toEqual(SOA_KEYS);
  });
});
