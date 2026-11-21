/**
 * With members, the DNS servers a scope serves are every DNS-serving
 * instance, through the one place both DHCP adapters read (loadDhcpScopes),
 * and nothing stored changes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../helpers/test-db.js');
const { seedBackendEstate } = await import('../../helpers/backend-estate.js');
const { loadDhcpScopes } = await import('../../../src/backends/shared/dhcp-scope-model.js');
const { getScopeWithDetails } = await import('../../../src/models/dhcp-scope.js');
const { addMember, dnsInstances, ensureOwnInstance, setDnsAddresses } =
  await import('../../../src/models/sync-instance.js');

const { deleteSetting, upsertSetting } = await import('../../../src/models/setting.js');

let db;
let tmpDir;
let v4Scope;
let v6Scope;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  seedBackendEstate(db);
  v4Scope = db
    .prepare(
      "SELECT s.id FROM dhcp_scopes s JOIN subnets n ON n.id = s.subnet_id WHERE n.cidr = '10.60.0.0/24'",
    )
    .get().id;
  v6Scope = db
    .prepare(
      "SELECT s.id FROM dhcp_scopes s JOIN subnets n ON n.id = s.subnet_id WHERE n.cidr = 'fd00:63::/64'",
    )
    .get().id;
  const put = db.prepare(
    `INSERT INTO dhcp_scope_options (scope_id, option_code, value, address_family) VALUES (?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET value = excluded.value`,
  );
  db.prepare('DELETE FROM dhcp_scope_options WHERE option_code IN (6, 23)').run();
  put.run(v4Scope, 6, '10.60.0.2', 4);
  put.run(v6Scope, 23, 'fd00:63::2', 6);
  ensureOwnInstance(db, {
    fingerprint: 'aa'.repeat(32),
    port: 443,
    version: 'test',
    dnsAddresses: ['10.60.0.2', 'fd00:63::2', 'fe80::1', 'junk'],
  });
});
afterAll(() => cleanupTestDb(tmpDir));

// getScopeWithDetails resolves what the scope serves, as the DHCP pages read it.
const served = (scopeId, code) =>
  String(
    getScopeWithDetails(db, scopeId).effective.options.find((o) => o.option_code === code)?.value,
  );
const rendered = (cidr) =>
  JSON.stringify(loadDhcpScopes(db).find((entry) => entry.scope.subnet_cidr === cidr).options);

describe('the DNS servers a scope serves', () => {
  it('is what is stored on a single box', () => {
    expect(dnsInstances(db)).toHaveLength(1);
    expect(dnsInstances(db)[0].addresses).toEqual(['10.60.0.2', 'fd00:63::2']);
    expect(served(v4Scope, 6)).toBe('10.60.0.2');
    expect(served(v6Scope, 23)).toBe('fd00:63::2');
  });

  it('is every instance once a member answers DNS, both families and both adapters’ input', () => {
    addMember(db, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      name: 'member-b',
      address: '10.60.0.3',
      port: 443,
      fingerprint: 'bb'.repeat(32),
      version: 'test',
      schema: 1,
    });
    const member = db.prepare("SELECT id FROM sync_instances WHERE name = 'member-b'").get().id;
    expect(setDnsAddresses(db, member, ['10.60.0.3', 'fd00:63::3'])).toBe(true);
    expect(setDnsAddresses(db, member, ['10.60.0.3', 'fd00:63::3'])).toBe(false);

    expect(served(v4Scope, 6)).toBe('10.60.0.2,10.60.0.3');
    expect(served(v6Scope, 23)).toBe('fd00:63::2,fd00:63::3');
    expect(rendered('10.60.0.0/24')).toContain('10.60.0.3');
    expect(rendered('fd00:63::/64')).toContain('fd00:63::3');
    // Nothing stored changed.
    expect(
      db
        .prepare(
          'SELECT value FROM dhcp_scope_options WHERE option_code IN (6, 23) ORDER BY option_code',
        )
        .all(),
    ).toEqual([{ value: '10.60.0.2' }, { value: 'fd00:63::2' }]);
  });

  it('leaves out an instance that does not serve DNS', () => {
    db.prepare("UPDATE sync_instances SET serves_dns = 0 WHERE name = 'member-b'").run();
    expect(served(v4Scope, 6)).toBe('10.60.0.2');
    expect(served(v6Scope, 23)).toBe('fd00:63::2');
    db.prepare("UPDATE sync_instances SET serves_dns = 1 WHERE name = 'member-b'").run();
  });

  it('puts the instance that serves DHCP first, both families and both adapters’ input', () => {
    // DHCP moved to the member (sync/dhcp-active.js): its clients reach it for sure.
    upsertSetting(db, 'dhcp_active_instance', '11111111-1111-4111-8111-111111111111');
    expect(dnsInstances(db).map((instance) => instance.name)[0]).toBe('member-b');
    expect(served(v4Scope, 6)).toBe('10.60.0.3,10.60.0.2');
    expect(served(v6Scope, 23)).toBe('fd00:63::3,fd00:63::2');
    expect(rendered('10.60.0.0/24')).toContain('"10.60.0.3","10.60.0.2"');
    expect(rendered('fd00:63::/64')).toContain('"fd00:63::3","fd00:63::2"');
    // Back on the controller, the controller is first again.
    deleteSetting(db, 'dhcp_active_instance');
    expect(served(v4Scope, 6)).toBe('10.60.0.2,10.60.0.3');
    expect(served(v6Scope, 23)).toBe('fd00:63::2,fd00:63::3');
  });

  it('leaves a scope pointed at other resolvers alone', () => {
    db.prepare("UPDATE dhcp_scope_options SET value = '9.9.9.9' WHERE option_code = 6").run();
    db.prepare("UPDATE dhcp_scope_options SET value = '2620:fe::fe' WHERE option_code = 23").run();
    expect(served(v4Scope, 6)).toBe('9.9.9.9');
    expect(served(v6Scope, 23)).toBe('2620:fe::fe');
  });
});
