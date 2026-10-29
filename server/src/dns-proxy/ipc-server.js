/**
 * The proxy process's end of the socket to the web app (protocol.js), and the
 * outbox that holds what the proxy reports while the web app is away.
 *
 * One client at a time: a new connection replaces the old one, so a web app
 * that restarted is never shut out by its own dead predecessor. The socket is
 * created owner-only.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { encode, createDecoder } from './protocol.js';
import { socketPathTooLong } from './constants.js';

// Is something answering on this socket now?
function answering(socketPath) {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

/**
 * Listen on `socketPath`. `onMessage(message)` gets each message from the
 * client, `onConnect()` and `onDisconnect()` its comings and goings. `send`
 * returns false when there is no client or the client is not keeping up;
 * the caller keeps what it could not send.
 */
export function createIpcServer({ socketPath, onMessage, onConnect, onDisconnect, log }) {
  let server = null;
  let client = null;
  let backedUp = false;

  function drop(sock) {
    if (client !== sock) return;
    client = null;
    backedUp = false;
    onDisconnect?.();
  }

  function accept(sock) {
    if (client) {
      log?.('info', 'A new web app connection replaces the old one');
      const old = client;
      client = null;
      old.destroy();
    }
    client = sock;
    backedUp = false;
    sock.on(
      'data',
      createDecoder(
        (message) => {
          if (client === sock) onMessage(message);
        },
        (err) => {
          log?.('warn', 'Closing the web app connection', { error: err.message });
          sock.destroy();
        },
      ),
    );
    sock.on('drain', () => {
      if (client === sock) backedUp = false;
    });
    sock.on('error', () => {});
    sock.on('close', () => drop(sock));
    onConnect?.();
  }

  return {
    async listen() {
      const tooLong = socketPathTooLong(socketPath);
      if (tooLong) throw new Error(tooLong);
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(socketPath)) {
        if (await answering(socketPath)) {
          throw new Error(`another DNS proxy answers on ${socketPath}`);
        }
        fs.unlinkSync(socketPath);
      }
      server = net.createServer(accept);
      const umask = process.umask(0o177);
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(socketPath, () => {
            server.off('error', reject);
            resolve();
          });
        });
      } finally {
        process.umask(umask);
      }
    },
    // `always` is for the small replies the web app waits on (hello, status,
    // a drain): they go out even while the reports are backed up.
    send(message, { always = false } = {}) {
      if (!client || (backedUp && !always)) return false;
      if (!client.write(encode(message))) backedUp = true;
      return true;
    },
    connected: () => client !== null,
    close() {
      client?.destroy();
      client = null;
      server?.close();
      server = null;
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
    },
  };
}

export const OUTBOX_LIMITS = { rows: 50_000, resolutions: 2_000, liveness: 10_000 };
export const OUTBOX_BATCH = 500;

// A queue that drops its oldest entries past `limit`, without copying the
// array on every push once it is full.
function boundedQueue(limit) {
  let items = [];
  let head = 0;
  let dropped = 0;
  return {
    push(item) {
      items.push(item);
      if (items.length - head > limit) {
        head++;
        dropped++;
      }
      if (head > limit) {
        items = items.slice(head);
        head = 0;
      }
    },
    take(n) {
      const out = items.slice(head, head + n);
      head += out.length;
      if (head === items.length) {
        items = [];
        head = 0;
      }
      return out;
    },
    // Put back what could not be sent, ahead of anything newer.
    unshift(batch) {
      items = batch.concat(items.slice(head));
      head = 0;
      while (items.length > limit) {
        items.shift();
        dropped++;
      }
    },
    size: () => items.length - head,
    dropped: () => dropped,
  };
}

/**
 * What the proxy reports, held until the web app takes it: analytics rows,
 * Resolution Map events, and client addresses seen (each address once).
 * Each kind is bounded; past its limit the oldest go and are counted.
 */
export function createOutbox(limits = OUTBOX_LIMITS) {
  const rows = boundedQueue(limits.rows);
  const resolutions = boundedQueue(limits.resolutions);
  let liveness = new Set();
  let livenessDropped = 0;

  return {
    row: (entry) => rows.push(entry),
    resolution: (event) => resolutions.push(event),
    client(ip) {
      if (liveness.has(ip)) return;
      liveness.add(ip);
      if (liveness.size > limits.liveness) {
        liveness.delete(liveness.values().next().value);
        livenessDropped++;
      }
    },
    rowCount: () => rows.size(),
    /** Send what is held, in batches, for as long as `send` takes them. */
    flush(send) {
      for (const [queue, type, key] of [
        [rows, 'rows', 'rows'],
        [resolutions, 'resolutions', 'events'],
      ]) {
        while (queue.size() > 0) {
          const batch = queue.take(OUTBOX_BATCH);
          if (!send({ type, [key]: batch })) {
            queue.unshift(batch);
            return;
          }
        }
      }
      if (liveness.size > 0) {
        const clients = [...liveness];
        if (send({ type: 'liveness', clients })) liveness = new Set();
      }
    },
    dropped: () => ({
      rows: rows.dropped(),
      resolutions: resolutions.dropped(),
      liveness: livenessDropped,
    }),
  };
}
