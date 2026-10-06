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
let applyZones;

function makeDb({ aRecords = [], otherRecords = [], ptrRecords = [], zone = {} } = {}) {
  const zones = [{ id: 10, name: 'the-mcnultys.org', ...zone }];
  // The hosts writer reads records joined to their zone.
  const inZone = (rows) => rows.map((row) => ({ zone_name: zones[0].name, ...row }));
  aRecords = inZone(aRecords);
  ptrRecords = inZone(ptrRecords);
  return {
    prepare(sql) {
      return {
        all() {
          if (sql.includes('FROM dns_zones')) return zones;
          if (sql.includes("type IN ('A', 'AAAA')")) return aRecords;
          if (sql.includes("type NOT IN ('A', 'AAAA', 'PTR')")) return otherRecords;
          if (sql.includes("type = 'PTR'")) return ptrRecords;
          return [];
        },
      };
    },
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-dnsmasq-test-'));
  process.env.DATA_DIR = tmpDir;
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'hosts.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'conf.d'), { recursive: true });
  const { createDnsmasqBackend } = await import('../../../../src/backends/dnsmasq/index.js');
  ({ applyZones } = createDnsmasqBackend().dns);
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

describe('applyZones reload behavior', () => {
  it('reloads dnsmasq for hostsdir-only changes', () => {
    applyZones(
      makeDb({
        aRecords: [{ name: 'container-host', value: '10.0.3.231' }],
      }),
    );

    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['reload', 'cidrella-dnsmasq'], {
      stdio: 'pipe',
    });
    expect(execFileSync).not.toHaveBeenCalledWith('systemctl', ['restart', 'cidrella-dnsmasq'], {
      stdio: 'pipe',
    });
  });

  it('restarts dnsmasq for conf-dir CNAME changes', () => {
    applyZones(
      makeDb({
        otherRecords: [
          {
            name: 'checker',
            type: 'CNAME',
            value: 'container-host.the-mcnultys.org',
            ttl: null,
          },
        ],
      }),
    );

    expect(
      fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf'), 'utf-8'),
    ).toContain('cname=checker.the-mcnultys.org,container-host.the-mcnultys.org');
    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['restart', 'cidrella-dnsmasq'], {
      stdio: 'pipe',
    });
  });

  it('does not append the zone twice for legacy fully-qualified CNAME names', () => {
    applyZones(
      makeDb({
        otherRecords: [
          {
            name: 'checker.the-mcnultys.org',
            type: 'CNAME',
            value: 'container-host.the-mcnultys.org',
            ttl: null,
          },
        ],
      }),
    );

    const conf = fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf'), 'utf-8');
    expect(conf).toContain('cname=checker.the-mcnultys.org,container-host.the-mcnultys.org');
    expect(conf).not.toContain('checker.the-mcnultys.org.the-mcnultys.org');
  });

  // A trailing dot marks the name absolute (zone-file rule); the hosts line
  // carries the name without it, which dnsmasq reads the same either way.
  it('writes an absolute A-record name outside the zone without the zone', () => {
    applyZones(
      makeDb({
        aRecords: [{ name: 'host.google.com.', value: '10.0.3.232' }],
      }),
    );

    const hosts = fs.readFileSync(
      path.join(tmpDir, 'dnsmasq', 'hosts.d', 'records.hosts'),
      'utf-8',
    );
    expect(hosts).toMatch(/^10\.0\.3\.232 host\.google\.com$/m);
    expect(hosts).not.toContain('the-mcnultys.org');
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
  const CNAME = [
    {
      name: 'checker',
      type: 'CNAME',
      value: 'container-host.the-mcnultys.org',
      ttl: null,
    },
  ];
  const CONF = () => path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf');

  function restarts() {
    return vi
      .mocked(execFileSync)
      .mock.calls.filter(([cmd, args]) => cmd === 'systemctl' && args?.[0] === 'restart').length;
  }
  function reloads() {
    return vi
      .mocked(execFileSync)
      .mock.calls.filter(([cmd, args]) => cmd === 'systemctl' && args?.[0] === 'reload').length;
  }

  it('rewrites the file but does not restart when only the SOA serial moved', () => {
    // First pass establishes the file and legitimately restarts.
    applyZones(makeDb({ otherRecords: CNAME, zone: { ...SOA, soa_serial: 860436 } }));
    expect(fs.readFileSync(CONF(), 'utf-8')).toContain('860436');
    expect(restarts()).toBe(1);

    // Lease churn bumped the serial. Nothing else about the zone changed.
    vi.clearAllMocks();
    applyZones(makeDb({ otherRecords: CNAME, zone: { ...SOA, soa_serial: 860439 } }));

    const conf = fs.readFileSync(CONF(), 'utf-8');
    expect(conf).toContain('860439'); // comment stays truthful
    expect(conf).toContain('cname=checker.the-mcnultys.org,container-host.the-mcnultys.org');
    expect(restarts()).toBe(0); // ...but the daemon is left alone
    expect(reloads()).toBe(0);
  });

  it('still restarts when a real directive changes alongside the serial', () => {
    applyZones(makeDb({ otherRecords: CNAME, zone: { ...SOA, soa_serial: 1 } }));
    vi.clearAllMocks();

    applyZones(
      makeDb({
        otherRecords: [
          ...CNAME,
          { name: 'mail', type: 'MX', value: 'mx1.the-mcnultys.org', priority: 10, ttl: null },
        ],
        zone: { ...SOA, soa_serial: 2 },
      }),
    );

    expect(fs.readFileSync(CONF(), 'utf-8')).toContain(
      'mx-host=mail.the-mcnultys.org,mx1.the-mcnultys.org,10',
    );
    expect(restarts()).toBe(1);
  });

  it('is fully idempotent when nothing at all changed', () => {
    const db = () => makeDb({ otherRecords: CNAME, zone: { ...SOA, soa_serial: 7 } });
    applyZones(db());
    const after = fs.readFileSync(CONF(), 'utf-8');
    vi.clearAllMocks();

    applyZones(db());
    expect(fs.readFileSync(CONF(), 'utf-8')).toBe(after);
    expect(restarts()).toBe(0);
    expect(reloads()).toBe(0);
  });

  it('treats a commented-out directive as a real change, not a comment', () => {
    // Guard against a lazy "ignore anything with a #" implementation: dropping a
    // directive behind a `#` genuinely disables it and must reach the daemon.
    applyZones(makeDb({ otherRecords: CNAME, zone: { ...SOA, soa_serial: 1 } }));
    vi.clearAllMocks();

    // Same serial, but the CNAME is gone. The zone now has only a PTR.
    applyZones(
      makeDb({
        ptrRecords: [{ name: '231', value: 'container-host.the-mcnultys.org' }],
        zone: { ...SOA, soa_serial: 1 },
      }),
    );

    const conf = fs.readFileSync(CONF(), 'utf-8');
    expect(conf).not.toContain('cname=');
    expect(restarts()).toBe(1);
  });
});

describe('TXT record escaping', () => {
  it('escapes backslashes so a trailing backslash cannot swallow the closing quote', () => {
    applyZones(
      makeDb({
        otherRecords: [
          { name: 'spf', type: 'TXT', value: 'v=spf1 a:mail.example.com \\', ttl: null },
        ],
      }),
    );

    const conf = fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf'), 'utf-8');
    expect(conf).toContain('txt-record=spf.the-mcnultys.org,"v=spf1 a:mail.example.com \\\\"');
  });

  it('escapes quotes and backslashes independently', () => {
    applyZones(
      makeDb({
        otherRecords: [{ name: 'meta', type: 'TXT', value: 'say "hi" via C:\\path', ttl: null }],
      }),
    );

    const conf = fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf'), 'utf-8');
    expect(conf).toContain('txt-record=meta.the-mcnultys.org,"say \\"hi\\" via C:\\\\path"');
  });
});

describe('IPv6 emission', () => {
  it('writes AAAA hosts lines and nibble ptr-record lines, skipping IPv6 placeholders', () => {
    applyZones(
      makeDb({
        aRecords: [
          { name: 'host4', value: '10.0.3.231' },
          { name: 'host6', value: 'fd00:6::10' },
        ],
        ptrRecords: [
          { name: '0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0', value: 'host6.the-mcnultys.org' },
          { name: '1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0', value: 'fd00:6::11' },
        ],
      }),
    );
    const hosts = fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'hosts.d', 'records.hosts'), 'utf8');
    expect(hosts).toContain('10.0.3.231 host4.the-mcnultys.org');
    expect(hosts).toContain('fd00:6::10 host6.the-mcnultys.org');
    const conf = fs.readFileSync(path.join(tmpDir, 'dnsmasq', 'conf.d', 'zone-10.conf'), 'utf8');
    expect(conf).toContain(
      'ptr-record=0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.the-mcnultys.org,host6.the-mcnultys.org',
    );
    expect(conf).not.toContain('fd00:6::11');
  });
});

describe('atomicWrite', () => {
  it('writes through a dot-named temp file dnsmasq skips (DNSMASQ-01)', async () => {
    const { atomicWrite } = await import('../../../../src/backends/dnsmasq/dnsmasq.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-atomic-'));
    const target = path.join(dir, 'reservations.hosts');
    const rename = vi.spyOn(fs, 'renameSync');
    try {
      atomicWrite(target, 'aa:bb:cc:00:00:01,10.0.0.5,host,infinite\n');
      const [from, to] = rename.mock.calls.at(-1);
      expect(to).toBe(target);
      expect(path.dirname(from)).toBe(dir);
      // dnsmasq ignores names that start with '.' in a watched directory.
      expect(path.basename(from)).toBe(`.reservations.hosts.tmp.${process.pid}`);
      expect(fs.readdirSync(dir)).toEqual(['reservations.hosts']);
      expect(fs.readFileSync(target, 'utf8')).toBe('aa:bb:cc:00:00:01,10.0.0.5,host,infinite\n');
    } finally {
      rename.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
