/**
 * The controller reading a member's DNS and DHCP daemon logs: the member
 * answers its own controller alone (a call proof, sync/identity-proof.js),
 * hands over its tail and what was written since an offset, and the
 * controller turns that into the stream its Logs page reads, saying so when
 * the member does not answer. Both families of instance address.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

vi.mock('../../src/db/init.js', async (importOriginal) =>
  (await import('../helpers/instances.js')).perInstanceDb(await importOriginal()),
);
vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { box, estate, useEstates } = await import('../helpers/instance-estate.js');
const { backend } = await import('../../src/backends/index.js');
const { getDb } = await import('../../src/db/init.js');
const { default: logsRoutes } = await import('../../src/routes/logs.js');
const { CALL_PROOF_HEADER, callProof } = await import('../../src/sync/identity-proof.js');
const { EPOCH_HEADER, callMemberAsController } = await import('../../src/sync/controller-call.js');
const { readSyncState, writeSyncState } = await import('../../src/sync/log.js');
const { syncRequest } = await import('../../src/utils/sync-client.js');
const { listenLocal } = await import('../helpers/free-port.js');

useEstates();

// Each box's log is a file beside its database, found through the database
// of the instance being served.
const logOf = (one) => path.join(path.dirname(one.db.name), 'backend.log');
const DNS_LINE = (n) => `query[A] host${n}.lab.test from 10.5.0.9`;
const DHCP_LINE = (n) => `DHCPACK(eth0) 10.5.0.${n} aa:bb:cc:00:00:01`;

let controller;
let member;
let peer;
let web;
let webPort;
let asked = 0;
const extraServers = [];

beforeAll(async () => {
  backend.logSource = () => ({
    path: path.join(path.dirname(getDb().name), 'backend.log'),
    isDhcpLine: (line) => line.startsWith('DHCP'),
    querySourceIp: () => null,
    dhcpMessage: () => null,
    createDhcpParser: () => null,
  });
  [controller, member, peer] = await estate('ctl', 'member-a', 'member-b');
  member.app.use('/api/sync/logs', (req, res, next) => {
    asked += 1;
    next();
  });
  for (const one of [controller, member, peer]) {
    one.app.use('/api/logs', logsRoutes);
    fs.writeFileSync(logOf(one), [DNS_LINE(1), DHCP_LINE(1), ''].join('\n'));
  }
  // The browser reaches the controller over plain HTTP here.
  web = http.createServer(controller.app);
  extraServers.push(web);
  webPort = await listenLocal(web);
});

afterAll(async () => {
  for (const server of extraServers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

const memberRow = () =>
  controller.db.prepare('SELECT * FROM sync_instances WHERE instance_id = ?').get(member.id);

// A request to `to`'s /api/sync/logs, made as `from` (its identity signs the proof).
function askLogs(from, to, query, { epoch = '1', proof = true } = {}) {
  const headers = { [EPOCH_HEADER]: epoch };
  if (proof) headers[CALL_PROOF_HEADER] = callProof(from.dir, to.identity.fingerprint, 'logs');
  return syncRequest({
    address: '127.0.0.1',
    port: to.port,
    fingerprint: to.identity.fingerprint,
    path: `/api/sync/logs?${query}`,
    headers,
  }).then((response) => ({
    status: response.status,
    body: JSON.parse(response.body.toString('utf8')),
  }));
}

/**
 * Read the controller's SSE stream until `done(text)` holds or `ms` pass.
 * Returns the events read: `{ lines, events, text }`.
 */
async function readStream(query, done, ms = 8000, during = async () => {}) {
  const controllerAbort = new AbortController();
  const res = await fetch(`http://127.0.0.1:${webPort}/api/logs/stream?${query}`, {
    signal: controllerAbort.signal,
  });
  if (res.status !== 200) return { status: res.status, body: await res.json() };
  const reader = res.body.getReader();
  let text = '';
  const deadline = Date.now() + ms;
  let ran = false;
  // One read at a time: a read left behind by the race below still holds the
  // next chunk, so it is kept for the next turn rather than asked again.
  let pending = null;
  while (!done(text) && Date.now() < deadline) {
    pending ??= reader.read();
    const next = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve({ idle: true }), 200)),
    ]);
    if (next.idle) continue;
    pending = null;
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
    if (!ran && text.includes('event: connected')) {
      ran = true;
      await during(text);
    }
  }
  controllerAbort.abort();
  const lines = [...text.matchAll(/^data: (.*)$/gm)]
    .map((m) => m[1])
    .filter((l) => !['ok', 'unreachable', 'live'].includes(l));
  const events = [...text.matchAll(/^event: (.*)\ndata: (.*)$/gm)].map((m) => `${m[1]}:${m[2]}`);
  return { status: 200, lines, events, text };
}

