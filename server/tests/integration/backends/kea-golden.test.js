/**
 * Golden output of the Kea backend: the backend estate (the one the dnsmasq
 * golden renders) plus a custom number, a custom address list and a
 * yes/no catalog option, rendered to kea-dhcp4.conf and kea-dhcp6.conf.
 * scripts that check these against a real `kea-dhcp4 -t` read the same
 * files, so a change here is a change Kea has to accept.
 */
import { DATA_DIR } from '../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const commands = [];
const exec = vi.fn((cmd, args = []) => {
  commands.push([cmd, ...args.map((a) => a.replace(DATA_DIR, '$DATA_DIR'))].join(' '));
  return '';
});

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../helpers/test-db.js');
const { ESTATE_INTERFACES, seedBackendEstate } = await import('../../helpers/backend-estate.js');
const { createKeaBackend } = await import('../../../src/backends/kea/index.js');

let db;
let tmpDir;
let backend;

const KEA_DIR = path.join(DATA_DIR, 'kea');
const golden = (step) => `./__golden__/${step}.txt`;

function snapshot() {
  const files = ['kea-dhcp4.conf', 'kea-dhcp6.conf'].map((name) => [
    `=== ${name} ===`,
    fs.readFileSync(path.join(KEA_DIR, name), 'utf8').replaceAll(DATA_DIR, '$DATA_DIR'),
  ]);
  return [...files.flat(), '=== commands ===', ...commands, ''].join('\n');
}

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  // The estate's interfaces, with eth0 also on the two DHCPv6 networks, so
  // Kea has a link to place them on and CIDRella an address to offer as
  // the DNS server.
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    ...ESTATE_INTERFACES,
    eth0: [
      ...ESTATE_INTERFACES.eth0,
      { family: 'IPv6', address: 'fd00:62::2', internal: false },
      { family: 'IPv6', address: 'fd00:63::2', internal: false },
    ],
  });
  seedBackendEstate(db);

  const v4Scope = db
    .prepare(
      "SELECT s.id FROM dhcp_scopes s JOIN subnets n ON n.id = s.subnet_id WHERE n.cidr = '10.60.0.0/24'",
    )
    .get().id;
  db.prepare(
    "INSERT INTO dhcp_custom_options (code, name, label, type, address_family) VALUES (224, 'site-number', 'Site', 'number', 4), (225, 'site-servers', 'Site servers', 'ip-list', 4)",
  ).run();
  const option = db.prepare(
    'INSERT OR REPLACE INTO dhcp_scope_options (scope_id, option_code, value, address_family) VALUES (?, ?, ?, 4)',
  );
  option.run(v4Scope, 224, '300');
  option.run(v4Scope, 225, '10.60.0.7,10.60.0.8');
  option.run(v4Scope, 19, '0');

  backend = createKeaBackend({
    exec,
    families: () => [4, 6],
    interfaces: () => ['eth0'],
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('kea backend golden output', () => {
  it('renders the estate and checks both files with kea -t', async () => {
    const result = backend.dhcp.applyScopes(db, { activate: false });
    expect(result).toEqual({ changed: true, activation: 'reload', activated: false });
    await expect(snapshot()).toMatchFileSnapshot(golden('kea-01-dhcp'));
  });

  it('renders nothing new and runs no check when nothing changed', () => {
    commands.length = 0;
    expect(backend.dhcp.applyScopes(db, { activate: false }).changed).toBe(false);
    expect(commands).toEqual([]);
  });
});
