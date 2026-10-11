// Every route that changes something leaves an audit row (services/audit.js).
// This reads the route files and fails on a POST, PUT, PATCH or DELETE whose
// handler never calls recordAudit, unless it is listed below with the reason
// it changes nothing worth a row. A new write route either records itself or
// earns a line here.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');
const DIRS = ['routes', 'auth'];
const ROUTE = /^router\.(post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']*'|`[^`]*`)/gm;

// file, method, path: why no row.
const ALLOWED = new Map(
  Object.entries({
    "dhcp.js POST '/scopes/bulk-options/preview'": 'a preview: writes nothing',
    "dns.js POST '/forwarders/test'": 'a test query',
    "dns.js DELETE '/resolver-test/:id'": 'cancels a running test',
    "internal-analytics.js POST '/query'": 'a read with a body',
    "logs.js POST '/stream-token'": 'a token to read a log',
    "pihole.js POST '/probe'": 'reads a Pi-hole',
    "pihole.js POST '/fetch'": 'reads a Pi-hole',
    "pihole.js POST '/parse'": 'parses an upload, writes nothing',
    "ranges.js PUT '/set-type'": 'records through assignOrClear',
    "ranges.js PUT '/clear-type'": 'records through assignOrClear',
    "scans.js POST '/probe'": 'probes one address',
    "subnets.js POST '/configuration-preview'": 'a preview: writes nothing',
    "subnets.js POST '/merge/preview'": 'a preview: writes nothing',
    "subnets.js POST '/:id/divide/preview'": 'a preview: writes nothing',
    "subnets.js POST '/calculate'": 'arithmetic',
    "tracking.js POST '/'": 'dev UI tracking',
    "tracking.js DELETE '/'": 'dev UI tracking',
    "version.js POST '/update-dismiss'": 'hides an update notice for one viewer',
    "routes.js POST '/totp/setup'": 'starts enrolment; enabling it is recorded',
    "routes.js POST '/activity'": 'keeps a session alive',
    "routes.js PUT '/preferences'": 'one user’s display preferences',
  }),
);

function writeRoutes() {
  const routes = [];
  for (const dir of DIRS) {
    for (const file of fs.readdirSync(path.join(SRC, dir)).filter((n) => n.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(SRC, dir, file), 'utf8');
      const starts = [...text.matchAll(ROUTE)];
      starts.forEach((match, i) => {
        const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
        routes.push({
          key: `${file} ${match[1].toUpperCase()} ${match[2]}`,
          audited: /recordAudit\(/.test(text.slice(match.index, end)),
        });
      });
    }
  }
  return routes;
}

describe('audit coverage', () => {
  const routes = writeRoutes();

  it('finds the write routes', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('records every write route, or says why not', () => {
    const missing = routes.filter((r) => !r.audited && !ALLOWED.has(r.key)).map((r) => r.key);
    expect(missing).toEqual([]);
  });

  it('lists no route that records after all, or that is gone', () => {
    const byKey = new Map(routes.map((r) => [r.key, r]));
    const stale = [...ALLOWED.keys()].filter((key) => {
      const route = byKey.get(key);
      return !route || route.audited;
    });
    expect(stale).toEqual([]);
  });
});
