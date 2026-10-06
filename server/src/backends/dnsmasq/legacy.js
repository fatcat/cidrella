/**
 * Files older CIDRella releases left in dnsmasq's directories that would now
 * serve stale data.
 */
import fs from 'fs';
import path from 'path';
import { CONF_DIR, HOSTS_DIR } from './paths.js';
import { atomicWrite, restartDnsmasq, withValidatedDnsmasqUpdate } from './dnsmasq.js';

const BLOCKLIST_CONF = path.join(CONF_DIR, 'blocklist.conf');

/**
 * Blank the legacy blocklist.conf (address= lines from before blocking moved
 * into the DNS proxy) and restart dnsmasq so it drops them. Returns whether
 * there was anything to blank.
 */
export function retireLegacyBlocklistConf() {
  const existing = fs.existsSync(BLOCKLIST_CONF) ? fs.readFileSync(BLOCKLIST_CONF, 'utf-8') : '';
  if (existing === '') return false;
  withValidatedDnsmasqUpdate(() => {
    atomicWrite(BLOCKLIST_CONF, '');
    return true;
  });
  restartDnsmasq();
  return true;
}

/**
 * Remove the legacy dhcp-leases.hosts. Lease hostnames used to be served
 * from it; they live in dns_records now, so a copy left from an old install
 * would serve stale names.
 */
export function removeLegacyLeaseHosts() {
  const legacyHostsPath = path.join(HOSTS_DIR, 'dhcp-leases.hosts');
  try {
    if (fs.existsSync(legacyHostsPath)) fs.unlinkSync(legacyHostsPath);
  } catch {
    /* ignore */
  }
}
