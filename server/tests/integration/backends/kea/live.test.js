/**
 * The Kea adapter against a real Kea 3 install: what CIDRella renders must
 * pass `kea-dhcp4 -t` and `kea-dhcp6 -t`. Skipped unless KEA_LIVE=1, so it
 * runs only where Kea is installed (the test host, or a container with
 * ISC's isc-kea-dhcp4, -dhcp6 and -hooks packages):
 *
 *   KEA_LIVE=1 npx vitest run tests/integration/backends/kea/live.test.js
 *
 * Starting kea-dhcp4 needs CAP_NET_RAW (ping_check opens an ICMP socket and
 * the daemon will not start without it): run as root, or as a user in group
 * _kea given it ambiently, e.g. `setpriv --reuid=<user> --init-groups
 * --inh-caps=+net_raw --ambient-caps=+net_raw ...`.
 *
 * It checks the backend estate through the adapter, starts each daemon on
 * it (`-t` loads no hooks, so only a start shows a hook that will not load),
 * then every catalog option of both families on its own, so a code Kea
 * parses differently from dnsmasq fails by name.
 */
import { DATA_DIR } from '../../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import path from 'path';

const LIVE = process.env.KEA_LIVE === '1';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../../helpers/test-db.js');
const { seedBackendEstate } = await import('../../../helpers/backend-estate.js');
const { createKeaBackend } = await import('../../../../src/backends/kea/index.js');
const { renderKeaConfig, serializeKeaConfig } =
  await import('../../../../src/backends/kea/render.js');
const { binary, confPath, controlPort, keaEnv, KEA_API_USER } =
  await import('../../../../src/backends/kea/paths.js');
const { readKeaSecret } = await import('../../../../src/backends/kea/secret.js');
const { createKeaClient } = await import('../../../../src/backends/kea/client.js');
const { optionCatalogFor } = await import('../../../../src/utils/dhcp-options.js');

// What a user would enter for each kind of option, in dnsmasq's syntax.
const SAMPLE_TEXT = {
  4: {
    21: '10.0.0.0,255.0.0.0',
    25: '68,296',
    33: '10.9.0.0,10.5.0.1',
    43: '01:04:c0:a8:01:01',
    63: '01:02:03',
    77: 'myclass',
    82: '01:04:61:62:63:64',
    121: '10.9.0.0/16,10.5.0.1',
    252: 'http://wpad.example.com/wpad.dat',
  },
  6: {},
};

function sampleValue(option, family) {
  if (option.type === 'ip' || option.type === 'ip-list') {
    return { addresses: [family === 6 ? 'fd00:5::1' : '10.5.0.1'] };
  }
  if (SAMPLE_TEXT[family][option.code]) return { text: SAMPLE_TEXT[family][option.code] };
  if (option.type === 'number') return { text: '60' };
  if (option.type === 'select') return { text: option.choices[0] };
  if (option.type === 'text-list') return { text: 'a.example.com,b.example.com' };
  if (/url|portal/.test(option.name)) return { text: 'https://portal.example.com/api' };
  return { text: 'example.com' };
}

function scopeModel(family, options) {
  const v6 = family === 6;
  return {
    scope: {
      id: 1,
      subnet_id: 1,
      subnet_cidr: v6 ? 'fd00:5::/64' : '10.5.0.0/24',
      subnet_broadcast: '10.5.0.255',
    },
    family,
    network: v6 ? 'fd00:5::' : '10.5.0.0',
    prefix: v6 ? 64 : 24,
    mode: v6 ? 'stateful' : null,
    leaseTime: '12h',
    pools: [
      { start_ip: v6 ? 'fd00:5::100' : '10.5.0.100', end_ip: v6 ? 'fd00:5::1ff' : '10.5.0.199' },
    ],
    excludedIps: [],
    suppressRouter: false,
    options,
  };
}

// `kea-dhcpN -t` on a file, with the daemons' path confinement; the error
// text on failure.
function keaCheck(family, file) {
  try {
    execFileSync(binary(family), ['-t', file], {
      stdio: 'pipe',
      env: { ...process.env, ...keaEnv() },
    });
    return null;
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    return out.match(/Error encountered: [^\n]*/)?.[0] || out.trim() || err.message;
  }
}

describe.skipIf(!LIVE)('Kea adapter against real Kea', () => {
  let db;
  let tmpDir;

  beforeAll(async () => {
    ({ db, tmpDir } = await setupTestDb());
    enableIpv6(db);
    seedBackendEstate(db);
    const env = keaEnv();
    for (const dir of [env.KEA_LOG_FILE_DIR, env.KEA_CONTROL_SOCKET_DIR]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      fs.chmodSync(dir, 0o750);
    }
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('renders the estate into files kea -t accepts', () => {
    const backend = createKeaBackend({ families: () => [4, 6], interfaces: () => ['lo'] });
    backend.prepare();
    expect(() => backend.dhcp.applyScopes(db, { activate: false })).not.toThrow();
  });

  for (const family of [4, 6]) {
    it(`starts kea-dhcp${family} on that config, every hook loaded`, async () => {
      const child = spawn(binary(family), ['-c', confPath(family)], {
        env: { ...process.env, ...keaEnv() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const command = createKeaClient({
        port: controlPort(family),
        user: KEA_API_USER,
        password: () => readKeaSecret(),
        timeoutMs: 500,
      });
      try {
        let status = null;
        const deadline = Date.now() + 10_000;
        while (!status && child.exitCode === null && Date.now() < deadline) {
          status = await command('status-get').catch(
            () => new Promise((resolve) => setTimeout(() => resolve(null), 200)),
          );
        }
        expect(status, output.match(/ERROR[^\n]*/g)?.join('\n') || output).toBeTruthy();
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await once(child, 'exit');
        }
      }
    });

    it(`writes every DHCPv${family} catalog option in a form kea -t accepts`, () => {
      const catalog = optionCatalogFor(family);
      const dir = path.join(DATA_DIR, `catalog${family}`);
      fs.mkdirSync(dir, { recursive: true });
      const refused = [];
      for (const option of catalog.options) {
        if (option.type === 'flag' || catalog.internalCodes.has(option.code)) continue;
        if ([1, 28, 51].includes(option.code)) continue; // never written as options
        const model = scopeModel(family, [
          { code: option.code, type: option.type, custom: false, ...sampleValue(option, family) },
        ]);
        const file = path.join(dir, `${option.code}.conf`);
        fs.writeFileSync(
          file,
          serializeKeaConfig(
            renderKeaConfig(family, { scopes: [model], reservations: [], interfaces: [] }),
          ),
        );
        const error = keaCheck(family, file);
        if (error) refused.push(`${option.code} ${option.name}: ${error}`);
      }
      expect(refused).toEqual([]);
    });
  }
});
