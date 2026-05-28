#!/usr/bin/env node
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const configFile = path.join(projectDir, 'server/src/config/defaults.js');
const seedMigrationFile = path.join(projectDir, 'server/src/db/migrations/024_seed_dhcp_defaults.sql');

function validIpv4(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)
    && ip.split('.').every(o => {
      const n = Number(o);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
}

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

async function main() {
  const answers = [...new Set(await dns.resolve4('pool.ntp.org'))].filter(validIpv4).slice(0, 4);
  if (answers.length === 0) {
    console.error('pool.ntp.org did not resolve to any IPv4 addresses');
    process.exit(1);
  }

  const value = answers.join(',');
  let changed = false;

  changed = updateFile(configFile, [
    [
      /export const DHCP_DEFAULT_NTP_SERVERS = '[^']*';/,
      `export const DHCP_DEFAULT_NTP_SERVERS = '${value}';`
    ]
  ]) || changed;

  changed = updateFile(seedMigrationFile, [
    [
      /\(42, '[^']*', datetime\('now'\)\)/,
      `(42, '${value}', datetime('now'))`
    ]
  ]) || changed;

  if (changed) {
    console.log(`Updated baked DHCP NTP default from pool.ntp.org: ${value}`);
    process.exit(2);
  }

  console.log(`Baked DHCP NTP default is current: ${value}`);
}

main().catch(err => {
  console.error(err.message || String(err));
  process.exit(1);
});
