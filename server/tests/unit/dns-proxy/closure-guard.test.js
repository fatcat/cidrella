/**
 * What the DNS proxy process may load. Its code id covers every file it
 * loads, so the closure must stay small and stable: a file that pulls in the
 * database layer, the backends, Express or config/defaults.js (rewritten at
 * every release build) would restart the proxy on every update and drag web
 * code into it. These are the modules the proxy carries; each one's closure
 * is checked.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { importClosure } from '../../../src/dns-proxy/code-id.js';

const src = (rel) => fileURLToPath(new URL(`../../../src/${rel}`, import.meta.url));

const PROXY_MODULES = [
  'dns-proxy/constants.js',
  'dns-proxy/code-id.js',
  'dns-proxy/log.js',
  'dns-proxy/server.js',
  'dns-proxy/forwarder.js',
  'dns-proxy/db.js',
  'dns-proxy/protocol.js',
  'dns-proxy/ipc-server.js',
  'dns-proxy/main.js',
  'models/setting-value.js',
  'utils/query-log-writer.js',
  'utils/query-log-line.js',
  'models/filtering-exemption-read.js',
  'utils/forwarding-modes.js',
  'utils/dns-wire.js',
  'utils/dns-ede.js',
  'utils/samples.js',
  'utils/address.js',
  'utils/cidr-match.js',
  'utils/geo-cities.js',
  'utils/plain-dns.js',
  'utils/upstream-pool.js',
  'utils/lease-sql.js',
  'data/doh-providers.js',
];

// Never in the proxy's closure.
const FORBIDDEN = [
  /^src\/db\//,
  /^src\/config\//,
  /^src\/backends\//,
  /^src\/services\//,
  /^src\/routes\//,
  /^src\/middleware\//,
  /^src\/utils\/(ip-liveness|switch-state|interface-config|role-switches|request-actor)\.js$/,
  /^src\/models\/(?!(?:filtering-exemption-read|setting-value)\.js$)/,
];
const FORBIDDEN_PACKAGES = /^(express|@duckdb\/|duckdb)/;

describe('the DNS proxy closure', () => {
  for (const rel of PROXY_MODULES) {
    it(`${rel} loads nothing the proxy must not carry`, () => {
      const { files, packages, dynamicImports } = importClosure(src(rel));
      expect(files.filter((file) => FORBIDDEN.some((re) => re.test(file)))).toEqual([]);
      expect(packages.filter((pkg) => FORBIDDEN_PACKAGES.test(pkg))).toEqual([]);
      expect(dynamicImports).toEqual([]);
    });
  }
});
