import { execFileSync } from 'child_process';
import { isValidIpv4, isValidAddress } from '../../utils/ip.js';
import { isValidIpv6 } from '../../utils/address.js';
import { readServerDuid } from './lease-file.js';

const MAC_RE = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const INTERFACE_RE = /^[A-Za-z0-9_.:-]+$/;

export function routeInterfaceForIp(ip) {
  if (!isValidAddress(ip)) return null;
  try {
    const args = isValidIpv6(ip) ? ['-6', 'route', 'get', ip] : ['route', 'get', ip];
    const output = execFileSync('ip', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
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
  if (lease?.dhcp_version === 6 || (lease && isValidIpv6(lease.ip_address))) {
    return releaseDnsmasqLease6(lease);
  }
  if (!lease || !isValidIpv4(lease.ip_address) || !MAC_RE.test(lease.mac_address || '')) {
    return { released: false, skipped: 'invalid-identity' };
  }
  const interfaceName = routeInterfaceForIp(lease.ip_address);
  if (!interfaceName) return { released: false, skipped: 'no-route-interface' };

  try {
    execFileSync(
      'dhcp_release',
      [interfaceName, lease.ip_address, lease.mac_address, lease.client_id || '*'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { released: true, interface: interfaceName };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { released: false, skipped: 'dhcp_release-not-installed' };
    }
    return {
      released: false,
      error: err?.stderr?.toString?.().trim() || err?.message || 'dhcp_release failed',
    };
  }
}

const DUID_RE = /^([0-9a-f]{2}:){1,129}[0-9a-f]{2}$/i;

// dhcp_release6 retries five times a second apart before giving up; bound it
// so a release that gets no answer cannot hold the event loop past that.
const RELEASE_TIMEOUT_MS = 8000;

/**
 * The DHCPv6 counterpart. dhcp_release6 sends a RELEASE on the client's behalf
 * and needs dnsmasq's server DUID (its --server-id; dnsmasq drops a RELEASE
 * whose server id is not its own), the client DUID and the IAID. Without
 * those, or without the utility, the lease is left alone.
 */
function releaseDnsmasqLease6(lease) {
  const duid = lease?.duid || lease?.client_id;
  if (!lease || !isValidIpv6(lease.ip_address) || !DUID_RE.test(duid || '')) {
    return { released: false, skipped: 'invalid-identity' };
  }
  if (lease.iaid == null || !/^\d+$/.test(String(lease.iaid))) {
    return { released: false, skipped: 'invalid-identity' };
  }
  const interfaceName = routeInterfaceForIp(lease.ip_address);
  if (!interfaceName) return { released: false, skipped: 'no-route-interface' };
  const serverDuid = readServerDuid();
  if (!serverDuid) return { released: false, skipped: 'no-server-duid' };

  try {
    execFileSync(
      'dhcp_release6',
      [
        '--iface',
        interfaceName,
        '--server-id',
        serverDuid,
        '--client-id',
        duid,
        '--iaid',
        String(lease.iaid),
        '--ip',
        lease.ip_address,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: RELEASE_TIMEOUT_MS },
    );
    return { released: true, interface: interfaceName };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { released: false, skipped: 'dhcp_release6-not-installed' };
    }
    return {
      released: false,
      error: err?.stderr?.toString?.().trim() || err?.message || 'dhcp_release6 failed',
    };
  }
}