describe('GET /api/logs/sources on a controller with members', () => {
  it('lists this box first, then every member', async () => {
    const res = await fetch(`http://127.0.0.1:${webPort}/api/logs/sources`).then((r) => r.json());
    expect(res.instances.map((i) => i.name)).toEqual(['ctl', 'member-a', 'member-b']);
    expect(res.instances[0].instance_id).toBe(controller.id);
    expect(res.sources.map((s) => s.clearable)).toEqual([true, true]);
  });

  it("answers a member's sources by asking it, nothing clearable", async () => {
    const res = await fetch(
      `http://127.0.0.1:${webPort}/api/logs/sources?instance=${member.id}`,
    ).then((r) => r.json());
    expect(res.sources).toEqual([
      { role: 'dns', label: 'fake', available: true, clearable: false, message: null },
      { role: 'dhcp', label: 'fake', available: true, clearable: false, message: null },
    ]);
    expect(res.instances).toHaveLength(3);
  });

  it('offers no other instance on a member', async () => {
    const { default: request } = await import('supertest');
    const body = (await request(member.app).get('/api/logs/sources')).body;
    expect(body.instances).toEqual([]);
    expect((await request(member.app).get(`/api/logs/sources?instance=${peer.id}`)).status).toBe(
      404,
    );
  });
});

describe('GET /api/sync/logs on a member', () => {
  it('gives its own controller the tail of a role, then what was written since', async () => {
    const dns = await askLogs(controller, member, 'role=dns');
    expect(dns).toMatchObject({ status: 200, body: { lines: [DNS_LINE(1)] } });
    // One log serves both roles here: each role gets its own lines.
    const dhcp = await askLogs(controller, member, 'role=dhcp');
    expect(dhcp.body.lines).toEqual([DHCP_LINE(1)]);

    fs.appendFileSync(logOf(member), `${DNS_LINE(2)}\n${DHCP_LINE(2)}\npartial`);
    const since = await askLogs(controller, member, `role=dhcp&after=${dhcp.body.offset}`);
    // A line still being written is left for the next ask.
    expect(since.body.lines).toEqual([DHCP_LINE(2)]);
    expect(since.body.offset).toBe(fs.statSync(logOf(member)).size - 'partial'.length);

    // A log cleared on the member is read again from its start.
    fs.writeFileSync(logOf(member), `${DNS_LINE(3)}\n`);
    const reset = await askLogs(controller, member, `role=dns&after=${since.body.offset}`);
    expect(reset.body).toEqual({ lines: [DNS_LINE(3)], offset: DNS_LINE(3).length + 1 });
  });

  it('refuses a bad role or offset', async () => {
    expect((await askLogs(controller, member, 'role=ra')).status).toBe(400);
    expect((await askLogs(controller, member, 'role=dns&after=-1')).status).toBe(400);
    expect((await askLogs(controller, member, 'role=dns&after=x')).status).toBe(400);
  });

  it('refuses a stranger, another member, and a caller without a proof', async () => {
    const stranger = await box('stranger');
    expect((await askLogs(stranger, member, 'role=dns')).status).toBe(401);
    // On the list of the estate, but not the controller this member follows.
    expect((await askLogs(peer, member, 'role=dns')).status).toBe(401);
    expect((await askLogs(controller, member, 'role=dns', { proof: false })).status).toBe(401);
    // A controller follows nobody, so nobody may ask it this way.
    expect((await askLogs(member, controller, 'role=dns')).status).toBe(401);
  });

  it('refuses a controller that speaks for an older epoch than the member knows', async () => {
    const was = readSyncState(member.db, 'epoch');
    writeSyncState(member.db, 'epoch', '5');
    try {
      expect((await askLogs(controller, member, 'role=dns', { epoch: '4' })).status).toBe(409);
      expect((await askLogs(controller, member, 'role=dns', { epoch: '5' })).status).toBe(200);
    } finally {
      writeSyncState(member.db, 'epoch', was ?? '1');
    }
    expect((await askLogs(controller, member, 'role=dns', { epoch: '' })).status).toBe(409);
  });
});

