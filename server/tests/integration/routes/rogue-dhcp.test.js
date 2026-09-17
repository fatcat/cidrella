import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

// Mock the probe engines so route tests don't touch sockets or the kernel.
vi.mock('../../../src/utils/dhcp-probe.js', () => ({
  getProbeState: vi.fn(() => ({ lastProbeAt: '2026-06-08T00:00:00.000Z', probeSupported: true })),
}));
vi.mock('../../../src/utils/dhcpv6-probe.js', () => ({
  getProbe6State: vi.fn(() => ({
    lastProbeAt: '2026-06-08T00:00:00.000Z',
    probeSupported: true,
    probeInProgress: false,
    lastProbeOutcome: 'ok',
    lastProbeError: null,
  })),
}));
vi.mock('../../../src/utils/ra-monitor.js', () => ({
  getRaState: vi.fn(() => ({
    lastCheckAt: '2026-06-08T00:00:00.000Z',
    lastOutcome: 'ok',
    lastError: null,
    supported: true,
    supportedInterfaces: ['eth0'],
    unsupportedInterfaces: [],
  })),
}));
vi.mock('../../../src/utils/rogue-detection.js', () => ({
  runRogueDetection: vi.fn(async () => ({
    dhcp: { supported: true, interfaces: 1, offers: 2, rogues: [] },
    dhcpv6: { supported: true, interfaces: 1, advertisements: 1, rogues: [] },
    routerAdvertisements: { supported: true, interfaces: 1, routers: 1, rogues: [] },
  })),
}));

const { default: rogueRouter } = await import('../../../src/routes/rogue-dhcp.js');
const { getProbeState } = await import('../../../src/utils/dhcp-probe.js');
const { runRogueDetection: runProbe } = await import('../../../src/utils/rogue-detection.js');
const RogueDhcp = await import('../../../src/models/rogue-dhcp.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createTestApp(rogueRouter, '/api/dhcp/rogue');
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  db.exec('DELETE FROM rogue_dhcp_events; DELETE FROM dhcp_authorized_servers;');
  vi.mocked(runProbe).mockClear();
});

