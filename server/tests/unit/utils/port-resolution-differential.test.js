/**
 * Differential test: the bash web-port ladder against the JS one.
 *
 * `scripts/lib/slots.sh` `resolve_port` and `server/src/utils/http-server.js`
 * `resolvePort` decide the same thing in two languages, because bash cannot
 * import JS. The server uses the JS one to choose what it listens on; update.sh
 * uses the bash one to choose what to probe after switching slots. When they
 * disagree the updater probes a port nothing is serving, the post-switch health
 * check fails, and a healthy slot is rolled back.
 *
 * That was not hypothetical. update.sh's inline copy only read the DB through
 * the sqlite3 CLI, which install.sh never installs, so the DB tier never fired
 * and every update probed 8443 no matter what the admin had configured.
 * See REVIEW.md, duplicate-logic audit #37.
 *
 * The duplication itself is deliberate and stays, per
 * docs/CROSS-TIER-DUPLICATION.md option 3. What was missing is this.
 *
 * If this fails, do not edit the fixture table. Work out which side changed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SLOTS_LIB = path.join(REPO_ROOT, 'scripts/lib/slots.sh');
const FALLBACK = 8443;

function bashResolvePort(dbVal, envVal, fallback = FALLBACK) {
  return execFileSync(
    'bash',
    ['-c', '. "$1"; resolve_port "$2" "$3" "$4"', 'bash', SLOTS_LIB,
      String(dbVal ?? ''), String(envVal ?? ''), String(fallback)],
    { encoding: 'utf8' }
  ).trim();
}

// A standalone copy of the JS ladder. resolvePort itself reads getSetting and
// process.env, which would mean mocking the DB to drive a fixture table; the
// tier ORDER and the validity rule are what must match, and they are restated
// here in the same shape the real function uses.
function jsResolvePort(dbVal, envVal, fallback = FALLBACK) {
  if (dbVal !== null && dbVal !== undefined && dbVal !== '') {
    const n = parseInt(dbVal, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  if (envVal) {
    const n = parseInt(envVal, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  return fallback;
}

// [dbValue, envValue] pairs, grouped by the property each probes.
const CASES = [
  // DB wins when valid, whatever the environment says
  ['9443', '8443'], ['443', ''], ['1', '65535'], ['65535', '1'],
  // DB empty or absent, environment wins
  ['', '9000'], ['', '443'],
  // DB out of range, so the environment is consulted
  ['0', '9000'], ['65536', '9000'], ['99999', '9000'],
  // nothing usable anywhere, hardcoded fallback
  ['', ''], ['0', '0'], ['65536', '99999'],
  // the real-world shape: admin sets a high port in the UI, no env override
  ['9443', ''],
  // install.sh probed 443 free on a fresh install and wrote the drop-in
  ['', '443'],
];

describe('web port: the bash and JS ladders agree', () => {
  it('has the bash library where the test expects it', () => {
    expect(fs.existsSync(SLOTS_LIB), `${SLOTS_LIB} not found`).toBe(true);
  });

  it.each(CASES)('resolve_port(db=%s, env=%s) matches resolvePort', (dbVal, envVal) => {
    const js = String(jsResolvePort(dbVal, envVal));
    const bash = bashResolvePort(dbVal, envVal);
    expect(bash, `bash gave ${bash}, JS gave ${js} for db="${dbVal}" env="${envVal}"`).toBe(js);
  });

  it('both honour tier order: DB beats env beats fallback', () => {
    expect(bashResolvePort('1111', '2222')).toBe('1111');
    expect(jsResolvePort('1111', '2222')).toBe(1111);
    expect(bashResolvePort('', '2222')).toBe('2222');
    expect(jsResolvePort('', '2222')).toBe(2222);
    expect(bashResolvePort('', '')).toBe(String(FALLBACK));
    expect(jsResolvePort('', '')).toBe(FALLBACK);
  });

  it('the fixture table exercises every tier, so agreement is not vacuous', () => {
    const results = CASES.map(([d, e]) => jsResolvePort(d, e));
    expect(results.some(r => r === 9443), 'a DB-tier win').toBe(true);
    expect(results.some(r => r === 9000), 'an env-tier win').toBe(true);
    expect(results.some(r => r === FALLBACK), 'a fallback').toBe(true);
  });

  it('bash is strictly stricter, and never accepts what JS would reject', () => {
    // JS uses parseInt, so it takes the leading digits of '8443abc'. bash
    // requires all digits. That is a real difference and it is one-directional:
    // anything bash accepts, JS resolves to the same number. It is unreachable
    // in practice because routes/interfaces.js writes String(Number) and the
    // env value comes from install.sh's own drop-in, so rather than contort
    // bash into matching parseInt this pins the property that matters.
    for (const junk of ['8443abc', ' 8443', '+8443', '84.43']) {
      const bash = bashResolvePort(junk, '');
      expect(bash, `bash should refuse ${JSON.stringify(junk)} and fall through`)
        .toBe(String(FALLBACK));
    }
    // And the converse: every value bash accepts, JS agrees on exactly.
    for (const good of ['1', '80', '443', '8443', '9443', '65535']) {
      expect(bashResolvePort(good, '')).toBe(String(jsResolvePort(good, '')));
    }
  });
});
