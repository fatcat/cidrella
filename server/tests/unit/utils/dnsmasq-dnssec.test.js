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
let dnsmasqSupportsDnssec;

const BASE_CONF = [
  'no-resolv',
  'server=8.8.8.8',
  'server=9.9.9.9',
  'listen-address=127.0.0.1',
  'bind-dynamic',
  '',
].join('\n');

function dnssecLines(conf) {
  return conf.split('\n').filter(l => l.trim() === 'dnssec');
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-dnssec-test-'));
  process.env.DATA_DIR = tmpDir;
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq'), { recursive: true });
  DNSMASQ_CONF = path.join(tmpDir, 'dnsmasq', 'dnsmasq.conf');
  // dnsmasq reports DNSSEC support in this file's default mock.
  vi.mocked(execFileSync).mockReturnValue('Compile time options: IPv6 DHCP DNSSEC inotify');
  ({ regenerateDnsmasqConf, dnsmasqSupportsDnssec } = await import('../../../src/utils/dnsmasq.js'));
});

beforeEach(() => {
  fs.writeFileSync(DNSMASQ_CONF, BASE_CONF);
  settings = { dns_upstream_servers: ['8.8.8.8', '9.9.9.9'], dnssec_enabled: 'false' };
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('regenerateDnsmasqConf: no-recursion (authoritative-only)', () => {
  it('emits NO server= lines when dns_no_recursion is true', () => {
    settings.dns_no_recursion = 'true';
    regenerateDnsmasqConf({});
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(conf.split('\n').some(l => /^server=/.test(l))).toBe(false);
    settings.dns_no_recursion = 'false';
  });

  it('no-recursion overrides encryption (still no upstreams)', () => {
    settings.dns_no_recursion = 'true';
    settings.forwarder_encryption = 'tls';
    regenerateDnsmasqConf({});
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(conf).not.toContain('server=127.0.0.1#5356');
    expect(conf).not.toContain('server=8.8.8.8');
    settings.dns_no_recursion = 'false';
    settings.forwarder_encryption = 'off';
  });

  it('restores upstreams when recursion is re-enabled', () => {
    settings.dns_no_recursion = 'true';
    regenerateDnsmasqConf({});
    settings.dns_no_recursion = 'false';
    regenerateDnsmasqConf({});
    expect(fs.readFileSync(DNSMASQ_CONF, 'utf-8')).toContain('server=8.8.8.8');
  });
});

describe('regenerateDnsmasqConf: encrypted forwarding server= wiring', () => {
  it('uses plain upstream IPs when encryption is off', () => {
    settings.forwarder_encryption = 'off';
    regenerateDnsmasqConf({});
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(conf).toContain('server=8.8.8.8');
    expect(conf).toContain('server=9.9.9.9');
    expect(conf).not.toContain('server=127.0.0.1#5356');
  });

  it('points server= at the in-Node stub when encryption is tls', () => {
    settings.forwarder_encryption = 'tls';
    regenerateDnsmasqConf({});
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(conf).toContain('server=127.0.0.1#5356');
    expect(conf).not.toContain('server=8.8.8.8');
  });

  it('points server= at the stub when encryption is https, and reverts when off', () => {
    settings.forwarder_encryption = 'https';
    regenerateDnsmasqConf({});
    expect(fs.readFileSync(DNSMASQ_CONF, 'utf-8')).toContain('server=127.0.0.1#5356');
    settings.forwarder_encryption = 'off';
    regenerateDnsmasqConf({});
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(conf).toContain('server=8.8.8.8');
    expect(conf).not.toContain('server=127.0.0.1#5356');
  });
});

describe('regenerateDnsmasqConf: DNSSEC block', () => {
  it('emits no DNSSEC directives when dnssec_enabled is false', () => {
    regenerateDnsmasqConf({});
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(dnssecLines(conf)).toHaveLength(0);
    expect(conf).not.toContain('dnssec-check-unsigned');
    expect(conf).not.toContain('trust-anchor=');
    // upstream servers still present
    expect(conf).toContain('server=8.8.8.8');
  });

  it('injects the full DNSSEC block when enabled', () => {
    settings.dnssec_enabled = 'true';
    regenerateDnsmasqConf({});
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(dnssecLines(conf)).toHaveLength(1);
    expect(conf).toContain('dnssec-check-unsigned');
    expect(conf).toContain('dnssec-no-timecheck');
    // Either the distro trust-anchor file or the hardcoded root KSK fallback.
    const hasAnchor =
      conf.includes('conf-file=/usr/share/dnsmasq/trust-anchors.conf') ||
      conf.includes('trust-anchor=.,20326,8,2,');
    expect(hasAnchor).toBe(true);
  });

  it('is idempotent: repeated regen does not duplicate the block', () => {
    settings.dnssec_enabled = 'true';
    regenerateDnsmasqConf({});
    regenerateDnsmasqConf({});
    regenerateDnsmasqConf({});
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(dnssecLines(conf)).toHaveLength(1);
    expect(conf.match(/dnssec-no-timecheck/g)).toHaveLength(1);
    // server lines also not duplicated
    expect(conf.match(/server=8\.8\.8\.8/g)).toHaveLength(1);
  });

  it('strips the DNSSEC block when toggled back off', () => {
    settings.dnssec_enabled = 'true';
    regenerateDnsmasqConf({});
    expect(dnssecLines(fs.readFileSync(DNSMASQ_CONF, 'utf-8'))).toHaveLength(1);

    settings.dnssec_enabled = 'false';
    regenerateDnsmasqConf({});
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(dnssecLines(conf)).toHaveLength(0);
    expect(conf).not.toContain('dnssec-no-timecheck');
    expect(conf).not.toContain('trust-anchor=');
    expect(conf).not.toContain('conf-file=/usr/share/dnsmasq/trust-anchors.conf');
  });

  it('dnsmasqSupportsDnssec() detects the DNSSEC compile token', () => {
    expect(dnsmasqSupportsDnssec()).toBe(true);
  });
});

describe('regenerateDnsmasqConf: dnsmasq without DNSSEC support', () => {
  it('refuses to emit the block and reports unsupported', async () => {
    vi.resetModules();
    vi.mocked(execFileSync).mockReturnValue('Compile time options: IPv6 DHCP no-DNSSEC inotify');
    const fresh = await import('../../../src/utils/dnsmasq.js');

    fs.writeFileSync(DNSMASQ_CONF, BASE_CONF);
    settings = { dns_upstream_servers: ['1.1.1.1'], dnssec_enabled: 'true' };
    fresh.regenerateDnsmasqConf({});

    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(dnssecLines(conf)).toHaveLength(0);
    expect(conf).not.toContain('dnssec-no-timecheck');
    expect(fresh.dnsmasqSupportsDnssec()).toBe(false);
  });
});
