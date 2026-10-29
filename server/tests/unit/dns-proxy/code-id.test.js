/**
 * The proxy's code id follows the files the proxy loads and nothing else, so
 * an update restarts the proxy only when its own code changed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { codeId, importClosure } from '../../../src/dns-proxy/code-id.js';

let dir;
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const id = () => codeId(path.join(dir, 'src/main.js'), { root: dir });
const closure = () => importClosure(path.join(dir, 'src/main.js'), { root: dir });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-id-'));
  write('node_modules/lru-cache/package.json', '{"name":"lru-cache","version":"11.0.0"}');
  write(
    'src/main.js',
    [
      "import fs from 'node:fs';",
      "import net from 'net';",
      "import { LRUCache } from 'lru-cache';",
      'import {',
      '  a,',
      '  b,',
      "} from './lib/a.js';",
      "export { c } from './lib/c.js';",
      "import './lib/side.js';",
      "// import { nope } from './lib/commented.js';",
      "/* import { nope } from './lib/commented.js'; */",
    ].join('\n'),
  );
  write('src/lib/a.js', "import { x } from '../util/x.js';\nexport const a = 1, b = x;");
  write('src/lib/c.js', 'export const c = 3;');
  write('src/lib/side.js', 'globalThis.side = true;');
  write('src/util/x.js', 'export const x = 2;');
  write('src/routes/other.js', "import { a } from '../lib/a.js';");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('importClosure', () => {
  it('follows static, multi-line, re-export and bare imports, not comments', () => {
    const { files, packages, dynamicImports } = closure();
    expect(files).toEqual([
      'src/lib/a.js',
      'src/lib/c.js',
      'src/lib/side.js',
      'src/main.js',
      'src/util/x.js',
    ]);
    expect(packages).toEqual(['lru-cache@11.0.0']);
    expect(dynamicImports).toEqual([]);
  });

  it('names a file that imports dynamically', () => {
    write('src/lib/c.js', "export const c = 3;\nconst later = () => import('./late.js');");
    expect(closure().dynamicImports).toEqual(['src/lib/c.js']);
  });
});

describe('codeId', () => {
  it('is the same every time for the same files', () => {
    expect(id()).toBe(id());
    expect(id()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when a file in the closure changes', () => {
    const before = id();
    write('src/util/x.js', 'export const x = 4;');
    expect(id()).not.toBe(before);
  });

  it('changes when an imported package changes version', () => {
    const before = id();
    write('node_modules/lru-cache/package.json', '{"name":"lru-cache","version":"11.0.1"}');
    expect(id()).not.toBe(before);
  });

  it('stays put when a file outside the closure changes', () => {
    const before = id();
    write('src/routes/other.js', "import { a } from '../lib/a.js';\nexport const changed = true;");
    write('src/routes/new.js', 'export const added = true;');
    expect(id()).toBe(before);
  });
});
