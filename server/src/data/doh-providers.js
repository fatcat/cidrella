// Preset encrypted-DNS upstreams, shared by the API and the UI.
//
// IMPORTANT: these are the **unfiltered** endpoints. CIDRella is the single
// source of filtering (blocklist + GeoIP + the shared whitelist), so the upstream
// must NOT filter — double-filtering would block domains before CIDRella's logic
// runs and break the whitelist/override model.
//
// Each provider carries: IPv4 addresses (we connect by IP and verify the cert
// against `hostname`, avoiding a bootstrap-DNS chicken-and-egg), the DoT/DoH
// `hostname`, and the DoH `doh_url`. `dnssecTransparent` = returns RRSIGs so
// CIDRella's own DNSSEC validation still works end-to-end.

export const DOH_PROVIDERS = [
  {
    id: 'cloudflare',
    label: 'Cloudflare — unfiltered (1.1.1.1)',
    addresses: ['1.1.1.1', '1.0.0.1'],
    hostname: 'cloudflare-dns.com',
    doh_url: 'https://cloudflare-dns.com/dns-query',
    dnssecTransparent: true,
  },
  {
    id: 'google',
    label: 'Google — unfiltered (8.8.8.8)',
    addresses: ['8.8.8.8', '8.8.4.4'],
    hostname: 'dns.google',
    doh_url: 'https://dns.google/dns-query',
    dnssecTransparent: true,
  },
  {
    // Quad9 UNFILTERED tier — NOT 9.9.9.9 (that one is malware-filtered).
    // dns10 is non-validating but DNSSEC-transparent (passes RRSIGs).
    id: 'quad9',
    label: 'Quad9 — unfiltered (9.9.9.10)',
    addresses: ['9.9.9.10', '149.112.112.10'],
    hostname: 'dns10.quad9.net',
    doh_url: 'https://dns10.quad9.net/dns-query',
    dnssecTransparent: true,
  },
  {
    id: 'adguard',
    label: 'AdGuard — unfiltered (94.140.14.140)',
    addresses: ['94.140.14.140', '94.140.14.141'],
    hostname: 'unfiltered.dns.adguard-dns.com',
    doh_url: 'https://unfiltered.dns.adguard-dns.com/dns-query',
    dnssecTransparent: true,
  },
];

export function getProvider(id) {
  return DOH_PROVIDERS.find(p => p.id === id) || null;
}
