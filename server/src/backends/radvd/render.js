/**
 * radvd's configuration from CIDRella's DHCPv6 scopes, matching the Router
 * Advertisements dnsmasq sends for the same scopes (compared with rdisc6 on
 * Debian 13, 2026-10-10): router lifetime 0, so CIDRella is never offered
 * as a default router (IPV6-12); the lease time as both prefix lifetimes and
 * as the RDNSS and DNSSL lifetimes (IPV6-15); the link MTU; and per mode
 *   slaac      A on, M off, O off
 *   stateless  A on, M off, O on
 *   stateful   A off, M on, O on
 * The M and O flags belong to the interface, so an interface carrying more
 * than one scope sets each flag any of them asks for.
 */
import { leaseSeconds } from '../../utils/lease-time.js';

const DNS_SERVERS = 23;
const SEARCH_LIST = 24;

function lifetime(leaseTime) {
  const seconds = leaseSeconds(leaseTime);
  if (seconds === Infinity) return 'infinity';
  return Number.isFinite(seconds) && seconds > 0 ? String(seconds) : null;
}

const optionOf = (scope, code) => scope.options.find((option) => option.code === code);

/**
 * `links`: [{ name, mtu, scopes: [{ network, prefix, mode, leaseTime,
 * options }] }], scopes as loadDhcpScopes returns them. The text, or null
 * when there is nothing to advertise (radvd refuses an empty file).
 */
export function renderRadvdConfig(links) {
  const blocks = [];
  for (const link of links) {
    if (link.scopes.length === 0) continue;
    const modes = new Set(link.scopes.map((scope) => scope.mode));
    const lines = [
      `interface ${link.name} {`,
      '  AdvSendAdvert on;',
      '  IgnoreIfMissing on;',
      '  AdvDefaultLifetime 0;',
      `  AdvManagedFlag ${modes.has('stateful') ? 'on' : 'off'};`,
      `  AdvOtherConfigFlag ${modes.has('stateful') || modes.has('stateless') ? 'on' : 'off'};`,
    ];
    if (link.mtu) lines.push(`  AdvLinkMTU ${link.mtu};`);

    const servers = new Set();
    const domains = new Set();
    const lifetimes = [];
    for (const scope of link.scopes) {
      const life = lifetime(scope.leaseTime);
      if (life) lifetimes.push(life);
      lines.push(
        `  prefix ${scope.network}/${scope.prefix} {`,
        '    AdvOnLink on;',
        `    AdvAutonomous ${scope.mode === 'stateful' ? 'off' : 'on'};`,
        ...(life ? [`    AdvValidLifetime ${life};`, `    AdvPreferredLifetime ${life};`] : []),
        '  };',
      );
      for (const address of optionOf(scope, DNS_SERVERS)?.addresses || []) servers.add(address);
      for (const domain of (optionOf(scope, SEARCH_LIST)?.text || '').split(/[\s,]+/)) {
        if (domain) domains.add(domain);
      }
    }
    // One lifetime for the link's DNS options: the shortest prefix's.
    const shortest = lifetimes.includes('infinity')
      ? lifetimes.filter((life) => life !== 'infinity')
      : lifetimes;
    const dnsLife = shortest.length
      ? String(Math.min(...shortest.map(Number)))
      : lifetimes.length
        ? 'infinity'
        : null;
    if (servers.size) {
      lines.push(
        `  RDNSS ${[...servers].join(' ')} {`,
        ...(dnsLife ? [`    AdvRDNSSLifetime ${dnsLife};`] : []),
        '  };',
      );
    }
    if (domains.size) {
      lines.push(
        `  DNSSL ${[...domains].join(' ')} {`,
        ...(dnsLife ? [`    AdvDNSSLLifetime ${dnsLife};`] : []),
        '  };',
      );
    }
    lines.push('};');
    blocks.push(lines.join('\n'));
  }
  if (blocks.length === 0) return null;
  return `# Rendered by CIDRella from the DHCPv6 scopes; edits are overwritten.\n${blocks.join('\n\n')}\n`;
}
