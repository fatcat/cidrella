import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

let tmpDir;
let regenerateConfigs;

function makeDb({ aRecords = [], otherRecords = [], ptrRecords = [], zone = {} } = {}) {
  const zones = [{ id: 10, name: 'the-mcnultys.org', ...zone }];
  return {
    prepare(sql) {
      return {
        all() {
          if (sql.includes('FROM dns_zones')) return zones;
          if (sql.includes("type = 'A'")) return aRecords;
          if (sql.includes("type NOT IN ('A', 'PTR')")) return otherRecords;
          if (sql.includes("type = 'PTR'")) return ptrRecords;
          return [];
        }
      };
    }
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-dnsmasq-test-'));
  process.env.DATA_DIR = tmpDir;
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'hosts.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'conf.d'), { recursive: true });
  ({ regenerateConfigs } = await import('../../../src/utils/dnsmasq.js'));
});

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(path.join(tmpDir, 'dnsmasq', 'hosts.d'), { recursive: true, force: true });
  fs.rmSync(path.join(tmpDir, 'dnsmasq', 'conf.d'), { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'hosts.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'conf.d'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('regenerateConfigs reload behavior', () => {
  it('reloads dnsmasq for hostsdir-only changes', () => {
    regenerateConfigs(makeDb({
      aRecords: [{ name: 'container-host', value: '10.0.3.231' }],
    }));

    expect(execFileSync).toHaveBeenCalledWith(
      'systemctl',
      ['reload', 'cidrella-dnsmasq'],
      { stdio: 'pipe' }
    );
    expect(execFileSync).not.toHaveBeenCalledWith(
      'systemctl',
      ['restart', 'cidrella-dnsmasq'],
      { stdio: 'pipe' }
    );
  });

  it('restarts dnsmasq for conf-dir CNAME changes', () => {
    regenerateConfigs(makeDb({
      otherRecords: [{
        name: 'checker',
        type: 'CNAME',
        value: 'container-host.the-mcnultys.org',
        ttl: null,
      }],
    }));

    expect(fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf'), 'utf-8'))
      .toContain('cname=checker.the-mcnultys.org,container-host.the-mcnultys.org');
    expect(execFileSync).toHaveBeenCalledWith(
      'systemctl',
      ['restart', 'cidrella-dnsmasq'],
      { stdio: 'pipe' }
    );
  });

  it('does not append the zone twice for legacy fully-qualified CNAME names', () => {
    regenerateConfigs(makeDb({
      otherRecords: [{
        name: 'checker.the-mcnultys.org',
        type: 'CNAME',
        value: 'container-host.the-mcnultys.org',
        ttl: null,
      }],
    }));

    const conf = fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf'), 'utf-8');
    expect(conf).toContain('cname=checker.the-mcnultys.org,container-host.the-mcnultys.org');
    expect(conf).not.toContain('checker.the-mcnultys.org.the-mcnultys.org');
  });

  it('preserves trailing dots for external absolute A-record names', () => {
    regenerateConfigs(makeDb({
      aRecords: [{ name: 'host.google.com.', value: '10.0.3.232' }],
    }));

    const hosts = fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'hosts.d', 'zone-10.hosts'), 'utf-8');
    expect(hosts).toContain('10.0.3.232 host.google.com.');
    expect(hosts).not.toContain('host.google.com.the-mcnultys.org');
  });
});

