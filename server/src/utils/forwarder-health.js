/**
 * Are the upstreams DNS is forwarded to answering? Probes what is actually in
 * use: with encrypted forwarding on, every address of every provider over
 * DoT or DoH; otherwise the plain servers. Probes run together and the result
 * is kept for 30 seconds, so pages that poll the services endpoint don't send
 * a probe each time.
 */
import { getSetting } from '../db/init.js';
import { testDnsForwarder } from './dns-test.js';
import { probeAddress } from './upstream-probe.js';
import { plainUpstreams } from './forwarding-settings.js';

const CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 3000;

let cache = null; // { key, at, value }

async function probeEncrypted(upstreams, protocol) {
  const targets = upstreams.flatMap((provider) =>
    (provider.addresses || []).map((address) => ({ provider, address })),
  );
  return Promise.all(
    targets.map(async ({ provider, address }) => {
      const { problem, ms } = await probeAddress({
        provider,
        address,
        protocol,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      return {
        ip: address,
        label: provider.hostname || provider.label || '',
        protocol,
        reachable: !problem,
        latency_ms: problem ? null : ms,
        problem: problem || null,
      };
    }),
  );
}

async function probePlain(servers) {
  return Promise.all(
    servers.map(async (ip) => {
      const started = performance.now();
      const result = await testDnsForwarder(ip);
      return {
        ip,
        label: ip,
        protocol: 'dns',
        reachable: result.reachable,
        latency_ms: result.reachable ? Math.round(performance.now() - started) : null,
        problem: result.reachable ? null : result.error || 'no answer',
      };
    }),
  );
}

/**
 * [{ ip, label, protocol, reachable, latency_ms, problem }], one per address
 * forwarded to. Empty when recursion is off.
 */
export async function forwarderHealth({ now = Date.now() } = {}) {
  if (getSetting('dns_no_recursion') === 'true') return [];
  const mode = getSetting('forwarder_encryption') || 'off';
  const encrypted = mode === 'tls' || mode === 'https';
  const targets = encrypted ? getSetting('forwarder_encrypted_upstreams') || [] : plainUpstreams();
  const key = JSON.stringify([mode, targets]);
  if (cache?.key === key && now - cache.at < CACHE_MS) return cache.value;
  const value = encrypted
    ? await probeEncrypted(targets, mode === 'https' ? 'doh' : 'dot')
    : await probePlain(targets);
  cache = { key, at: now, value };
  return value;
}

/** Forget the last result (tests). */
export function clearForwarderHealth() {
  cache = null;
}
