import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

// Controllable settings backing getSetting().
let settings = {};
vi.mock('../../../src/db/init.js', () => ({
  getSetting: (k) => settings[k],
}));

let tmpDir;
let DNSMASQ_CONF;
let regenerateDnsmasqConf;
let applyInterfaceConfig;
let validateDnsmasqConfig;
let withValidatedDnsmasqUpdate;
let reservedLocalLines;
let BASE_CONF;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-changedet-test-'));
  process.env.DATA_DIR = tmpDir;
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq'), { recursive: true });
  DNSMASQ_CONF = path.join(tmpDir, 'dnsmasq', 'dnsmasq.conf');
  vi.mocked(execFileSync).mockReturnValue('Compile time options: IPv6 DHCP DNSSEC inotify');
  ({
    regenerateDnsmasqConf,
    applyInterfaceConfig,
    validateDnsmasqConfig,
    withValidatedDnsmasqUpdate,
    reservedLocalLines,
  } = await import('../../../src/utils/dnsmasq.js'));
  BASE_CONF = [
    'no-resolv',
    'no-hosts',
    'local-ttl=60',
    ...reservedLocalLines({ addresses: ['8.8.8.8'] }),
    'server=127.0.0.1#5356',
    'listen-address=127.0.0.1',
    'bind-dynamic',
    '',
  ].join('\n');
});

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockReturnValue('Compile time options: IPv6 DHCP DNSSEC inotify');
  fs.writeFileSync(DNSMASQ_CONF, BASE_CONF);
  settings = { dns_upstream_servers: ['8.8.8.8', '9.9.9.9'], dnssec_enabled: 'false' };
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('regenerateDnsmasqConf: change detection', () => {
  it('returns false and leaves the file alone when settings match the file', () => {
    // BASE_CONF already reflects the mocked settings, so the regen is a no-op
    const before = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(regenerateDnsmasqConf({})).toBe(false);
    expect(fs.readFileSync(DNSMASQ_CONF, 'utf-8')).toBe(before);
  });

  // dnsmasq forwards to CIDRella's forwarder in every mode, and the forwarder
  // reads the upstreams itself, so a new public upstream leaves the file alone.
  it('leaves the file alone when only the public upstreams changed', () => {
    settings.dns_upstream_servers = ['1.1.1.1'];
    expect(regenerateDnsmasqConf({})).toBe(false);
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(conf).not.toContain('server=1.1.1.1');
    expect(conf).toContain('server=127.0.0.1#5356');
  });

  it('is a no-op on the second call after a change was applied', () => {
    settings.dns_no_recursion = 'true';
    expect(regenerateDnsmasqConf({})).toBe(true);
    expect(regenerateDnsmasqConf({})).toBe(false);
  });

  it('returns false when the conf file does not exist', () => {
    fs.rmSync(DNSMASQ_CONF);
    expect(regenerateDnsmasqConf({})).toBe(false);
    expect(fs.existsSync(DNSMASQ_CONF)).toBe(false);
  });

  it('does not mistake the # in server=IP#port for a comment', () => {
    // Change detection ignores comment LINES. It must not strip from an inline
    // `#`, because dnsmasq uses it as the port separator. If it did, the
    // encrypted-forwarder line would compare as `server=127.0.0.1` against a
    // generated `server=127.0.0.1#5356` and never converge, restarting dnsmasq
    // on every single regen.
    settings.forwarder_encryption = 'tls';
    expect(regenerateDnsmasqConf({})).toBe(false);
    expect(fs.readFileSync(DNSMASQ_CONF, 'utf-8')).toContain('server=127.0.0.1#5356');
  });

  it('gives a pre-0.5.1 conf no-hosts and local-ttl once, replacing an old local-ttl', () => {
    const old = BASE_CONF.replace('no-hosts\nlocal-ttl=60\n', '') + 'local-ttl=0\n';
    fs.writeFileSync(DNSMASQ_CONF, old);
    expect(regenerateDnsmasqConf({})).toBe(true);
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(conf.split('\n').filter((l) => l === 'no-hosts')).toHaveLength(1);
    expect(conf.split('\n').filter((l) => l.startsWith('local-ttl='))).toEqual(['local-ttl=60']);
    expect(regenerateDnsmasqConf({})).toBe(false);
  });

  describe('reserved names', () => {
    const locals = () =>
      fs
        .readFileSync(DNSMASQ_CONF, 'utf-8')
        .split('\n')
        .filter((l) => l.startsWith('local=/'));

    it('answers reserved and site names locally behind public upstreams', () => {
      expect(regenerateDnsmasqConf({})).toBe(false);
      expect(locals()).toEqual(
        expect.arrayContaining([
          'local=/resolver.arpa/',
          'local=/localhost/',
          'local=/10.in-addr.arpa/',
          'local=/31.172.in-addr.arpa/',
          'local=/254.169.in-addr.arpa/',
          'local=/b.e.f.ip6.arpa/',
          'local=/internal/',
          'local=/home.arpa/',
          'local=/d.f.ip6.arpa/',
        ]),
      );
      expect(locals()).not.toContain('local=/example/');
    });

    it.each([
      ['an IPv4', ['8.8.8.8', '192.168.1.53']],
      ['an IPv6', ['2001:4860:4860::8888', 'fd00::53']],
    ])('leaves site names to %s private upstream', (_family, servers) => {
      settings.dns_upstream_servers = servers;
      expect(regenerateDnsmasqConf({})).toBe(true);
      expect(locals()).toContain('local=/resolver.arpa/');
      expect(locals()).toContain('local=/10.in-addr.arpa/');
      for (const site of ['internal', 'home.arpa', 'local', 'd.f.ip6.arpa']) {
        expect(locals()).not.toContain(`local=/${site}/`);
      }
      expect(regenerateDnsmasqConf({})).toBe(false);
    });

    it('judges the encrypted forwarder by its own upstreams', () => {
      settings.forwarder_encryption = 'tls';
      settings.forwarder_encrypted_upstreams = [
        { hostname: 'resolver.corp', addresses: ['10.1.1.1'] },
      ];
      expect(regenerateDnsmasqConf({})).toBe(true);
      expect(locals()).not.toContain('local=/internal/');
      settings.forwarder_encrypted_upstreams = [
        { hostname: 'dns10.quad9.net', addresses: ['9.9.9.10', '2620:fe::10'] },
      ];
      expect(regenerateDnsmasqConf({})).toBe(true);
      expect(locals()).toContain('local=/internal/');
    });

    it('keeps a zone of its own and a hand-written local= line', () => {
      fs.writeFileSync(DNSMASQ_CONF, `${BASE_CONF}local=/lab.example/\n`);
      expect(regenerateDnsmasqConf({})).toBe(false);
      expect(locals()).toContain('local=/lab.example/');
    });
  });

  describe('backup resolver', () => {
    const lines = () => fs.readFileSync(DNSMASQ_CONF, 'utf-8').split('\n');
    const serverLines = () => lines().filter((l) => l.startsWith('server='));

    it.each([
      ['IPv4', ['9.9.9.10'], ['1.1.1.1', '1.0.0.1']],
      ['IPv6', ['2620:fe::10'], ['2606:4700:4700::1111']],
    ])('hands an %s primary and backup to the forwarder, not dnsmasq', (_f, primary, backup) => {
      settings.dns_upstream_servers = primary;
      settings.dns_upstream_backup_servers = backup;
      for (const mode of ['failover', 'balance']) {
        settings.dns_upstream_backup_mode = mode;
        expect(regenerateDnsmasqConf({})).toBe(false);
        expect(serverLines()).toEqual(['server=127.0.0.1#5356']);
        expect(lines()).not.toContain('strict-order');
      }
    });

    it('judges reserved site names by the backup too', () => {
      settings.dns_upstream_backup_servers = ['192.168.1.53'];
      expect(regenerateDnsmasqConf({})).toBe(true);
      expect(lines()).not.toContain('local=/internal/');
    });
  });

  it('keeps a hand-written comment in dnsmasq.conf and reports no change', () => {
    fs.writeFileSync(DNSMASQ_CONF, `# operator note: do not remove bind-dynamic\n${BASE_CONF}`);
    expect(regenerateDnsmasqConf({})).toBe(false);
    expect(fs.readFileSync(DNSMASQ_CONF, 'utf-8')).toContain(
      '# operator note: do not remove bind-dynamic',
    );
  });
});

