import { describe, it, expect, vi, afterAll } from 'vitest';

// Settings the forwarder reads when it is (re)applied.
let settings = {};
vi.mock('../../../src/db/init.js', () => ({ getSetting: (key) => settings[key] }));
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const { applyEncryptedForwarder, stopEncryptedForwarder, firstUpstream } =
  await import('../../../src/utils/encrypted-forwarder.js');

const QUAD9 = { hostname: 'dns10.quad9.net', addresses: ['9.9.9.10', '2620:fe::10'] };
const ADGUARD = { hostname: 'unfiltered.adguard-dns.com', addresses: ['94.140.14.140'] };

// With recursion off the forwarder loads the list and the order but opens no
// listeners, so nothing here binds port 5356.
function apply(backupMode, upstreams = [QUAD9, ADGUARD]) {
  settings = {
    dns_no_recursion: 'true',
    forwarder_encryption: 'tls',
    forwarder_encrypted_upstreams: upstreams,
    dns_upstream_backup_mode: backupMode,
  };
  applyEncryptedForwarder();
}

afterAll(() => stopEncryptedForwarder());

describe('which encrypted upstream a query starts at', () => {
  it('always the primary under On failure', () => {
    apply('failover');
    expect([firstUpstream(), firstUpstream(), firstUpstream()]).toEqual([0, 0, 0]);
  });

  it('takes turns under Load balance', () => {
    apply('balance');
    const starts = [firstUpstream(), firstUpstream(), firstUpstream(), firstUpstream()];
    expect(new Set(starts)).toEqual(new Set([0, 1]));
    expect(starts[0]).not.toBe(starts[1]);
  });

  it('takes turns when the mode was never set, as before the toggle', () => {
    apply(undefined);
    expect(firstUpstream()).not.toBe(firstUpstream());
  });

  it('starts at the only upstream there is', () => {
    apply('balance', [QUAD9]);
    expect([firstUpstream(), firstUpstream()]).toEqual([0, 0]);
  });
});

// Plaintext goes through the same forwarder, the primary's addresses as one
// resolver and the backup's as the other.
describe('which plaintext resolver a query starts at', () => {
  it.each([
    ['IPv4', ['9.9.9.9', '149.112.112.112'], ['1.1.1.1']],
    ['IPv6', ['2620:fe::fe'], ['2606:4700:4700::1111']],
  ])('%s: primary first under On failure, turns under Load balance', (_f, primary, backup) => {
    const plain = (backupMode) => {
      settings = {
        dns_no_recursion: 'true',
        forwarder_encryption: 'off',
        dns_upstream_servers: primary,
        dns_upstream_backup_servers: backup,
        dns_upstream_backup_mode: backupMode,
      };
      applyEncryptedForwarder();
    };
    plain('failover');
    expect([firstUpstream(), firstUpstream()]).toEqual([0, 0]);
    plain('balance');
    expect(firstUpstream()).not.toBe(firstUpstream());
  });

  it('has one resolver without a backup', () => {
    settings = { dns_no_recursion: 'true', dns_upstream_servers: ['8.8.8.8'] };
    applyEncryptedForwarder();
    expect([firstUpstream(), firstUpstream()]).toEqual([0, 0]);
  });
});
