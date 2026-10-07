/**
 * Encrypted connections to the forwarder's upstreams (DNS over TLS and DNS
 * over HTTPS), kept open and reused.
 *
 * A fresh TCP + TLS handshake per query cost about 46 ms an answer against a
 * 10 ms round trip to the upstream. One connection per upstream address now
 * carries every query at once:
 * - DoT pipelines on one TLS stream (RFC 7858, RFC 7766). Each query gets an
 *   ID unique on its connection, the reply is matched back by it, and the
 *   client's own ID is restored.
 * - DoH runs over HTTP/2 (RFC 8484), one stream per query. A server that only
 *   offers HTTP/1.1 is remembered per address and served over a keep-alive
 *   HTTP/1.1 agent instead.
 *
 * One policy for both:
 * - A connection closes after IDLE_MS with nothing in flight, and a reconnect
 *   offers the TLS session ticket from the last one.
 * - A connection that drops after it was open, with a query in flight, is
 *   the server ending an idle connection as we wrote to it; that query is
 *   retried once on a new connection.
 * - A connection that never opens, a certificate that fails verification
 *   included, moves to the upstream's next address.
 * - A timeout, or an HTTP error status, is final.
 *
 * Failure stays closed: a query nothing answered resolves null and the
 * forwarder answers SERVFAIL. Nothing unverified and nothing plaintext is
 * ever used.
 */
import http2 from 'http2';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { extractTcpMessages, frameTcpMessage } from './dns-wire.js';

const DOT_PORT = 853;
const IDLE_MS = 30_000;
const DNS_MESSAGE = 'application/dns-message';

// Why a query got no answer on a connection.
const FAIL = Object.freeze({
  CONNECT: 'connect', // the connection never opened
  CLOSED: 'closed', // it was open, then dropped with this query in flight
  TIMEOUT: 'timeout',
  HTTP: 'http', // the DoH server answered with an error status
  DOWNGRADE: 'downgrade', // the DoH server offered HTTP/1.1, not HTTP/2
});

/**
 * Connect to `address`, validating the certificate against `hostname`. The
 * address is used as is, so no lookup of the upstream's own name is needed.
 * Node's DNS lookup is pinned to the address for the HTTP/1.1 agent: it asks
 * with { all: true } (an array) when autoSelectFamily is on, and the family
 * must be the address's own or an IPv6 upstream gets an IPv4 socket (IPV6-23).
 */
export function pinnedLookup(address) {
  const family = net.isIP(address);
  return (_host, opts, cb) =>
    opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family);
}

// What every connection does with the queries in flight on it: a timer each,
// and an idle timer once none is left.
class Connection {
  constructor({ timeoutMs, idleMs }) {
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.inflight = new Set();
    this.idleTimer = null;
    this.open = false;
    this.ended = false;
    this.failure = null;
    this.closeOnTimeout = true; // HTTP/1.1 opts out: its timeout destroys only that socket
  }

  get usable() {
    return !this.ended;
  }

  begin(resolve, label, onTimeout = () => {}) {
    clearTimeout(this.idleTimer);
    const call = { resolve, done: false, cleanup: () => {} };
    call.timer = setTimeout(() => {
      onTimeout();
      this.finish(call, { fail: FAIL.TIMEOUT, error: new Error(`${label} timeout`) });
      // A connection that let a query time out may be half open (NAT state
      // gone, upstream silent), and steady traffic would keep it from ever
      // idling out. Drop it: the next query connects fresh, and any other
      // query still on it fails as closed and is retried on the new one.
      if (this.closeOnTimeout) this.close();
    }, this.timeoutMs);
    this.inflight.add(call);
    return call;
  }

  finish(call, result) {
    if (call.done) return;
    call.done = true;
    clearTimeout(call.timer);
    call.cleanup();
    this.inflight.delete(call);
    call.resolve(result);
    if (this.inflight.size === 0 && !this.ended) {
      this.idleTimer = setTimeout(() => this.close(), this.idleMs);
      this.idleTimer.unref?.();
    }
  }

