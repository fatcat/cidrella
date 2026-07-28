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

const BASE_CONF = [
  'no-resolv',
  'server=8.8.8.8',
  'server=9.9.9.9',
  'listen-address=127.0.0.1',
  'bind-dynamic',
  '',
].join('\n');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-changedet-test-'));
  process.env.DATA_DIR = tmpDir;
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq'), { recursive: true });
  DNSMASQ_CONF = path.join(tmpDir, 'dnsmasq', 'dnsmasq.conf');
  vi.mocked(execFileSync).mockReturnValue('Compile time options: IPv6 DHCP DNSSEC inotify');
  ({ regenerateDnsmasqConf, applyInterfaceConfig } = await import('../../../src/utils/dnsmasq.js'));
});

beforeEach(() => {
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

  it('returns true and writes when the upstreams changed', () => {
    settings.dns_upstream_servers = ['1.1.1.1'];
    expect(regenerateDnsmasqConf({})).toBe(true);
    const conf = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
    expect(conf).toContain('server=1.1.1.1');
    expect(conf).not.toContain('server=8.8.8.8');
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
    expect(regenerateDnsmasqConf({})).toBe(true);
    expect(fs.readFileSync(DNSMASQ_CONF, 'utf-8')).toContain('server=127.0.0.1#5356');

    // Second pass with identical settings must be a no-op.
    expect(regenerateDnsmasqConf({})).toBe(false);
  });

  it('keeps a hand-written comment in dnsmasq.conf and reports no change', () => {
    fs.writeFileSync(DNSMASQ_CONF, `# operator note: do not remove bind-dynamic\n${BASE_CONF}`);
    expect(regenerateDnsmasqConf({})).toBe(false);
    expect(fs.readFileSync(DNSMASQ_CONF, 'utf-8'))
      .toContain('# operator note: do not remove bind-dynamic');
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
