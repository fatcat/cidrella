/**
 * The DNS proxy in the test's own process, for tests of what the proxy does.
 * It stands in for the web app's client (utils/dns-proxy-client.js): every
 * message the client would send over the socket goes straight to the proxy's
 * runtime (dns-proxy/runtime.js), the same code dns-proxy/main.js runs, and
 * what the runtime reports goes to the web app's sinks as the client would
 * hand it on.
 *
 *   vi.mock('<rel>/src/utils/dns-proxy-client.js', async () =>
 *     (await import('<rel>/helpers/proxy-in-process.js')).inProcessProxyClient(),
 *   );
 *
 * The proxy reads the test database (getDb()) read-only, as it does the live
 * one. Nothing is written to DATA_DIR/runtime and nothing is spawned.
 */
import { getDb } from '../../src/db/init.js';
import { createProxyRuntime } from '../../src/dns-proxy/runtime.js';
import { metricsFromWire } from '../../src/dns-proxy/protocol.js';
import * as Sinks from '../../src/services/dns-proxy-sinks.js';

export function inProcessProxyClient() {
  const sinks = {
    queryRow: Sinks.sinkQueryRow,
    clientSeen: Sinks.sinkClientSeen,
    resolution: Sinks.sinkResolution,
  };
  let handlers = sinks;
  let connected = false;
  let peer = null;
  // The runtime's replies, by request id (drain-result, db-released, applied).
  const replies = new Map();
  let nextId = 1;

  const runtime = createProxyRuntime({
    dbFile: () => getDb().name,
    dbRetryMs: 0,
    pid: 0,
    send: (message) => {
      if (message.type === 'hello') peer = { v: message.v, codeId: message.codeId, pid: 0 };
      else if (message.id !== undefined) replies.set(message.id, message);
    },
    reports: {
      queryRow: (row) => handlers.queryRow?.({ ...row, ts: new Date().toISOString() }),
      liveness: (ip) => handlers.clientSeen?.(ip),
      resolution: (event) => handlers.resolution?.({ ...event, at: Date.now() }),
    },
  });

  async function request(type) {
    const id = nextId++;
    await runtime.handle({ type, id });
    const reply = replies.get(id);
    replies.delete(id);
    return reply ?? null;
  }

  const status = () => runtime.statusMessage();

  return {
    startProxyClient({ handlers: given } = {}) {
      handlers = { ...sinks, ...given };
      connected = true;
      void runtime.handle({ type: 'hello' });
      return runtime.handle({ type: 'reload', what: 'all' });
    },
    stopProxyClient() {
      connected = false;
      peer = null;
      runtime.stop();
    },
    sendProxyConfig(config, { rebind = false } = {}) {
      void runtime.handle({ type: 'config', config, rebind });
    },
    sendReload: (what, extra = {}) => runtime.handle({ type: 'reload', what, ...extra }),
    async requestDrain() {
      const reply = await request('drain');
      return reply && { metrics: metricsFromWire(reply.metrics), forwarder: reply.forwarder };
    },
    async requestApplyForwarder() {
      const reply = await request('apply-forwarder');
      return reply && { ...reply, type: 'status' };
    },
    requestDbRelease: async () => (await request('db-release')) !== null,
    sendShutdown: () => {},
    lastProxyStatus: () => ({ status: status(), at: Date.now() }),
    freshProxyStatus: status,
    proxyConnected: () => connected,
    proxyPeer: () => peer,
    // For the test: the runtime itself.
    runtime,
  };
}