describe('GET /status', () => {
  it('returns enabled/interval/probe state shape', async () => {
    const res = await request(app).get('/api/dhcp/rogue/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('enabled');
    expect(res.body).toHaveProperty('intervalMin');
    expect(res.body).toHaveProperty('probeSupported', true);
    expect(res.body).toHaveProperty('unacknowledged', 0);
    expect(res.body.dhcpv6).toMatchObject({ probeSupported: true, lastProbeOutcome: 'ok' });
    expect(res.body.routerAdvertisements).toMatchObject({
      supported: true,
      supportedInterfaces: ['eth0'],
    });
  });

  // A clean probe logs nothing, so "healthy but quiet" and "has not run in
  // weeks" are indistinguishable unless the status endpoint says which it is.
  it('reports stale when detection is enabled but the last probe is ancient', async () => {
    await request(app).put('/api/dhcp/rogue/settings').send({ enabled: true, intervalMin: 15 });
    const res = await request(app).get('/api/dhcp/rogue/status');
    expect(res.body.stale).toBe(true);
    expect(res.body.healthy).toBe(false);
  });

  it('is not stale when detection is switched off', async () => {
    await request(app).put('/api/dhcp/rogue/settings').send({ enabled: false });
    const res = await request(app).get('/api/dhcp/rogue/status');
    expect(res.body.stale).toBe(false);
    expect(res.body.healthy).toBe(true);
  });

  it('does not cry stale in the first moments after a restart', async () => {
    // lastProbeAt is per-process, so it is null until the scheduler's initial
    // kick lands. That must not read as "nothing is watching".
    vi.mocked(getProbeState).mockReturnValueOnce({ lastProbeAt: null, probeSupported: true });
    const uptime = vi.spyOn(process, 'uptime').mockReturnValue(5);
    await request(app).put('/api/dhcp/rogue/settings').send({ enabled: true, intervalMin: 15 });
    const res = await request(app).get('/api/dhcp/rogue/status');
    expect(res.body.stale).toBe(false);
    uptime.mockRestore();
  });

  it('does report stale when nothing has probed long after boot', async () => {
    vi.mocked(getProbeState).mockReturnValueOnce({ lastProbeAt: null, probeSupported: true });
    const uptime = vi.spyOn(process, 'uptime').mockReturnValue(3600);
    await request(app).put('/api/dhcp/rogue/settings').send({ enabled: true, intervalMin: 15 });
    const res = await request(app).get('/api/dhcp/rogue/status');
    expect(res.body.stale).toBe(true);
    uptime.mockRestore();
  });
});

describe('PUT /settings', () => {
  it('enables detection and sets the interval', async () => {
    const res = await request(app)
      .put('/api/dhcp/rogue/settings')
      .send({ enabled: true, intervalMin: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, intervalMin: 30 });
  });

  it('rejects an out-of-range interval', async () => {
    const res = await request(app).put('/api/dhcp/rogue/settings').send({ intervalMin: 2 });
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean enabled', async () => {
    const res = await request(app).put('/api/dhcp/rogue/settings').send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });
});

describe('authorized-server allowlist', () => {
  it('adds, lists, and deletes', async () => {
    const add = await request(app)
      .post('/api/dhcp/rogue/authorized')
      .send({ server_ip: '10.0.0.1', server_mac: 'aa:bb:cc:dd:ee:ff', description: 'core router' });
    expect(add.status).toBe(201);
    const id = add.body.id;

    const list = await request(app).get('/api/dhcp/rogue/authorized');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].server_ip).toBe('10.0.0.1');

    const del = await request(app).delete(`/api/dhcp/rogue/authorized/${id}`);
    expect(del.status).toBe(200);
    expect((await request(app).get('/api/dhcp/rogue/authorized')).body).toHaveLength(0);
  });

  it('rejects an invalid IP', async () => {
    const res = await request(app)
      .post('/api/dhcp/rogue/authorized')
      .send({ server_ip: 'not-an-ip' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid MAC', async () => {
    const res = await request(app)
      .post('/api/dhcp/rogue/authorized')
      .send({ server_ip: '10.0.0.5', server_mac: 'zz' });
    expect(res.status).toBe(400);
  });

  it('409s on a duplicate IP', async () => {
    await request(app).post('/api/dhcp/rogue/authorized').send({ server_ip: '10.0.0.7' });
    const dup = await request(app)
      .post('/api/dhcp/rogue/authorized')
      .send({ server_ip: '10.0.0.7' });
    expect(dup.status).toBe(409);
  });

  it('accepts an IPv6 link-local and stores it canonically', async () => {
    const res = await request(app)
      .post('/api/dhcp/rogue/authorized')
      .send({ server_ip: 'FE80:0:0:0:0:0:0:1', description: 'edge router' });
    expect(res.status).toBe(201);
    const list = await request(app).get('/api/dhcp/rogue/authorized');
    expect(list.body[0].server_ip).toBe('fe80::1');
  });

  it('authorizes a DHCPv6 server by DUID alone, and 409s on the same DUID again', async () => {
    const res = await request(app)
      .post('/api/dhcp/rogue/authorized')
      .send({ server_duid: '00:01:00:01:2A:2B:2C:2D:AA:BB:CC:DD:EE:FF' });
    expect(res.status).toBe(201);
    const list = await request(app).get('/api/dhcp/rogue/authorized');
    expect(list.body[0]).toMatchObject({
      server_ip: null,
      server_duid: '00:01:00:01:2a:2b:2c:2d:aa:bb:cc:dd:ee:ff',
    });
    const dup = await request(app)
      .post('/api/dhcp/rogue/authorized')
      .send({ server_duid: '00:01:00:01:2a:2b:2c:2d:aa:bb:cc:dd:ee:ff' });
    expect(dup.status).toBe(409);
  });

  it('authorizes a router by MAC alone, once', async () => {
    const first = await request(app)
      .post('/api/dhcp/rogue/authorized')
      .send({ server_mac: 'AA:BB:CC:DD:EE:11' });
    expect(first.status).toBe(201);
    const dup = await request(app)
      .post('/api/dhcp/rogue/authorized')
      .send({ server_mac: 'aa:bb:cc:dd:ee:11' });
    expect(dup.status).toBe(409);
    expect((await request(app).get('/api/dhcp/rogue/authorized')).body[0].server_mac).toBe(
      'aa:bb:cc:dd:ee:11',
    );
  });

  it('rejects an entry with no identity at all, and a malformed DUID', async () => {
    const empty = await request(app).post('/api/dhcp/rogue/authorized').send({ description: 'x' });
    expect(empty.status).toBe(400);
    const bad = await request(app)
      .post('/api/dhcp/rogue/authorized')
      .send({ server_duid: '00:zz' });
    expect(bad.status).toBe(400);
  });
});

describe('events', () => {
  it('lists, acknowledges, and clears detected rogues', async () => {
    RogueDhcp.upsertRogueEvent(db, {
      server_ip: '10.0.0.250',
      server_identifier: '10.0.0.250',
      offered_gateway: '10.0.0.250',
      offered_dns: '10.0.0.250',
      iface: 'eth0',
    });

    const list = await request(app).get('/api/dhcp/rogue/events');
    expect(list.body).toHaveLength(1);
    const id = list.body[0].id;
    expect(list.body[0].acknowledged).toBe(0);

    const ack = await request(app).post(`/api/dhcp/rogue/events/${id}/acknowledge`);
    expect(ack.status).toBe(200);
    expect((await request(app).get('/api/dhcp/rogue/events')).body[0].acknowledged).toBe(1);

    const clear = await request(app).delete(`/api/dhcp/rogue/events/${id}`);
    expect(clear.status).toBe(200);
    expect((await request(app).get('/api/dhcp/rogue/events')).body).toHaveLength(0);
  });

  it('keeps DHCPv6 and Router Advertisement findings from the same host apart', async () => {
    RogueDhcp.upsertRogueEvent(db, {
      kind: 'dhcpv6',
      server_ip: 'fe80::bad',
      server_mac: 'de:ad:be:ef:00:01',
      server_duid: '00:01:00:01:2a:2b:2c:2d:de:ad:be:ef:00:01',
      offered_ip: 'fd00:1234::1500',
      offered_dns: 'fd00:1234::bad',
      iface: 'eth0',
    });
    RogueDhcp.upsertRogueEvent(db, {
      kind: 'ra',
      server_ip: 'fe80::bad',
      server_mac: 'de:ad:be:ef:00:01',
      offered_gateway: 'fe80::bad',
      advertised_prefixes: '2001:db8:bad::/64',
      iface: 'eth0',
    });
    const list = await request(app).get('/api/dhcp/rogue/events');
    expect(list.body).toHaveLength(2);
    const byKind = Object.fromEntries(list.body.map((e) => [e.kind, e]));
    expect(byKind.dhcpv6).toMatchObject({
      address_family: 6,
      server_duid: '00:01:00:01:2a:2b:2c:2d:de:ad:be:ef:00:01',
      offered_ip: 'fd00:1234::1500',
    });
    expect(byKind.ra).toMatchObject({
      address_family: 6,
      advertised_prefixes: '2001:db8:bad::/64',
    });
  });

  it('acknowledge-all silences every unacknowledged event', async () => {
    RogueDhcp.upsertRogueEvent(db, { server_ip: '10.0.0.251', iface: 'eth0' });
    RogueDhcp.upsertRogueEvent(db, { server_ip: '10.0.0.252', iface: 'eth0' });
    const res = await request(app).post('/api/dhcp/rogue/acknowledge-all');
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(2);
    expect(RogueDhcp.countUnacknowledged(db)).toBe(0);
  });

  it('upsert dedups on server_ip and bumps times_seen', async () => {
    RogueDhcp.upsertRogueEvent(db, { server_ip: '10.0.0.253', iface: 'eth0' });
    RogueDhcp.upsertRogueEvent(db, { server_ip: '10.0.0.253', iface: 'eth1' });
    const rows = RogueDhcp.listEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].times_seen).toBe(2);
  });
});

