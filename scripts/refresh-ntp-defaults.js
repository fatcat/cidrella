#!/usr/bin/env node
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const configFile = path.join(projectDir, 'server/src/config/defaults.js');
const seedMigrationFile = path.join(
  projectDir,
  'server/src/db/migrations/024_seed_dhcp_defaults.sql',
);
const DEFAULT_MAX_AGE_DAYS = 30;
const force = process.argv.includes('--force');
const maxAgeDays = Number(process.env.NTP_DEFAULT_MAX_AGE_DAYS || DEFAULT_MAX_AGE_DAYS);

const net = require('net');

// The two baked lists: option 42 from pool.ntp.org, option 56 from
// 2.pool.ntp.org, the only pool name that answers with IPv6 addresses.
const FAMILIES = [
  { name: 'DHCP_DEFAULT_NTP_SERVERS', pool: 'pool.ntp.org', family: 4 },
  { name: 'DHCP6_DEFAULT_NTP_SERVERS', pool: '2.pool.ntp.org', family: 6 },
];
const REFRESHED_AT = 'DHCP_DEFAULT_NTP_SERVERS_REFRESHED_AT';
const PRINT_WIDTH = 100;

const isFamily = (ip, family) => net.isIP(ip) === family;

function updateFile(file, replacements) {
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [pattern, replacement] of replacements) {
    after = after.replace(pattern, replacement);
  }
  if (after === before) return false;
  fs.writeFileSync(file, after);
  return true;
}

// A constant, matched on one line or wrapped after the `=` as Prettier
// writes it when the line would pass the print width.
const constantPattern = (name) => new RegExp(`export const ${name} =\\s*'([^']*)';`);
function constantLine(name, value) {
  const line = `export const ${name} = '${value}';`;
  return line.length <= PRINT_WIDTH ? line : `export const ${name} =\n  '${value}';`;
}

// Replace a constant, or add it after the IPv4 list when an older file
// lacks it.
function upsertConstant(text, name, value) {
  const pattern = constantPattern(name);
  if (pattern.test(text)) return text.replace(pattern, constantLine(name, value));
  return text.replace(
    constantPattern(FAMILIES[0].name),
    (match) => `${match}\n${constantLine(name, value)}`,
  );
}

function readCurrentConfig() {
  const text = fs.readFileSync(configFile, 'utf8');
  const lists = Object.fromEntries(
    FAMILIES.map(({ name }) => [name, text.match(constantPattern(name))?.[1] || '']),
  );
  return { lists, refreshedAt: text.match(constantPattern(REFRESHED_AT))?.[1] || '' };
}

function daysSince(dateText) {
  const timestamp = Date.parse(`${dateText}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return Infinity;
  return Math.floor((Date.now() - timestamp) / 86400000);
}

function currentDate() {
  return new Date().toISOString().slice(0, 10);
}

const listOf = (value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

async function resolvePool({ pool, family }) {
  const answers = await (family === 6 ? dns.resolve6(pool) : dns.resolve4(pool));
  const ips = [...new Set(answers)].filter((ip) => isFamily(ip, family)).slice(0, 4);
  if (ips.length === 0) throw new Error(`${pool} did not resolve to any IPv${family} addresses`);
  return ips.join(',');
}

async function main() {
  const current = readCurrentConfig();
  const valid = FAMILIES.every(({ name, family }) => {
    const ips = listOf(current.lists[name]);
    return ips.length >= 4 && ips.every((ip) => isFamily(ip, family));
  });
  const ageDays = daysSince(current.refreshedAt);
  const stale = !Number.isFinite(ageDays) || ageDays >= maxAgeDays;
  const summary = (lists) => FAMILIES.map(({ name }) => `${name}=${lists[name]}`).join(' ');

  if (!force && valid && !stale) {
    console.log(`Baked DHCP NTP defaults are fresh (${ageDays}d old): ${summary(current.lists)}`);
    return;
  }

  const lists = {};
  for (const family of FAMILIES) lists[family.name] = await resolvePool(family);

  let changed = updateFile(configFile, [
    [
      /[\s\S]*/,
      (text) => {
        let after = text;
        for (const { name } of FAMILIES) after = upsertConstant(after, name, lists[name]);
        return upsertConstant(after, REFRESHED_AT, currentDate());
      },
    ],
  ]);

  // The original seed migration carries the IPv4 list for databases created
  // from it; the IPv6 list is seeded from the constant only.
  const v4 = lists[FAMILIES[0].name];
  changed =
    updateFile(seedMigrationFile, [
      [/\(42, '[^']*', datetime\('now'\)\)/, `(42, '${v4}', datetime('now'))`],
    ]) || changed;

  if (changed) {
    console.log(`Updated baked DHCP NTP defaults: ${summary(lists)}`);
    process.exit(2);
  }

  console.log(`Baked DHCP NTP defaults are current: ${summary(lists)}`);
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
