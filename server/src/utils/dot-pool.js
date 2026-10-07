/**
 * DNS-over-TLS connections the encrypted forwarder keeps open and reuses.
 *
 * A fresh TCP + TLS handshake per query cost about 46 ms an answer against a
 * 10 ms round trip to the upstream. One connection per upstream address now
 * carries every query, pipelined (RFC 7858, RFC 7766): each query gets an ID
 * unique on its connection, the reply is matched back by that ID, and the
 * client's own ID is restored before it is returned. A connection closes
 * after IDLE_MS with nothing in flight, and a reconnect offers the TLS session
 * ticket from the last one.
 *
 * Failure stays closed: every path resolves null (the forwarder answers
 * SERVFAIL), never a plaintext fallback.
 * - A connection that closes after it was open, with a query in flight, is
 *   the server ending an idle connection as we wrote to it; that query is
 *   retried once on a new connection.
 * - A connection that never opens, a certificate that fails verification
 *   included, moves to the upstream's next address. Nothing unverified is
 *   ever used.
 * - A timeout is final.
 */
import tls from 'tls';
import { extractTcpMessages, frameTcpMessage } from './dns-wire.js';

const DOT_PORT = 853;
const IDLE_MS = 30_000;

// Why a query got no answer on a connection.
const FAIL = Object.freeze({
  CONNECT: 'connect', // the connection never opened
  CLOSED: 'closed', // it was open, then closed with this query in flight
  TIMEOUT: 'timeout',
});

class DotConnection {
  constructor({ address, hostname, port, timeoutMs, idleMs, tlsOptions, session, onSession }) {
    this.pending = new Map(); // wire id -> { originalId, resolve, timer }
    this.queued = []; // frames written once the handshake completes
    this.nextId = Math.floor(Math.random() * 0x10000);
    this.buf = Buffer.alloc(0);
    this.open = false;
    this.ended = false;
    this.failure = null;
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.idleTimer = null;
    this.socket = tls.connect({
      host: address,
      port,
      servername: hostname,
      ...(session ? { session } : {}),
      ...tlsOptions,
    });
    this.socket.on('session', onSession);
    this.socket.on('secureConnect', () => {
      // Validated against the system CA store and `servername`; any failure
      // leaves `authorized` false.
      if (!this.socket.authorized) {
        this.failure = {
          kind: FAIL.CONNECT,
          error: this.socket.authorizationError || new Error('certificate not authorized'),
        };
        this.socket.destroy();
        return;
      }
      this.open = true;
      for (const frame of this.queued) this.socket.write(frame);
      this.queued = [];
    });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (error) => {
      this.failure ||= { kind: this.open ? FAIL.CLOSED : FAIL.CONNECT, error };
    });
    this.socket.on('close', () => this.end());
  }

  get usable() {
    return !this.ended;
  }

  allocateId() {
    for (let i = 0; i < 0x10000; i++) {
      const id = this.nextId;
      this.nextId = (this.nextId + 1) & 0xffff;
      if (!this.pending.has(id)) return id;
    }
    return null;
  }

  /** Resolves { response } or { fail, error }. */
  send(query) {
    return new Promise((resolve) => {
      const id = this.allocateId();
      if (id === null) return resolve({ fail: FAIL.CLOSED, error: new Error('no free query id') });
      clearTimeout(this.idleTimer);
      const wire = Buffer.from(query);
      wire.writeUInt16BE(id, 0);
      const timer = setTimeout(() => {
        this.settle(id, { fail: FAIL.TIMEOUT, error: new Error('DoT timeout') });
      }, this.timeoutMs);
      this.pending.set(id, { originalId: query.readUInt16BE(0), resolve, timer });
      const frame = frameTcpMessage(wire);
      if (this.open) this.socket.write(frame);
      else this.queued.push(frame);
    });
  }

  settle(id, result) {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(result);
    if (this.pending.size === 0 && !this.ended) {
      this.idleTimer = setTimeout(() => this.socket.destroy(), this.idleMs);
      this.idleTimer.unref?.();
    }
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const { messages, rest } = extractTcpMessages(this.buf);
    this.buf = rest;
    for (const message of messages) {
      if (message.length < 2) continue;
      const entry = this.pending.get(message.readUInt16BE(0));
      if (!entry) continue; // a late reply to a query that already timed out
      const response = Buffer.from(message);
      response.writeUInt16BE(entry.originalId, 0);
      this.settle(message.readUInt16BE(0), { response });
    }
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    const failure = this.failure || {
      kind: this.open ? FAIL.CLOSED : FAIL.CONNECT,
      error: new Error('connection closed'),
    };
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { fail: failure.kind, error: failure.error });
    }
  }

  close() {
    this.socket.destroy();
  }
}

/**
 * @param {object} [opts]
 * @param {number} opts.timeoutMs   per query
 * @param {(error: Error, upstream: object, address: string|null) => void} [opts.onError]
 *   every failed attempt
 * @param {number} [opts.port]      853 except in tests
 * @param {number} [opts.idleMs]
 * @param {object} [opts.tlsOptions] extra tls.connect options (tests pass `ca`)
 */
export function createDotPool({
  timeoutMs,
  onError = () => {},
  port = DOT_PORT,
  idleMs = IDLE_MS,
  tlsOptions = {},
}) {
  const connections = new Map(); // `${address}|${hostname}` -> DotConnection
  const sessions = new Map(); // same key -> TLS session ticket

  function connectionFor(address, hostname) {
    const key = `${address}|${hostname}`;
    let connection = connections.get(key);
    if (!connection?.usable) {
      connection = new DotConnection({
        address,
        hostname,
        port,
        timeoutMs,
        idleMs,
        tlsOptions,
        session: sessions.get(key),
        onSession: (session) => sessions.set(key, session),
      });
      connections.set(key, connection);
    }
    return connection;
  }

  /** The upstream's answer to `query`, or null. */
  async function query(query, upstream) {
    const addresses = upstream?.addresses || [];
    if (!addresses.length) {
      onError(new Error('no upstream address'), upstream, null);
      return null;
    }
    for (const address of addresses) {
      let result = await connectionFor(address, upstream.hostname).send(query);
      if (result.fail === FAIL.CLOSED) {
        onError(result.error, upstream, address);
        result = await connectionFor(address, upstream.hostname).send(query);
      }
      if (result.response) return result.response;
      onError(result.error, upstream, address);
      if (result.fail !== FAIL.CONNECT) return null;
    }
    return null;
  }

  function closeAll() {
    for (const connection of connections.values()) connection.close();
    connections.clear();
  }

  return { query, closeAll };
}
