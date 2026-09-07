import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  closeAnalyticsDb,
  flushQueries,
  initAnalyticsDb,
  logDnsQuery,
  queryTopDomainsWithoutDnssec,
} from '../../../src/db/duckdb.js';

let tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-duckdb-dnssec-'));
  await initAnalyticsDb(tmpDir);
});

afterAll(async () => {
  await closeAnalyticsDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function logDomain(domain, dnssecSupported, overrides = {}) {
  logDnsQuery({
    clientIp: '192.0.2.10',
    domain,
    queryType: 'A',
    responseCode: 'NOERROR',
    action: 'allowed',
    dnssecSupported,
    ...overrides,
  });
}

describe('queryTopDomainsWithoutDnssec', () => {
  it('counts only successful allowed answers proven to be unsigned', async () => {
    logDomain('unsigned.example', false);
    logDomain('unsigned.example', false);
    logDomain('other-unsigned.example', false);
    logDomain('signed.example', true);
    logDomain('unknown.example', null);
    logDomain('failed.example', false, { responseCode: 'SERVFAIL' });
    logDomain('blocked.example', false, { action: 'blocked_geoip' });
    await flushQueries();

    await expect(queryTopDomainsWithoutDnssec('1h', 10)).resolves.toEqual([
      { domain: 'unsigned.example', count: 2 },
      { domain: 'other-unsigned.example', count: 1 },
    ]);
  });
});
