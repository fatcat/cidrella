#!/usr/bin/env node
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const configFile = path.join(projectDir, 'server/src/config/defaults.js');
const seedMigrationFile = path.join(projectDir, 'server/src/db/migrations/024_seed_dhcp_defaults.sql');
const DEFAULT_MAX_AGE_DAYS = 30;
const force = process.argv.includes('--force');
const maxAgeDays = Number(process.env.NTP_DEFAULT_MAX_AGE_DAYS || DEFAULT_MAX_AGE_DAYS);

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

function upsertConfigConstant(text, name, value) {
  const line = `export const ${name} = '${value}';`;
  const pattern = new RegExp(`export const ${name} = '[^']*';`);
  if (pattern.test(text)) {
    return text.replace(pattern, line);
  }
  return text.replace(
    /export const DHCP_DEFAULT_NTP_SERVERS = '[^']*';/,
    match => `${match}\n${line}`
  );
}

function updateConfigDefaults(value) {
  const before = fs.readFileSync(configFile, 'utf8');
  let after = before.replace(
    /export const DHCP_DEFAULT_NTP_SERVERS = '[^']*';/,
    `export const DHCP_DEFAULT_NTP_SERVERS = '${value}';`
  );
  after = upsertConfigConstant(after, 'DHCP_DEFAULT_NTP_SERVERS_REFRESHED_AT', currentDate());

  if (after === before) return false;
  fs.writeFileSync(configFile, after);
  return true;
}

function readCurrentConfig() {
  const text = fs.readFileSync(configFile, 'utf8');
  const value = text.match(/export const DHCP_DEFAULT_NTP_SERVERS = '([^']*)';/)?.[1] || '';
  const refreshedAt = text.match(/export const DHCP_DEFAULT_NTP_SERVERS_REFRESHED_AT = '([^']*)';/)?.[1] || '';
  return { value, refreshedAt };
}

function daysSince(dateText) {
  const timestamp = Date.parse(`${dateText}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return Infinity;
  return Math.floor((Date.now() - timestamp) / 86400000);
}

function currentDate() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const current = readCurrentConfig();
  const currentIps = current.value.split(',').map(s => s.trim()).filter(Boolean);
  const currentValid = currentIps.length >= 4 && currentIps.every(validIpv4);
  const ageDays = daysSince(current.refreshedAt);
  const stale = !Number.isFinite(ageDays) || ageDays >= maxAgeDays;

  if (!force && currentValid && !stale) {
    console.log(`Baked DHCP NTP default is fresh (${ageDays}d old): ${current.value}`);
    return;
  }

  const answers = [...new Set(await dns.resolve4('pool.ntp.org'))].filter(validIpv4).slice(0, 4);
  if (answers.length === 0) {
    console.error('pool.ntp.org did not resolve to any IPv4 addresses');
    process.exit(1);
  }

  const value = answers.join(',');
  let changed = false;

  changed = updateConfigDefaults(value) || changed;

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
