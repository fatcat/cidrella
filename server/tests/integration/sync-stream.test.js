/**
 * A snapshot moves as a stream (SYNC-SNAPSHOT-SIZE-01): the controller's
 * worker writes it to a file a piece at a time, the route sends that file
 * compressed as it reads it, and the member takes the lines in as they
 * arrive, spooled and checked against the trailer before any is applied.
 * Nothing on the way holds the dataset as one string or Buffer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { Readable } from 'stream';
import zlib from 'zlib';

// Every request for the changes is recorded, with what it resolved to.
const changeCalls = [];
vi.mock('../../src/utils/sync-client.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    syncRequest: async (request) => {
      const response = await real.syncRequest(request);
      if (String(request.path).startsWith('/api/sync/changes')) {
        changeCalls.push({ request, response });
      }
      return response;
    },
  };
});

const { setupTestDb, cleanupTestDb } = await import('../helpers/test-db.js');
const { databaseThrough, LATEST_MIGRATION } = await import('../helpers/migrations.js');
const { listenLocal } = await import('../helpers/free-port.js');
const { default: syncRoutes } = await import('../../src/routes/sync.js');
const { ensureSyncIdentity } = await import('../../src/sync/identity.js');
const { estateTables, syncStatus } = await import('../../src/sync/log.js');
const { joinController, syncOnce } = await import('../../src/sync/member.js');
const { createJoinToken } = await import('../../src/models/sync-instance.js');
const { applyChanges, exportChanges, exportChangesToFile, receiveChanges, spoolFile, SyncError } =
  await import('../../src/sync/changes.js');

let controller;
let controllerDir;
let identity;
let server;
let port;
// When set, answers GET /api/sync/changes in place of the route.
let tamper = null;
const tmpDirs = [];

// Big enough that the export, the transfer and the spool each take it in
// many pieces (they work a megabyte at a time).
const ROWS = 12000;

beforeAll(async () => {
  ({ db: controller, tmpDir: controllerDir } = await setupTestDb());
  identity = ensureSyncIdentity(controllerDir);
  const insert = controller.prepare('INSERT INTO folders (name, description) VALUES (?, ?)');
  controller.transaction(() => {
    for (let n = 0; n < ROWS; n += 1) insert.run(`folder-${n}`, `ünïcödé ${'x'.repeat(100)} ${n}`);
  })();
  const app = express();
  app.use(express.json());
  app.use('/api/sync/changes', (req, res, next) => (tamper ? tamper(req, res) : next()));
  app.use('/api/sync', syncRoutes);
  server = https.createServer(
    { key: fs.readFileSync(identity.keyPath), cert: fs.readFileSync(identity.certPath) },
    app,
  );
  port = await listenLocal(server);
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupTestDb(controllerDir);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function newBox() {
  const { db, tmpDir } = databaseThrough(LATEST_MIGRATION, { tmpDirs });
  ensureSyncIdentity(tmpDir);
  return { db, dir: tmpDir };
}

function estate(db) {
  return Object.fromEntries(
    estateTables(db).map((table) => [
      table.name,
      db
        .prepare(
          `SELECT ${table.columns.join(', ')} FROM ${table.name} AS r
           WHERE ${table.isEstateRow('r')} ORDER BY ${table.key}`,
        )
        .all(),
    ]),
  );
}

// Spool files left in a box's sync directory.
const spools = (dir) =>
  fs.existsSync(path.join(dir, 'sync'))
    ? fs.readdirSync(path.join(dir, 'sync')).filter((name) => name.startsWith('changes-'))
    : [];

const snapshotBytes = () => exportChanges(controller, {});

describe('a snapshot through the route and the member code', () => {
  let box;
  beforeAll(async () => {
    box = newBox();
    changeCalls.length = 0;
    const { token } = createJoinToken(controller, { fingerprint: identity.fingerprint });
    await joinController(box.db, { address: '127.0.0.1', port, token }, { restart: () => {} });
  });

  it('joins with every row, taken in as a stream and never as one Buffer', () => {
    expect(snapshotBytes().length).toBeGreaterThan(2 * 1024 * 1024);
    expect(estate(box.db)).toEqual(estate(controller));
    expect(changeCalls).toHaveLength(1);
    const [{ request, response }] = changeCalls;
    expect(typeof request.consume).toBe('function');
    expect(Buffer.isBuffer(response.body)).toBe(false);
    expect(response.body.header).toMatchObject({ snapshot: true });
    expect(spools(box.dir)).toEqual([]);
    expect(spools(controllerDir)).toEqual([]);
  });

  it('takes a later snapshot and a delta the same way', async () => {
    controller.prepare("INSERT INTO folders (name) VALUES ('after-join')").run();
    box.db.prepare("DELETE FROM sync_state WHERE key = 'cursor'").run();
    changeCalls.length = 0;
    expect(await syncOnce(box.db)).toBe('current');
    expect(changeCalls[0].response.body.header.snapshot).toBe(true);

    controller.prepare("UPDATE folders SET description = 'changed' WHERE name = 'folder-7'").run();
    expect(await syncOnce(box.db)).toBe('current');
    expect(changeCalls[1].response.body.header.snapshot).toBe(false);
    expect(typeof changeCalls[1].request.consume).toBe('function');

    expect(estate(box.db)).toEqual(estate(controller));
    expect(spools(box.dir)).toEqual([]);
    expect(spools(controllerDir)).toEqual([]);
  });

  describe('refuses a stream that is not whole, and changes nothing', () => {
    const refusals = [
      [
        'a byte changed on the way',
        (bytes) => {
          const flipped = Buffer.from(bytes);
          flipped[Math.floor(flipped.length / 2)] ^= 1;
          return flipped;
        },
        'damaged',
      ],
      ['the trailer cut off', (bytes) => bytes.subarray(0, bytes.length - 40), 'damaged'],
      ['a row cut off in the middle', (bytes) => bytes.subarray(0, bytes.length / 3), 'damaged'],
    ];
    it.each(refusals)('%s', async (_name, spoil, code) => {
      const before = estate(box.db);
      const cursor = syncStatus(box.db).head;
      tamper = (req, res) => {
        res.set({ 'Content-Type': 'application/x-ndjson', 'Content-Encoding': 'gzip' });
        res.send(zlib.gzipSync(spoil(snapshotBytes())));
      };
      try {
        const err = await syncOnce(box.db).catch((e) => e);
        expect(err).toBeInstanceOf(SyncError);
        expect(err.code).toBe(code);
      } finally {
        tamper = null;
      }
      expect(estate(box.db)).toEqual(before);
      expect(syncStatus(box.db).head).toBe(cursor);
      expect(spools(box.dir)).toEqual([]);
    });

    it('a connection that drops partway', async () => {
      const before = estate(box.db);
      tamper = (req, res) => {
        const body = zlib.gzipSync(snapshotBytes());
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Content-Encoding': 'gzip',
          'Content-Length': body.length,
        });
        res.write(body.subarray(0, body.length / 2));
        setTimeout(() => res.destroy(), 20);
      };
      try {
        const err = await syncOnce(box.db).catch((e) => e);
        expect(err.code).toBe('unreachable');
      } finally {
        tamper = null;
      }
      expect(estate(box.db)).toEqual(before);
      expect(spools(box.dir)).toEqual([]);
    });
  });
});

describe('exportChangesToFile and receiveChanges', () => {
  let dir;
  beforeAll(() => {
    dir = path.join(controllerDir, 'stream-unit');
  });

  // The file's bytes, in pieces of `size` bytes, as a stream.
  const inPieces = (bytes, size) => {
    const pieces = [];
    for (let at = 0; at < bytes.length; at += size) pieces.push(bytes.subarray(at, at + size));
    return Readable.from(pieces);
  };

  it('writes what exportChanges does, and reads it back split anywhere', async () => {
    const out = spoolFile(dir);
    const spool = spoolFile(dir);
    try {
      expect(exportChangesToFile(controller, {}, out)).toMatchObject({ snapshot: true });
      const bytes = fs.readFileSync(out);
      expect(bytes.equals(snapshotBytes())).toBe(true);

      // Seven bytes at a time splits lines and multi-byte characters.
      const received = await receiveChanges(inPieces(bytes, 7), spool);
      const copy = newBox();
      const result = applyChanges(copy.db, received);
      expect(result.snapshot).toBe(true);
      expect(result.rows).toBe(JSON.parse(bytes.toString().trimEnd().split('\n').pop()).rows);
      expect(estate(copy.db)).toEqual(estate(controller));
    } finally {
      fs.rmSync(out, { force: true });
      fs.rmSync(spool, { force: true });
    }
  });

  it('refuses a stream with a byte changed, and one cut short', async () => {
    const bytes = snapshotBytes();
    const flipped = Buffer.from(bytes);
    flipped[100] ^= 1;
    for (const spoiled of [flipped, bytes.subarray(0, bytes.length - 2), Buffer.alloc(0)]) {
      const spool = spoolFile(dir);
      try {
        await expect(receiveChanges(inPieces(spoiled, 4096), spool)).rejects.toMatchObject({
          name: 'SyncError',
          code: 'damaged',
        });
      } finally {
        fs.rmSync(spool, { force: true });
      }
    }
  });

  it('passes on an error the stream emits before it starts reading, and nothing is uncaught', async () => {
    const spool = spoolFile(dir);
    const broken = new Readable({ read() {} });
    const receiving = receiveChanges(broken, spool);
    // The file is still being opened.
    broken.destroy(Object.assign(new Error('gone'), { code: 'unreachable' }));
    try {
      await expect(receiving).rejects.toMatchObject({ code: 'unreachable' });
    } finally {
      fs.rmSync(spool, { force: true });
    }
  });

  it('passes an error of the stream through as it is', async () => {
    const spool = spoolFile(dir);
    const broken = new Readable({ read() {} });
    broken.push(snapshotBytes().subarray(0, 1000));
    setTimeout(() => broken.destroy(Object.assign(new Error('gone'), { code: 'unreachable' })), 5);
    try {
      await expect(receiveChanges(broken, spool)).rejects.toMatchObject({ code: 'unreachable' });
    } finally {
      fs.rmSync(spool, { force: true });
    }
  });
});
