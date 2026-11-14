/**
 * The lint checks added after the first SonarQube scan (2026-10-25): the
 * cidrella/no-floating-async ESLint rule and scripts/check-curl-https.js.
 */
import path from 'path';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import { RuleTester } from 'eslint';

const require = createRequire(import.meta.url);
const rule = require('../../../../scripts/eslint-rules/no-floating-async.js');
const { curlProblems } = require('../../../../scripts/check-curl-https.js');

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } });
// Imports resolve from here, so './mac-vendor.js' is the real module with its
// real `export async function refreshVendorDb`.
const filename = path.resolve(__dirname, '../../../src/utils/probe.js');
const floating = (name) => ({ messageId: 'floating', data: { name } });

tester.run('cidrella/no-floating-async', rule, {
  valid: [
    { filename, code: 'async function f() {} export async function g() { await f(); }' },
    { filename, code: 'async function f() {} export function g() { return f(); }' },
    { filename, code: 'async function f() {} f().catch(() => {});' },
    { filename, code: 'async function f() {} void f();' },
    { filename, code: 'function f() {} f();' },
    {
      filename,
      code: "import { refreshVendorDb } from './mac-vendor.js'; void refreshVendorDb();",
    },
    { filename, code: "import { parseManufLine } from './mac-vendor.js'; parseManufLine('x');" },
    { filename, code: "import { thing } from 'some-package'; thing();" },
  ],
  invalid: [
    { filename, code: 'f(); async function f() {}', errors: [floating('f')] },
    { filename, code: 'const f = async () => {}; f();', errors: [floating('f')] },
    {
      filename,
      code: "import { refreshVendorDb as refresh } from './mac-vendor.js'; refresh();",
      errors: [floating('refresh')],
    },
    {
      filename,
      code: "import * as Scanner from './scanner.js'; Scanner.startScan(1, 2, 3);",
      errors: [floating('Scanner.startScan')],
    },
  ],
});

describe('check-curl-https', () => {
  it('refuses a redirect-following curl without the HTTPS-only flags', () => {
    expect(curlProblems('curl -fsSL "$URL" -o out')).toEqual([
      "1: curl -L without --proto '=https' --proto-redir '=https'",
    ]);
    expect(curlProblems('x=$(curl --location "$URL")')).toHaveLength(1);
    // A continuation is one command, reported at its first line.
    expect(curlProblems('\n  curl -fsSL \\\n    "$URL" | bash')).toEqual([
      "2: curl -L without --proto '=https' --proto-redir '=https'",
    ]);
  });

  it('accepts the HTTPS-only form and leaves non-redirecting calls alone', () => {
    expect(curlProblems("curl --proto '=https' --proto-redir '=https' -fsSL \"$URL\"")).toEqual([]);
    expect(curlProblems('curl -sk "https://127.0.0.1:8443/api/health"')).toEqual([]);
    expect(curlProblems('# curl -fsSL "$URL"')).toEqual([]);
    expect(curlProblems('apt-get install -y curl dnsutils')).toEqual([]);
  });
});
