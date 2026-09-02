#!/usr/bin/env node
/*
 * Guardrail for database write ownership.
 *
 * The first enforced rule is intentionally narrow: production writes to
 * ip_addresses must live in server/src/models/ip-address.js, migrations, or
 * the startup-only canonical identity backfill.
 * Broader write findings are reported as architecture debt until each table
 * has an owner and can be made strict.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHOW_REPORT = process.argv.includes('--report');

const SCAN_ROOTS = [
  'server/src',
  'server/anomaly',
].map(p => path.join(ROOT, p));

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '__pycache__',
]);

const STRICT_TABLE_RULES = [
  {
    table: 'ip_addresses',
    ownerLabel: 'server/src/models/ip-address.js or startup identity backfill',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?ip_addresses\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/ip-address.js'
        || rel === 'server/src/db/ip-identity.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  },
  {
    table: 'network_scans',
    ownerLabel: 'server/src/models/scan-run.js',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?network_scans\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/scan-run.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  },
  {
    table: 'scan_results',
    ownerLabel: 'server/src/models/scan-run.js',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?scan_results\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/scan-run.js'
      || rel.startsWith('server/src/db/migrations/');
    },
  },
  ...[
    'dhcp_scopes',
    'dhcp_scope_options',
    'dhcp_reservations',
    'dhcp_leases',
    'dhcp_option_defaults',
    'dhcp_custom_options',
  ].map(table => ({
    table,
    ownerLabel: 'server/src/models/dhcp-*.js or server/src/services/subnet-dhcp-topology.js',
    writePattern: new RegExp(`\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+[\`'"]?${table}\\b`, 'gi'),
    allow(file) {
      const rel = relPath(file);
      return rel.startsWith('server/src/models/dhcp-')
        || rel === 'server/src/services/subnet-dhcp-topology.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  })),
  {
    table: 'ranges',
    ownerLabel: 'server/src/models/range.js or subnet/DHCP topology services',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?ranges\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/range.js'
        || rel === 'server/src/models/dhcp-scope.js'
        || rel === 'server/src/services/subnet-topology.js'
        || rel === 'server/src/services/subnet-dhcp-topology.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  },
  {
    table: 'subnets',
    ownerLabel: 'server/src/services/subnet-topology.js or explicit domain-sync owner',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?subnets\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/services/subnet-topology.js'
        || rel === 'server/src/models/dns-zone.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  },
  {
    table: 'range_types',
    ownerLabel: 'server/src/models/range-type.js',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?range_types\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/range-type.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  },
  {
    table: 'folders',
    ownerLabel: 'server/src/models/folder.js',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?folders\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/folder.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  },
  {
    table: 'vlans',
    ownerLabel: 'server/src/models/vlan.js',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?vlans\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/vlan.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  },
  {
    table: 'users',
    ownerLabel: 'server/src/models/user.js',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?users\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/user.js'
        || rel === 'server/src/reset-password.js'
        || rel.startsWith('server/src/db/');
    },
  },
  {
    table: 'settings',
    ownerLabel: 'server/src/models/setting.js or DB defaults',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?settings\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/setting.js'
        || rel === 'server/anomaly/storage.py'
        || rel.startsWith('server/src/db/');
    },
  },
  {
    table: 'geoip_rules',
    ownerLabel: 'server/src/models/geoip-rule.js',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?geoip_rules\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/geoip-rule.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  },
  ...[
    'anomaly_scores',
    'anomaly_models',
    'anomaly_whitelist',
  ].map(table => ({
    table,
    ownerLabel: 'server/src/models/anomaly.js or anomaly service storage',
    writePattern: new RegExp(`\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+[\`'"]?${table}\\b`, 'gi'),
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/anomaly.js'
        || rel === 'server/anomaly/storage.py'
        || rel.startsWith('server/src/db/migrations/');
    },
  })),
  ...[
    'blocklist_categories',
    'blocklist_domains',
    'blocklist_whitelist',
  ].map(table => ({
    table,
    ownerLabel: 'server/src/models/blocklist-store.js or server/src/utils/blocklist.js',
    writePattern: new RegExp(`\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+[\`'"]?${table}\\b`, 'gi'),
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/blocklist-store.js'
        || rel === 'server/src/utils/blocklist.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  })),
  {
    table: 'audit_log',
    ownerLabel: 'server/src/db/init.js audit helper or audit-log model',
    writePattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`'"]?audit_log\b/gi,
    allow(file) {
      const rel = relPath(file);
      return rel === 'server/src/models/audit-log.js'
        || rel === 'server/src/models/user.js'
        || rel === 'server/src/db/init.js'
        || rel === 'server/src/reset-password.js'
        || rel.startsWith('server/src/db/migrations/');
    },
  },
];

const BROAD_WRITE_PATTERN = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/g;
const BROAD_ALLOW_PREFIXES = [
  'server/src/db/',
  'server/src/models/',
  'server/src/services/',
  'server/src/utils/backup.js',
  'server/src/utils/blocklist.js',
  'server/src/utils/mac-vendor.js',
  'server/src/utils/metrics-aggregator.js',
  'server/src/db/duckdb.js',
  'server/src/reset-password.js',
  'server/anomaly/storage.py',
];

function relPath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function shouldSkipDir(dir) {
  return SKIP_DIRS.has(path.basename(dir));
}

function isSourceFile(file) {
  return /\.(js|mjs|cjs|py|sql)$/.test(file);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDir(full)) walk(full, out);
    } else if (entry.isFile() && isSourceFile(full)) {
      out.push(full);
    }
  }
  return out;
}

function lineForIndex(text, index) {
  return text.slice(0, index).split('\n').length;
}

function maskComments(text, file) {
  if (file.endsWith('.py')) {
    return text.split('\n').map(line => {
      const idx = line.indexOf('#');
      return idx === -1 ? line : `${line.slice(0, idx)}${' '.repeat(line.length - idx)}`;
    }).join('\n');
  }

  let out = '';
  let i = 0;
  let state = 'code';
  let quote = null;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') {
        out += '\n';
        state = 'code';
      } else {
        out += ' ';
      }
      i++;
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 2;
        state = 'code';
      } else {
        out += ch === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    if (state === 'string') {
      out += ch;
      if (ch === '\\') {
        if (next !== undefined) {
          out += next;
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      if (ch === quote) {
        state = 'code';
        quote = null;
      }
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      out += '  ';
      i += 2;
      state = 'line-comment';
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      state = 'block-comment';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      state = 'string';
    }
    out += ch;
    i++;
  }

  return out;
}

function collectMatches(files, pattern, allow) {
  const findings = [];
  for (const file of files) {
    const rel = relPath(file);
    const original = fs.readFileSync(file, 'utf8');
    const text = maskComments(original, file);
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      if (!allow(file)) {
        findings.push({
          file: rel,
          line: lineForIndex(text, match.index),
          match: match[0].replace(/\s+/g, ' '),
        });
      }
    }
  }
  return findings;
}

function broadAllow(file) {
  const rel = relPath(file);
  if (rel.startsWith('server/src/db/migrations/')) return true;
  return BROAD_ALLOW_PREFIXES.some(prefix => rel === prefix || rel.startsWith(prefix));
}

const files = SCAN_ROOTS.flatMap(root => walk(root));
let failures = 0;

for (const rule of STRICT_TABLE_RULES) {
  const findings = collectMatches(files, rule.writePattern, rule.allow);
  if (findings.length > 0) {
    failures += findings.length;
    console.error(`DB ownership violation: ${rule.table} writes must go through ${rule.ownerLabel}`);
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line} ${f.match}`);
    }
  }
}

const broadFindings = collectMatches(files, BROAD_WRITE_PATTERN, broadAllow);
if (SHOW_REPORT && broadFindings.length > 0) {
  console.log(`DB ownership report: ${broadFindings.length} direct write statement(s) remain outside model/service allowlist.`);
  for (const f of broadFindings) {
    console.log(`  ${f.file}:${f.line} ${f.match}`);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
