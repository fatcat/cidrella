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

function makeDb({ aRecords = [], otherRecords = [], ptrRecords = [] } = {}) {
  const zones = [{ id: 10, name: 'the-mcnultys.org' }];
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
