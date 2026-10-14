/**
 * PowerDNS Authoritative's HTTP API (/api/v1), the only way CIDRella writes
 * zones: Authoritative caches zone data, and only an API write clears that
 * cache at once. Every call sends the X-API-Key header and throws a
 * PdnsError naming what failed.
 */
export class PdnsError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'PdnsError';
    this.status = status;
  }
}

const SERVER = '/api/v1/servers/localhost';

// A zone's API id is its name with '/' escaped as =2F; CIDRella's zone names
// carry none, but the id the API hands back is used as given.
const zonePath = (id) => `${SERVER}/zones/${encodeURIComponent(id)}`;

/**
 * `apiKey()` is read per call, so a key created after the client still
 * works. `fetchImpl` is for tests.
 */
export function createPdnsClient({
  port,
  apiKey,
  host = '127.0.0.1',
  timeoutMs = 5000,
  fetchImpl = fetch,
}) {
  const base = `http://${host}:${port}`;

  async function call(method, path, body) {
    const what = `${method} ${path}`;
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          'X-API-Key': apiKey() ?? '',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new PdnsError(`PowerDNS did not answer ${what} on ${base}: ${err.message}`);
    }
    const text = await res.text();
    if (res.status === 401) {
      throw new PdnsError(`PowerDNS refused CIDRella's API key for ${what} (HTTP 401)`, {
        status: 401,
      });
    }
    if (!res.ok) {
      let reason = text.trim();
      try {
        reason = JSON.parse(text).error || reason;
      } catch {
        /* not JSON */
      }
      throw new PdnsError(
        `PowerDNS answered ${what} with HTTP ${res.status}: ${reason || 'no reason given'}`,
        { status: res.status },
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new PdnsError(`PowerDNS's reply to ${what} was not JSON`, { status: res.status });
    }
  }

  return {
    /** The server object: answers once the API is up. */
    server: () => call('GET', SERVER),
    /** Every zone, without records: [{ id, name, ... }]. */
    listZones: () => call('GET', `${SERVER}/zones`),
    /** One zone with its rrsets. */
    getZone: (id) => call('GET', zonePath(id)),
    createZone: (zone) => call('POST', `${SERVER}/zones`, zone),
    /** rrsets: [{ name, type, changetype: 'REPLACE' | 'DELETE', ttl?, records? }] */
    patchZone: (id, rrsets) => call('PATCH', zonePath(id), { rrsets }),
    deleteZone: (id) => call('DELETE', zonePath(id)),
  };
}
