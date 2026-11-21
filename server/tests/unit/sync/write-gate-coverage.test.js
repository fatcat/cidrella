// What a member lets through is a list (sync/write-gate.js), and a list goes
// stale. This reads the route files and where index.js mounts them, and fails
// on an entry naming a route that is gone. A route missing from the list is
// refused on a member, the safe default, so a new one needs no entry.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MEMBER_ALLOWED } from '../../../src/sync/write-gate.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');
const ROUTE = /^router\.(post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']*'|`[^`]*`)/gm;
const IMPORT = /import (\w+)(?:, \{[^}]*\})? from '\.\/((?:routes|auth)\/[\w-]+\.js)'/g;
const LAZY_IMPORT = /\{ default: (\w+) \} = await import\('\.\/((?:routes|auth)\/[\w-]+\.js)'\)/g;
const MOUNT = /app\.use\('(\/api\/[^']*)', (\w+)\)/g;

// Route file -> every prefix index.js mounts it at.
function mounts() {
  const text = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const fileOf = new Map();
  for (const re of [IMPORT, LAZY_IMPORT]) {
    for (const [, name, file] of text.matchAll(re)) fileOf.set(name, file);
  }
  const byFile = new Map();
  for (const [, prefix, name] of text.matchAll(MOUNT)) {
    const file = fileOf.get(name);
    if (!file) continue;
    byFile.set(file, [...(byFile.get(file) || []), prefix]);
  }
  return byFile;
}

// 'METHOD /full/path' of every write route, as Express sees it.
function writeRoutes() {
  const routes = new Set();
  for (const [file, prefixes] of mounts()) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const [, method, spec] of text.matchAll(ROUTE)) {
      for (const [, route] of spec.matchAll(/['`]([^'`]*)['`]/g)) {
        for (const prefix of prefixes) {
          routes.add(`${method.toUpperCase()} ${prefix}${route === '/' ? '' : route}`);
        }
      }
    }
  }
  return routes;
}

describe('member write gate coverage', () => {
  const routes = writeRoutes();

  it('finds the write routes and where they are mounted', () => {
    expect(routes.size).toBeGreaterThan(100);
    expect(routes.has('POST /api/auth/login')).toBe(true);
    expect(routes.has('POST /api/backend-stack')).toBe(true);
    expect(routes.has('DELETE /api/dev/tracking')).toBe(true);
    expect(routes.has('PUT /api/subnets/:subnetId/ranges/:id')).toBe(true);
  });

  it('lists no route that is gone', () => {
    const stale = MEMBER_ALLOWED.filter((entry) => entry.path)
      .map((entry) => `${entry.method} ${entry.path}`)
      .filter((key) => !routes.has(key));
    expect(stale).toEqual([]);
  });

  it('lists nothing twice', () => {
    const keys = MEMBER_ALLOWED.map((entry) => `${entry.method} ${entry.path || entry.prefix}`);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });
});