describe("GET /api/logs/stream for a member's log", () => {
  it("streams the member's tail and then its new lines, both roles", async () => {
    fs.writeFileSync(logOf(member), [DNS_LINE(10), DHCP_LINE(10), ''].join('\n'));
    const dhcp = await readStream(
      `role=dhcp&instance=${member.id}`,
      (text) => text.includes(DHCP_LINE(11)),
      8000,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        fs.appendFileSync(logOf(member), `${DNS_LINE(11)}\n${DHCP_LINE(11)}\n`);
      },
    );
    expect(dhcp.lines).toEqual([DHCP_LINE(10), DHCP_LINE(11)]);
    expect(dhcp.events).toContain('backlog-end:ok');

    const dns = await readStream(`role=dns&instance=${member.id}`, (text) =>
      text.includes('backlog-end'),
    );
    expect(dns.lines).toEqual([DNS_LINE(10), DNS_LINE(11)]);
  });

  it('says when the member does not answer, keeps asking, and stops when the browser goes', async () => {
    await member.unplug();
    let replugged = false;
    const result = await readStream(
      `role=dns&instance=${member.id}`,
      (text) => text.includes('data: live') && text.includes(DNS_LINE(12)),
      12000,
      async () => {
        // Back after the first ask has failed.
        setTimeout(async () => {
          fs.appendFileSync(logOf(member), `${DNS_LINE(12)}\n`);
          await member.listen();
          replugged = true;
        }, 2500);
      },
    );
    expect(replugged).toBe(true);
    expect(result.events.slice(0, 3)).toEqual([
      'connected:ok',
      'watch-status:unreachable',
      'watch-status:live',
    ]);
    expect(result.lines).toContain(DNS_LINE(12));

    // The browser has gone: the controller stops asking.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = asked;
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(asked).toBe(before);
  }, 20000);

  it('reaches a member at an IPv6 address', async () => {
    const server = https.createServer(
      {
        key: fs.readFileSync(member.identity.keyPath),
        cert: fs.readFileSync(member.identity.certPath),
      },
      member.app,
    );
    extraServers.push(server);
    await new Promise((resolve) => server.listen(0, '::1', resolve));
    const was = memberRow();
    controller.db
      .prepare('UPDATE sync_instances SET address = ?, port = ? WHERE instance_id = ?')
      .run('::1', server.address().port, member.id);
    try {
      const response = await callMemberAsController(controller.db, memberRow(), 'logs', {
        path: '/api/sync/logs?role=dns',
      });
      expect(response.status).toBe(200);
      const stream = await readStream(`role=dns&instance=${member.id}`, (text) =>
        text.includes('backlog-end'),
      );
      expect(stream.lines).toContain(DNS_LINE(12));
    } finally {
      controller.db
        .prepare('UPDATE sync_instances SET address = ?, port = ? WHERE instance_id = ?')
        .run(was.address, was.port, member.id);
    }
  });

  it('answers an IPv4 member the same way', async () => {
    expect(memberRow().address).toBe('127.0.0.1');
    const response = await callMemberAsController(controller.db, memberRow(), 'logs', {
      path: '/api/sync/logs/sources',
    });
    expect(response.status).toBe(200);
  });
});

describe("POST /api/logs/clear for a member's log", () => {
  it('is refused: a member clears its own log', async () => {
    const before = fs.readFileSync(logOf(member), 'utf8');
    const res = await fetch(`http://127.0.0.1:${webPort}/api/logs/clear?instance=${member.id}`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Clear this log on member-a');
    expect(fs.readFileSync(logOf(member), 'utf8')).toBe(before);
  });
});