  // The connection is gone: everything in flight fails with why.
  end() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    const failure = this.failure || {
      kind: this.open ? FAIL.CLOSED : FAIL.CONNECT,
      error: new Error('connection closed'),
    };
    for (const call of [...this.inflight]) {
      this.finish(call, { fail: failure.kind, error: failure.error });
    }
  }

  // Record why the TLS socket failed, unless something already did.
  failed(error) {
    this.failure ||= { kind: this.open ? FAIL.CLOSED : FAIL.CONNECT, error };
  }

  // Shared by DoT and DoH over HTTP/2: open the TLS socket and refuse it
  // unless the certificate verified.
  connectTls({ address, port, hostname, session, onSession, tlsOptions, alpn }, onOpen) {
    const socket = tls.connect({
      host: address,
      port,
      servername: hostname,
      ...(alpn ? { ALPNProtocols: alpn } : {}),
      ...(session ? { session } : {}),
      ...tlsOptions,
    });
    socket.on('session', onSession);
    socket.on('secureConnect', () => {
      if (!socket.authorized) {
        this.failure = {
          kind: FAIL.CONNECT,
          error: socket.authorizationError || new Error('certificate not authorized'),
        };
        socket.destroy();
        return;
      }
      onOpen();
    });
    socket.on('error', (error) => this.failed(error));
    return socket;
  }
}

class DotConnection extends Connection {
  constructor(opts) {
    super(opts);
    this.pending = new Map(); // wire id -> call
    this.queued = []; // frames written once the handshake completes
    this.nextId = Math.floor(Math.random() * 0x10000);
    this.buf = Buffer.alloc(0);
    this.socket = this.connectTls(opts, () => {
      this.open = true;
      for (const frame of this.queued) this.socket.write(frame);
      this.queued = [];
    });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('close', () => this.end());
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
      const call = this.begin(resolve, 'DoT');
      call.originalId = query.readUInt16BE(0);
      call.cleanup = () => this.pending.delete(id);
      this.pending.set(id, call);
      const wire = Buffer.from(query);
      wire.writeUInt16BE(id, 0);
      const frame = frameTcpMessage(wire);
      if (this.open) this.socket.write(frame);
      else this.queued.push(frame);
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const { messages, rest } = extractTcpMessages(this.buf);
    this.buf = rest;
    for (const message of messages) {
      if (message.length < 2) continue;
      const call = this.pending.get(message.readUInt16BE(0));
      if (!call) continue; // a late reply to a query that already timed out
      const response = Buffer.from(message);
      response.writeUInt16BE(call.originalId, 0);
      this.finish(call, { response });
    }
  }

  close() {
    this.socket.destroy();
  }
}

class DohH2Connection extends Connection {
  constructor(opts) {
    super(opts);
    this.url = opts.url;
    this.queued = []; // sends waiting for the session
    this.draining = false; // the server sent GOAWAY: finish what's in flight, start nothing
    this.socket = this.connectTls({ ...opts, alpn: ['h2', 'http/1.1'] }, () => {
      if (this.socket.alpnProtocol !== 'h2') {
        this.failure = { kind: FAIL.DOWNGRADE, error: new Error('server offered HTTP/1.1') };
        this.socket.destroy();
        return;
      }
      this.session = http2.connect(this.url.origin, { createConnection: () => this.socket });
      this.session.on('error', (error) => this.failed(error));
      this.session.on('goaway', () => (this.draining = true));
      this.session.on('close', () => this.end());
      this.open = true;
      for (const start of this.queued) start();
      this.queued = [];
    });
    this.socket.on('close', () => {
      if (!this.session) this.end();
    });
  }

  get usable() {
    return !this.ended && !this.draining && !this.session?.closed && !this.session?.destroyed;
  }

  // The call and its timer start now, so a connection that never opens still
  // fails the query (end() settles everything in flight); the stream starts
  // once the session is up.
  send(query) {
    return new Promise((resolve) => {
      const call = this.begin(resolve, 'DoH', () => call.stream?.close(http2.constants.NGHTTP2_CANCEL));
      if (this.open) this.request(call, query);
      else this.queued.push(() => this.request(call, query));
    });
  }

  request(call, query) {
    if (call.done) return;
    let stream;
    try {
      stream = call.stream = this.session.request({
        ':method': 'POST',
        ':path': this.url.pathname + this.url.search,
        'content-type': DNS_MESSAGE,
        accept: DNS_MESSAGE,
        'content-length': query.length,
      });
    } catch (error) {
      return this.finish(call, { fail: FAIL.CLOSED, error });
    }
    let status = 0;
    const chunks = [];
    stream.on('response', (headers) => (status = headers[':status']));
    stream.on('data', (chunk) => chunks.push(chunk));
    // A stream that ends with no response headers, or closes with neither an
    // end nor an error, went down with its session: a dropped connection.
    const dropped = (error = new Error('connection closed')) =>
      this.finish(call, { fail: FAIL.CLOSED, error });
    stream.on('end', () => {
      if (!status) return dropped();
      this.finish(
        call,
        status === 200
          ? { response: Buffer.concat(chunks) }
          : { fail: FAIL.HTTP, error: new Error(`DoH HTTP ${status}`) },
      );
    });
    stream.on('error', dropped);
    stream.on('close', () => dropped());
    stream.end(query);
  }