describe('POST /probe', () => {
  it('invokes the probe and returns a summary', async () => {
    const res = await request(app).post('/api/dhcp/rogue/probe');
    expect(res.status).toBe(200);
    expect(runProbe).toHaveBeenCalled();
    expect(res.body).toMatchObject({ supported: true, interfaces: 1, offers: 2, rogueCount: 0 });
    expect(res.body.skipped).toBe(false);
  });

  // A skipped run found nothing because it never looked. Reporting that as a
  // successful scan is the whole reason a dead prober can go unnoticed.
  it('says the probe was skipped instead of reporting a clean scan', async () => {
    vi.mocked(runProbe).mockResolvedValueOnce({
      dhcp: {
        supported: true,
        skipped: true,
        skipReason: 'in-progress',
        interfaces: 0,
        offers: 0,
        rogues: [],
      },
      dhcpv6: { supported: true, interfaces: 0, advertisements: 0, rogues: [] },
      routerAdvertisements: { supported: true, interfaces: 0, routers: 0, rogues: [] },
    });
    const res = await request(app).post('/api/dhcp/rogue/probe');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ skipped: true, skipReason: 'in-progress' });
  });

  it('reports each IPv6 detector on its own, and counts every kind of rogue', async () => {
    vi.mocked(runProbe).mockResolvedValueOnce({
      dhcp: { supported: true, interfaces: 1, offers: 1, rogues: [{ server_ip: '10.0.0.9' }] },
      dhcpv6: {
        supported: false,
        error: 'cannot bind UDP :546 (EACCES)',
        interfaces: 0,
        advertisements: 0,
        rogues: [],
      },
      routerAdvertisements: {
        supported: true,
        interfaces: 1,
        routers: 2,
        rogues: [{ server_ip: 'fe80::bad' }],
      },
    });
    const res = await request(app).post('/api/dhcp/rogue/probe');
    expect(res.status).toBe(200);
    expect(res.body.rogueCount).toBe(2);
    expect(res.body.dhcpv6).toMatchObject({
      supported: false,
      error: 'cannot bind UDP :546 (EACCES)',
    });
    expect(res.body.routerAdvertisements).toMatchObject({ routers: 2, rogueCount: 1 });
  });

  it('names the failure when the probe cannot start', async () => {
    vi.mocked(runProbe).mockRejectedValueOnce(new Error('interface enumeration blew up'));
    const res = await request(app).post('/api/dhcp/rogue/probe');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('interface enumeration blew up');
  });
});
