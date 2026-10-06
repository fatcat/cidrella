/**
 * Test doubles for the backend layer.
 *
 * Tests of routes and services that should not touch dnsmasq stub the apply
 * ops in services/backend-apply.js (the after-commit hooks run them):
 *
 *   vi.mock('<rel>/src/services/backend-apply.js', async (importOriginal) =>
 *     (await import('<rel>/helpers/fake-backends.js')).stubBackendApply(
 *       await importOriginal(),
 *       ['applyDns', 'applyDhcp'],
 *     ),
 *   );
 *
 * Ops not listed keep running for real. Stubbing applyDhcp also skips the DHCP
 * name sync it sequences.
 */
import { vi } from 'vitest';

export const APPLY_OPS = Object.freeze(['applyDns', 'applyDhcp', 'applyResolver']);

export function stubBackendApply(original, ops = APPLY_OPS) {
  const mod = { ...original };
  for (const op of ops) mod[op] = vi.fn();
  // The hooks call through the module object, so a test can assert on (or
  // re-stub) mod.applyDhcp and see the hook's calls.
  mod.HOOK_HANDLERS = {
    regenerate_dns: (db) => mod.applyDns(db),
    regenerate_dhcp: (db) => mod.applyDhcp(db),
    regenerate_dnsmasq_conf: (db) => mod.applyResolver(db),
  };
  return mod;
}

/**
 * An in-memory backend that keeps the contract (backends/contract.js): apply
 * ops snapshot what they read and report a change when it differs, leases are
 * whatever the test seeded. `applied` lists the activations performed.
 */
export function createFakeBackend({ name = 'fake', capabilities = {} } = {}) {
  const state = {};
  const applied = [];
  const watchers = new Set();
  let leases = [];

  const applyOp = (key, read, activationWhenChanged) => (db, opts) => {
    const next = JSON.stringify(read(db));
    const changed = next !== state[key];
    state[key] = next;
    const activation = changed ? activationWhenChanged : 'none';
    const activate = opts?.activate ?? true;
    if (activate && activation !== 'none') applied.push(activation);
    return { changed, activation, activated: activate && activation !== 'none' };
  };
  const settings = (db, keys) =>
    db
      .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`)
      .all(...keys);

  const backend = {
    name,
    roles: ['dns', 'dhcp', 'ra'],
    applied,
    dns: {
      applyZones: applyOp(
        'zones',
        (db) =>
          db
            .prepare(
              `SELECT z.name AS zone, r.name, r.type, r.value FROM dns_records r
               JOIN dns_zones z ON z.id = r.zone_id
               WHERE z.enabled = 1 AND r.enabled = 1 ORDER BY r.id`,
            )
            .all(),
        'reload',
      ),
      applyResolver: applyOp(
        'resolver',
        (db) =>
          settings(db, [
            'dns_upstream_servers',
            'dnssec_enabled',
            'forwarder_encryption',
            'dns_no_recursion',
          ]),
        'restart',
      ),
      applyListen: applyOp(
        'listen',
        (db) =>
          settings(db, [
            'interface_config',
            'dns_enabled',
            'dhcp_enabled',
            'dns_listen_port',
            'dns_proxy_bypass',
          ]),
        'restart',
      ),
      onClockSynchronized: () => applied.push('clock'),
    },
    dhcp: {
      applyScopes: applyOp(
        'scopes',
        (db) => ({
          pools: db
            .prepare(
              `SELECT p.scope_id, p.start_ip, p.end_ip FROM dhcp_scope_pools p
               JOIN dhcp_scopes s ON s.id = p.scope_id WHERE s.enabled = 1 ORDER BY p.id`,
            )
            .all(),
          reservations: db
            .prepare('SELECT ip_address, mac_address, duid FROM dhcp_reservations ORDER BY id')
            .all(),
        }),
        'restart',
      ),
      readLeases: async () => ({
        leases: leases.map((lease) => ({
          ...lease,
          mac: lease.mac?.toLowerCase() ?? null,
          duid: lease.duid?.toLowerCase() ?? null,
        })),
      }),
      watchLeases(onChange) {
        watchers.add(onChange);
        return () => watchers.delete(onChange);
      },
      releaseLease: (lease) =>
        lease?.ip_address ? { released: true } : { released: false, skipped: 'invalid-identity' },
      serverIdentity: () => ({ duid: null }),
    },
    ra: {},
    status: () => ({ name, running: true, restartPending: false }),
    capabilities: () => ({
      dnssec: false,
      routerAdvertisements: true,
      dhcpv6: true,
      leaseRelease: true,
      encryptedUpstream: false,
      ...capabilities,
    }),
    transaction: (fn) => fn(),
    applyActivation: (activation) => {
      if (activation !== 'none') applied.push(activation);
    },
    activate: ({ force = false } = {}) => (force ? 'restarted' : 'unchanged'),
    restart: () => applied.push('restart'),
    // Test hook: replace the lease set and tell the watchers.
    seedLeases(next) {
      leases = next;
      for (const onChange of watchers) onChange();
    },
  };
  return backend;
}