describe('comment-only conf changes do not touch dnsmasq', () => {
  // Regression: DHCP lease churn bumps dns_zones.soa_serial, the serial rides
  // along in a `# SOA:` comment in every zone-*.conf, and change detection used
  // a byte-exact compare. Result in the field was dnsmasq restarting roughly
  // every 18 seconds (~4800/day), flushing the DNS cache each time, while the
  // directives in the file never changed.
  const SOA = {
    soa_primary_ns: 'ns1.the-mcnultys.org',
    soa_admin_email: 'admin.the-mcnultys.org',
    soa_refresh: 3600,
    soa_retry: 900,
    soa_expire: 604800,
    soa_minimum_ttl: 900,
  };
  const CNAME = [{
    name: 'checker',
    type: 'CNAME',
    value: 'container-host.the-mcnultys.org',
    ttl: null,
  }];
  const CONF = () => path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf');

  function restarts() {
    return vi.mocked(execFileSync).mock.calls
      .filter(([cmd, args]) => cmd === 'systemctl' && args?.[0] === 'restart').length;
  }
  function reloads() {
    return vi.mocked(execFileSync).mock.calls
      .filter(([cmd, args]) => cmd === 'systemctl' && args?.[0] === 'reload').length;
  }

  it('rewrites the file but does not restart when only the SOA serial moved', () => {
    // First pass establishes the file and legitimately restarts.
    regenerateConfigs(makeDb({ otherRecords: CNAME, zone: { ...SOA, soa_serial: 860436 } }));
    expect(fs.readFileSync(CONF(), 'utf-8')).toContain('860436');
    expect(restarts()).toBe(1);

    // Lease churn bumped the serial. Nothing else about the zone changed.
    vi.clearAllMocks();
    regenerateConfigs(makeDb({ otherRecords: CNAME, zone: { ...SOA, soa_serial: 860439 } }));

    const conf = fs.readFileSync(CONF(), 'utf-8');
    expect(conf).toContain('860439');        // comment stays truthful
    expect(conf).toContain('cname=checker.the-mcnultys.org,container-host.the-mcnultys.org');
    expect(restarts()).toBe(0);              // ...but the daemon is left alone
    expect(reloads()).toBe(0);
  });

  it('still restarts when a real directive changes alongside the serial', () => {
    regenerateConfigs(makeDb({ otherRecords: CNAME, zone: { ...SOA, soa_serial: 1 } }));
    vi.clearAllMocks();

    regenerateConfigs(makeDb({
      otherRecords: [...CNAME, { name: 'mail', type: 'MX', value: 'mx1.the-mcnultys.org', priority: 10, ttl: null }],
      zone: { ...SOA, soa_serial: 2 },
    }));

    expect(fs.readFileSync(CONF(), 'utf-8')).toContain('mx-host=mail.the-mcnultys.org,mx1.the-mcnultys.org,10');
    expect(restarts()).toBe(1);
  });

  it('is fully idempotent when nothing at all changed', () => {
    const db = () => makeDb({ otherRecords: CNAME, zone: { ...SOA, soa_serial: 7 } });
    regenerateConfigs(db());
    const after = fs.readFileSync(CONF(), 'utf-8');
    vi.clearAllMocks();

    regenerateConfigs(db());
    expect(fs.readFileSync(CONF(), 'utf-8')).toBe(after);
    expect(restarts()).toBe(0);
    expect(reloads()).toBe(0);
  });

  it('treats a commented-out directive as a real change, not a comment', () => {
    // Guard against a lazy "ignore anything with a #" implementation: dropping a
    // directive behind a `#` genuinely disables it and must reach the daemon.
    regenerateConfigs(makeDb({ otherRecords: CNAME, zone: { ...SOA, soa_serial: 1 } }));
    vi.clearAllMocks();

    // Same serial, but the CNAME is gone. The zone now has only a PTR.
    regenerateConfigs(makeDb({
      ptrRecords: [{ name: '231', value: 'container-host.the-mcnultys.org' }],
      zone: { ...SOA, soa_serial: 1 },
    }));

    const conf = fs.readFileSync(CONF(), 'utf-8');
    expect(conf).not.toContain('cname=');
    expect(restarts()).toBe(1);
  });
});

describe('TXT record escaping', () => {
  it('escapes backslashes so a trailing backslash cannot swallow the closing quote', () => {
    regenerateConfigs(makeDb({
      otherRecords: [{ name: 'spf', type: 'TXT', value: 'v=spf1 a:mail.example.com \\', ttl: null }],
    }));

    const conf = fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf'), 'utf-8');
    expect(conf).toContain('txt-record=spf.the-mcnultys.org,"v=spf1 a:mail.example.com \\\\"');
  });

  it('escapes quotes and backslashes independently', () => {
    regenerateConfigs(makeDb({
      otherRecords: [{ name: 'meta', type: 'TXT', value: 'say "hi" via C:\\path', ttl: null }],
    }));

    const conf = fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf'), 'utf-8');
    expect(conf).toContain('txt-record=meta.the-mcnultys.org,"say \\"hi\\" via C:\\\\path"');
  });
});