describe('applyInterfaceConfig: change detection', () => {
  it('writes on first apply, then reports unchanged on an identical re-apply', () => {
    // First apply rewrites BASE_CONF's interface directives for this host
    const first = applyInterfaceConfig({});
    expect(first).toBe(true);
    const afterFirst = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    // Same settings, same host interfaces, nothing to change
    expect(applyInterfaceConfig({})).toBe(false);
    expect(fs.readFileSync(DNSMASQ_CONF, 'utf-8')).toBe(afterFirst);
  });

  it('returns true again when a relevant setting flips', () => {
    applyInterfaceConfig({});
    settings.dns_enabled = 'false';
    expect(applyInterfaceConfig({})).toBe(true);
    expect(fs.readFileSync(DNSMASQ_CONF, 'utf-8')).toContain('port=0');
  });

  it('returns false when the conf file does not exist', () => {
    fs.rmSync(DNSMASQ_CONF);
    expect(applyInterfaceConfig({})).toBe(false);
  });
});

describe('validated dnsmasq updates', () => {
  it('tests the generated configuration with the configured root file', () => {
    validateDnsmasqConfig();

    expect(execFileSync).toHaveBeenCalledWith(
      'dnsmasq',
      ['--test', `--conf-file=${DNSMASQ_CONF}`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  });

  it('restores every changed config file when validation fails', () => {
    const hostsDir = path.join(tmpDir, 'dnsmasq', 'hosts.d');
    const existingHost = path.join(hostsDir, 'zone-1.hosts');
    const newHost = path.join(hostsDir, 'zone-2.hosts');
    fs.mkdirSync(hostsDir, { recursive: true });
    fs.writeFileSync(existingHost, '10.0.0.10 old.example.test\n');

    vi.mocked(execFileSync).mockImplementationOnce(() => {
      const error = new Error('dnsmasq test failed');
      error.stderr = Buffer.from('bad option at line 4');
      throw error;
    });

    expect(() =>
      withValidatedDnsmasqUpdate(() => {
        fs.writeFileSync(DNSMASQ_CONF, 'invalid-directive\n');
        fs.writeFileSync(existingHost, '10.0.0.11 changed.example.test\n');
        fs.writeFileSync(newHost, '10.0.0.12 new.example.test\n');
        return true;
      }),
    ).toThrow('dnsmasq configuration validation failed: bad option at line 4');

    expect(fs.readFileSync(DNSMASQ_CONF, 'utf8')).toBe(BASE_CONF);
    expect(fs.readFileSync(existingHost, 'utf8')).toBe('10.0.0.10 old.example.test\n');
    expect(fs.existsSync(newHost)).toBe(false);
  });
});
