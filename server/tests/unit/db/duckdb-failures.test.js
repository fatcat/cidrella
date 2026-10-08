import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  closeAnalyticsDb,
  flushQueries,
  initAnalyticsDb,
  logDnsQuery,
  queryFailedDomains,
} from '../../../src/db/duckdb.js';

let tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-duckdb-failures-'));
  await initAnalyticsDb(tmpDir);
});

afterAll(async () => {
  await closeAnalyticsDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const log = (domain, responseCode, ede, failure, queryType = 'A') =>
  logDnsQuery({
    clientIp: queryType === 'AAAA' ? '2001:db8::10' : '192.0.2.10',
    domain,
    queryType,
    responseCode,
    action: 'allowed',
    ede,
    failure,
  });

describe('queryFailedDomains', () => {
  it('ranks the names that failed, with their usual cause and EDE, either family', async () => {
    log('dnssec-failed.org', 'SERVFAIL', 7, 'dnssec');
    log('dnssec-failed.org', 'SERVFAIL', 7, 'dnssec', 'AAAA');
    log('dnssec-failed.org', 'SERVFAIL', 6, 'dnssec');
    log('slow.example', 'SERVFAIL', null, 'timeout', 'AAAA');
    log('fine.example', 'NOERROR', null, null);
    log('gone.example', 'NXDOMAIN', null, null);
    await flushQueries();

    await expect(queryFailedDomains('1h', 10)).resolves.toEqual([
      { domain: 'dnssec-failed.org', count: 3, failure: 'dnssec', ede: 7 },
      { domain: 'slow.example', count: 1, failure: 'timeout', ede: null },
    ]);
  });
});