  close() {
    if (this.session) this.session.destroy();
    else this.socket.destroy();
  }
}

// For a DoH server that only speaks HTTP/1.1: a keep-alive agent pinned to
// one address. A request on a reused socket that fails before any response
// is the server closing an idle socket, so it counts as a dropped connection
// and is retried.
class DohH1Connection extends Connection {
  constructor(opts) {
    super(opts);
    this.url = opts.url;
    this.address = opts.address;
    this.hostname = opts.hostname;
    this.tlsOptions = opts.tlsOptions;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
    this.open = true;
    this.closeOnTimeout = false;
  }

  send(query) {
    return new Promise((resolve) => {
      let req;
      const call = this.begin(resolve, 'DoH', () => req?.destroy());
      req = https.request(
        {
          method: 'POST',
          hostname: this.url.hostname,
          port: this.url.port || 443,
          path: this.url.pathname + this.url.search,
          servername: this.hostname,
          lookup: pinnedLookup(this.address),
          headers: {
            'content-type': DNS_MESSAGE,
            accept: DNS_MESSAGE,
            'content-length': query.length,
          },
          agent: this.agent,
          ...this.tlsOptions,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return this.finish(call, {
              fail: FAIL.HTTP,
              error: new Error(`DoH HTTP ${res.statusCode}`),
            });
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => this.finish(call, { response: Buffer.concat(chunks) }));
          res.on('error', (error) => this.finish(call, { fail: FAIL.CLOSED, error }));
        },
      );
      req.on('error', (error) =>
        this.finish(call, { fail: req.reusedSocket ? FAIL.CLOSED : FAIL.CONNECT, error }),
      );
      req.end(query);
    });
  }

  close() {
    this.agent.destroy();
    this.end();
  }
}

/**
 * @param {object} opts
 * @param {'dot'|'doh'} opts.protocol
 * @param {number} opts.timeoutMs   per query
 * @param {(error: Error, upstream: object, address: string|null) => void} [opts.onError]
 *   every failed attempt
 * @param {number} [opts.port]      DoT port, 853 except in tests (DoH takes its URL's)
 * @param {number} [opts.idleMs]
 * @param {object} [opts.tlsOptions] extra TLS options (tests pass `ca`)
 */
export function createUpstreamPool({
  protocol,
  timeoutMs,
  onError = () => {},
  port = DOT_PORT,
  idleMs = IDLE_MS,
  tlsOptions = {},
}) {
  const connections = new Map(); // key -> Connection
  const sessions = new Map(); // key -> TLS session ticket
  const http1Only = new Set(); // keys of DoH servers that offered only HTTP/1.1

  function target(address, upstream, url) {
    const hostname = upstream.hostname || url?.hostname;
    const connectPort = url ? Number(url.port) || 443 : port;
    return { hostname, connectPort, key: `${address}|${hostname}|${connectPort}` };
  }

  function connectionFor(address, upstream, url) {
    const { hostname, connectPort, key } = target(address, upstream, url);
    let connection = connections.get(key);
    if (!connection?.usable) {
      const opts = {
        address,
        hostname,
        port: connectPort,
        url,
        timeoutMs,
        idleMs,
        tlsOptions,
        session: sessions.get(key),
        onSession: (session) => sessions.set(key, session),
      };
      const Kind =
        protocol === 'dot' ? DotConnection : http1Only.has(key) ? DohH1Connection : DohH2Connection;
      connection = new Kind(opts);
      connections.set(key, connection);
    }
    return connection;
  }

  const send = (address, upstream, url, query) =>
    connectionFor(address, upstream, url).send(query);

  /** The upstream's answer to `query`, or null. */
  async function query(query, upstream) {
    let url = null;
    if (protocol === 'doh') {
      try {
        url = new URL(upstream?.doh_url);
      } catch (error) {
        onError(error, upstream, null);
        return null;
      }
    }
    const addresses = upstream?.addresses || [];
    if (!addresses.length) {
      onError(new Error('no upstream address'), upstream, null);
      return null;
    }
    for (const address of addresses) {
      let result = await send(address, upstream, url, query);
      if (result.fail === FAIL.DOWNGRADE) {
        http1Only.add(target(address, upstream, url).key);
        result = await send(address, upstream, url, query);
      }
      if (result.fail === FAIL.CLOSED) {
        onError(result.error, upstream, address);
        result = await send(address, upstream, url, query);
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
