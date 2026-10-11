/**
 * A stand-in for PowerDNS Authoritative's HTTP API, enough for the PowerDNS
 * adapter's tests: the X-API-Key check, zones with their rrsets kept in
 * memory, the REPLACE and DELETE changetypes, and the refusals the adapter
 * must not provoke (an rrset outside its zone, a CNAME beside other data).
 *
 *   const pdns = await startFakePdns({ apiKey });
 *   pdns.port           the port it listens on (127.0.0.1)
 *   pdns.zones          Map of zone name to { id, name, kind, soa_edit_api, rrsets }
 *   pdns.calls          every request as 'METHOD /path', in order
 *   pdns.requests       every request as { method, url, body }, in order
 *   pdns.fail(method, status)   make the next request with that method fail
 *   await pdns.close()
 */
import http from 'http';

const SERVER = '/api/v1/servers/localhost';
const inZone = (name, zone) => name === zone || name.endsWith(`.${zone}`);

// Authoritative refuses a zone body or patch that would break these rules.
function rrsetError(zone, rrsets) {
  for (const rrset of rrsets) {
    if (!inZone(rrset.name, zone.name)) return `RRset ${rrset.name} is out of zone ${zone.name}`;
  }
  const names = new Map();
  for (const rrset of rrsets) {
    if (!rrset.records?.length) continue;
    const types = names.get(rrset.name) || new Set();
    types.add(rrset.type);
    names.set(rrset.name, types);
  }
  for (const [name, types] of names) {
    if (types.has('CNAME') && types.size > 1) return `RRset ${name} has CNAME and other data`;
  }
  return null;
}

export async function startFakePdns({ apiKey } = {}) {
  const zones = new Map();
  const calls = [];
  const requests = [];
  const failures = new Map();

  const send = (res, status, body) => {
    res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const byId = (id) => [...zones.values()].find((z) => z.id === decodeURIComponent(id));

  function handle(method, url, body) {
    if (url === SERVER && method === 'GET') {
      return [200, { id: 'localhost', daemon_type: 'authoritative' }];
    }
    if (url === `${SERVER}/zones` && method === 'GET') {
      return [200, [...zones.values()].map(({ rrsets: _rrsets, ...zone }) => zone)];
    }
    if (url === `${SERVER}/zones` && method === 'POST') {
      if (zones.has(body.name)) return [409, { error: `Domain '${body.name}' already exists` }];
      const error = rrsetError(body, body.rrsets || []);
      if (error) return [422, { error }];
      const zone = {
        id: body.name,
        name: body.name,
        kind: body.kind,
        soa_edit_api: body.soa_edit_api,
        rrsets: structuredClone(body.rrsets || []),
      };
      zones.set(zone.name, zone);
      return [201, zone];
    }
    const match = /^\/api\/v1\/servers\/localhost\/zones\/([^/]+)$/.exec(url);
    const zone = match && byId(match[1]);
    if (!zone) return [404, { error: 'Not Found' }];
    if (method === 'GET') return [200, structuredClone(zone)];
    if (method === 'DELETE') {
      zones.delete(zone.name);
      return [204];
    }
    if (method === 'PATCH') {
      const next = new Map(zone.rrsets.map((r) => [`${r.name}|${r.type}`, r]));
      for (const change of body.rrsets) {
        const key = `${change.name}|${change.type}`;
        if (change.changetype === 'DELETE') next.delete(key);
        else if (change.changetype === 'REPLACE') {
          const rrset = structuredClone(change);
          delete rrset.changetype;
          next.set(key, rrset);
        } else return [422, { error: `Unknown changetype ${change.changetype}` }];
      }
      const error = rrsetError(zone, [...next.values()]);
      if (error) return [422, { error }];
      zone.rrsets = [...next.values()];
      return [204];
    }
    return [405, { error: 'Method not allowed' }];
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      if (req.headers['x-api-key'] !== apiKey) {
        return send(res, 401, { error: 'Unauthorized' });
      }
      if (failures.has(req.method)) {
        const status = failures.get(req.method);
        failures.delete(req.method);
        return send(res, status, { error: `Injected ${status}` });
      }
      const [status, body] = handle(req.method, req.url, raw ? JSON.parse(raw) : undefined);
      send(res, status, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    zones,
    calls,
    requests,
    fail: (method, status) => failures.set(method, status),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
