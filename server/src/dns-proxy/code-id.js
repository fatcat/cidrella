/**
 * The DNS proxy's code id: a hash over every source file the proxy process
 * loads, the packages it imports and the Node version. The proxy computes it
 * once at start, from the files it loaded; the web app computes it from its
 * own slot. When an update changes neither, the proxy keeps running through
 * the web app's restart; when they differ, the web app has it restarted.
 *
 * The closure is found by reading the static `import` and `export ... from`
 * specifiers, so it holds only while the proxy's code imports nothing
 * dynamically: `dynamicImports` names any file that does, and a test refuses
 * them.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';

const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PROXY_ENTRY = fileURLToPath(new URL('./main.js', import.meta.url));

const BUILTINS = new Set(builtinModules);
const FROM_RE = /\b(?:import|export)\s[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(/;

// Comments can quote an import; only code counts.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function specifiersOf(source) {
  const code = stripComments(source);
  const found = [];
  for (const re of [FROM_RE, BARE_IMPORT_RE]) {
    for (const match of code.matchAll(re)) found.push(match[1]);
  }
  return { specifiers: found, dynamic: DYNAMIC_RE.test(code) };
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// The version of a package as the file importing it would load it.
function packageVersion(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    if (path.dirname(dir) === dir) return 'missing';
  }
}

/**
 * Every file the entry loads, relative to `root`, with the packages it
 * imports as name@version and the files that import dynamically.
 */
export function importClosure(entry = PROXY_ENTRY, { root = SERVER_ROOT } = {}) {
  const files = new Map();
  const packages = new Set();
  const dynamicImports = [];
  const pending = [path.resolve(entry)];
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    files.set(file, source);
    const { specifiers, dynamic } = specifiersOf(source);
    if (dynamic) dynamicImports.push(path.relative(root, file));
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        pending.push(path.resolve(path.dirname(file), specifier));
      } else if (!specifier.startsWith('node:') && !BUILTINS.has(specifier)) {
        const name = packageName(specifier);
        packages.add(`${name}@${packageVersion(name, path.dirname(file))}`);
      }
    }
  }
  return {
    files: [...files.keys()].map((file) => path.relative(root, file)).sort(),
    sources: files,
    packages: [...packages].sort(),
    dynamicImports: dynamicImports.sort(),
  };
}

/** The code id of the proxy (or of `entry`) as it stands on disk now. */
export function codeId(entry = PROXY_ENTRY, { root = SERVER_ROOT } = {}) {
  const { sources, packages } = importClosure(entry, { root });
  const hash = crypto.createHash('sha256');
  const ordered = [...sources.entries()]
    .map(([file, source]) => [path.relative(root, file), source])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [file, source] of ordered) hash.update(`${file}\0${source}\0`);
  for (const pkg of packages) hash.update(`${pkg}\0`);
  hash.update(process.version);
  return hash.digest('hex').slice(0, 16);
}
