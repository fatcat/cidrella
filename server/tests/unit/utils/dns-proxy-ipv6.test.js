/**
 * The proxy's IPv6 surface: bind addresses of both families and the AAAA
 * sinkhole for blocked names.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import dnsPacket from 'dns-packet';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, applyInterfaceConfig: vi.fn(), restartDnsmasq: vi.fn() };
});
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createBlockedResponse, loadBlocklist } from '../../../src/utils/dns-proxy.js';

let tmpDir;
let db;

function setRedirects(v4, v6) {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('blocklist_redirect_ip', ?)",
  ).run(v4);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('blocklist_redirect_ip6', ?)",
  ).run(v6);
  loadBlocklist();
}

function blocked(types) {
  const query = dnsPacket.decode(
    dnsPacket.encode({
      id: 7,
      type: 'query',
      questions: types.map((type) => ({ type, name: 'ads.example.net' })),
    }),
  );
  return dnsPacket.decode(createBlockedResponse(query));
}

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('blocklist_enabled', 'true')",
  ).run();
});

afterAll(() => cleanupTestDb(tmpDir));

describe('createBlockedResponse across families', () => {
  it('answers A and AAAA with their own sinkhole addresses', () => {
    setRedirects('0.0.0.0', '::');
    const a = blocked(['A']);
    expect(a.rcode).toBe('NOERROR');
    expect(a.answers).toEqual([expect.objectContaining({ type: 'A', data: '0.0.0.0' })]);
    const aaaa = blocked(['AAAA']);
    expect(aaaa.rcode).toBe('NOERROR');
    expect(aaaa.answers).toEqual([expect.objectContaining({ type: 'AAAA', data: '::' })]);
  });

  it('gives an empty NOERROR to the family without a sinkhole, so nothing resolves there either', () => {
    setRedirects('0.0.0.0', '');
    const aaaa = blocked(['AAAA']);
    expect(aaaa.rcode).toBe('NOERROR');
    expect(aaaa.answers).toEqual([]);
    setRedirects('', 'fd00::dead');
    const a = blocked(['A']);
    expect(a.rcode).toBe('NOERROR');
    expect(a.answers).toEqual([]);
    expect(blocked(['AAAA']).answers[0].data).toBe('fd00::dead');
  });

  it('returns NXDOMAIN with no sinkhole at all', () => {
    setRedirects('', '');
    expect(blocked(['AAAA']).rcode).toBe('NXDOMAIN');
    expect(blocked(['A']).rcode).toBe('NXDOMAIN');
  });
});

describe('proxy bind addresses', () => {
  it('covers IPv4 and global or unique-local IPv6 on the selected interfaces, never link-local', async () => {
    const { listenableAddresses } = await import('../../../src/utils/dnsmasq.js');
    const spy = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [
        { family: 'IPv4', address: '10.0.1.2', internal: false },
        { family: 'IPv6', address: 'fe80::1', internal: false },
        { family: 'IPv6', address: 'fd00:a::2', internal: false },
      ],
    });
    try {
      expect(listenableAddresses(os.networkInterfaces().eth0, { ipv6: true })).toEqual([
        '10.0.1.2',
        'fd00:a::2',
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
