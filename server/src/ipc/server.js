/**
 * The listening end of a CIDRella process socket (framing.js): the DNS proxy
 * and the privileged helper each run one, and the web app is the client.
 *
 * One client at a time: a new connection replaces the old one, so a web app
 * that restarted is never shut out by its own dead predecessor. The socket
 * file gets `mode` (owner-only unless the caller widens it).
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { encode, createDecoder } from './framing.js';

// A Unix socket path holds at most 107 bytes, and a longer one is cut short
// without an error; both ends refuse one instead.
export const MAX_SOCKET_PATH_BYTES = 107;

/** Why `socketPath` cannot be used, or null. `name` says whose socket it is. */
export function socketPathTooLong(socketPath, name) {
  const bytes = Buffer.byteLength(socketPath);
  return bytes > MAX_SOCKET_PATH_BYTES
    ? `the ${name} socket path is ${bytes} bytes, more than a Unix socket path holds (${MAX_SOCKET_PATH_BYTES}): ${socketPath}`
    : null;
}

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
export function createIpcServer({
  socketPath,
  name,
  mode = 0o600,
  onMessage,
  onConnect,
  onDisconnect,
  log,
}) {
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
      const tooLong = socketPathTooLong(socketPath, name);
      if (tooLong) throw new Error(tooLong);
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(socketPath)) {
        if (await answering(socketPath)) {
          throw new Error(`another ${name} answers on ${socketPath}`);
        }
        fs.unlinkSync(socketPath);
      }
      server = net.createServer(accept);
      // The socket is created with the mode from the start, never wider.
      const umask = process.umask(0o777 & ~mode);
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

// A queue that drops its oldest entries past `limit`, without copying the
// array on every push once it is full.
export function boundedQueue(limit) {
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
