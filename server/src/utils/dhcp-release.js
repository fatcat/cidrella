import { execFileSync } from 'child_process';
import { isValidIpv4 } from './ip.js';

const MAC_RE = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const INTERFACE_RE = /^[A-Za-z0-9_.:-]+$/;

export function routeInterfaceForIp(ip) {
  if (!isValidIpv4(ip)) return null;
  try {
    const output = execFileSync('ip', ['route', 'get', ip], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const match = String(output).match(/\bdev\s+(\S+)/);
    return match && INTERFACE_RE.test(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Ask the local dnsmasq process to forget a DHCPv4 lease. dhcp_release emits
 * the same DHCPRELEASE packet the client would send, so dnsmasq updates its
 * in-memory state and lease file instead of CIDRella editing a daemon-owned
 * file behind its back.
 */
export function releaseDnsmasqLease(lease) {
  if (!lease || !isValidIpv4(lease.ip_address) || !MAC_RE.test(lease.mac_address || '')) {
    return { released: false, skipped: 'invalid-identity' };
  }
  const interfaceName = routeInterfaceForIp(lease.ip_address);
  if (!interfaceName) return { released: false, skipped: 'no-route-interface' };

  try {
    execFileSync('dhcp_release', [
      interfaceName,
      lease.ip_address,
      lease.mac_address,
      lease.client_id || '*'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { released: true, interface: interfaceName };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { released: false, skipped: 'dhcp_release-not-installed' };
    }
    return {
      released: false,
      error: err?.stderr?.toString?.().trim() || err?.message || 'dhcp_release failed'
    };
  }
}
