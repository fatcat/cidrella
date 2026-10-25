#!/usr/bin/env node
'use strict';
/**
 * Guard: no import cycles in the client.
 *
 * CI's madge gate covers server/src only, because madge cannot parse Vue
 * SFCs. This reads the static imports of every .js file and every <script>
 * block of every .vue file under client/src, resolves relative and @shared
 * paths, and fails on any cycle. Packages are not followed.
 *
 * Only static imports count, as in the server gate (.madgerc sets
 * skipAsyncImports): a lazy `import()` resolves after every module has
 * loaded, so it cannot leave a module reading a binding that is not
 * initialized yet, which is the failure this guard exists to catch. A cycle
 * of static imports works only while every use of the imported names stays
 * inside functions; the first top-level use throws "Cannot access before
 * initialization", and which module throws depends on load order.
 *
 * BASELINE: none. To break a cycle, have the lower module take a callback
 * the higher one registers (api/client.js's configureApi is the model)
 * rather than importing it.
 *
 * Usage: node scripts/check-client-cycles.js [project-dir]
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const SRC = path.join(root, 'client/src');
// Mirrors client/shared-modules.js.
const ALIASES = { '@shared/': path.join(root, 'server/src/utils/') };

// `import x from '…'`, `import '…'`, `export { x } from '…'`, `export * from '…'`.
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?:[^'"`;]*?\bfrom\s*)?(['"])([^'"\n]+)\1/gm;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|vue)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function scriptSource(file) {
  const source = fs.readFileSync(file, 'utf8');
  if (!file.endsWith('.vue')) return source;
  const blocks = source.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
  return blocks.map((block) => block.replace(/^<script\b[^>]*>|<\/script>$/g, '')).join('\n');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function resolve(from, spec) {
  let base;
  const alias = Object.keys(ALIASES).find((prefix) => spec.startsWith(prefix));
  if (alias) base = path.join(ALIASES[alias], spec.slice(alias.length));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null; // a package
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Build the graph from client/src, following @shared into server/src/utils.
const graph = new Map();
const queue = walk(SRC);
while (queue.length) {
  const file = queue.pop();
  if (graph.has(file) || !/\.(js|vue)$/.test(file)) continue;
  const deps = new Set();
  for (const match of stripComments(scriptSource(file)).matchAll(STATIC_IMPORT)) {
    const target = resolve(file, match[2]);
    if (target && /\.(js|vue)$/.test(target)) deps.add(target);
  }
  graph.set(file, deps);
  queue.push(...deps);
}

// Tarjan's strongly connected components: every component of more than one
// module (or a module importing itself) holds at least one cycle.
let index = 0;
const stack = [];
const state = new Map();
const components = [];
function connect(node) {
  const entry = { index, low: index, onStack: true };
  index += 1;
  state.set(node, entry);
  stack.push(node);
  for (const dep of graph.get(node) || []) {
    const seen = state.get(dep);
    if (!seen) {
      connect(dep);
      entry.low = Math.min(entry.low, state.get(dep).low);
    } else if (seen.onStack) {
      entry.low = Math.min(entry.low, seen.index);
    }
  }
  if (entry.low === entry.index) {
    const component = [];
    let member;
    do {
      member = stack.pop();
      state.get(member).onStack = false;
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || graph.get(node).has(node)) components.push(component);
  }
}
for (const node of graph.keys()) if (!state.has(node)) connect(node);

// One concrete loop per component, for the report.
function loopIn(component) {
  const members = new Set(component);
  const start = component.slice().sort()[0];
  const prev = new Map([[start, null]]);
  const queueBfs = [start];
  while (queueBfs.length) {
    const node = queueBfs.shift();
    for (const dep of graph.get(node)) {
      if (dep === start) {
        const chain = [];
        for (let at = node; at; at = prev.get(at)) chain.unshift(at);
        return [...chain, start];
      }
      if (members.has(dep) && !prev.has(dep)) {
        prev.set(dep, node);
        queueBfs.push(dep);
      }
    }
  }
  return component;
}

const rel = (file) => path.relative(root, file).split(path.sep).join('/');
console.log(`Client import cycles: ${components.length} (baseline: 0)`);
if (components.length) {
  for (const component of components) {
    console.log(`\n  ${component.length} modules, for example:`);
    console.log(`    ${loopIn(component).map(rel).join('\n      -> ')}`);
  }
  console.log('\nBreak the cycle; see the BASELINE note at the top of this script.');
  process.exit(1);
}
