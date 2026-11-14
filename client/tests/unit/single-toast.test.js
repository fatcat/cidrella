import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

function vueFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) vueFiles(p, acc);
    else if (e.name.endsWith('.vue')) acc.push(p);
  }
  return acc;
}

// App.vue mounts the one <Toast>. Every toast service message renders in each
// mounted <Toast>, so a second mount in a view shows each toast twice.
describe('toast mount', () => {
  it('is App.vue alone', () => {
    const mounts = vueFiles(SRC)
      .filter((file) => {
        const markup = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        return /<Toast[\s/>]/.test(markup);
      })
      .map((file) => path.relative(SRC, file));
    expect(mounts).toEqual(['App.vue']);
  });
});
