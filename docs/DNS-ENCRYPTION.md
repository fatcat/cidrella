# Encrypted DNS forwarders (DoT / DoH)

Optionally encrypt the **CIDRella → upstream** DNS path so your lookups can't be
seen or tampered with in transit. Configure it under **Settings → DNS → DNS
Encryption**: Forwarders = **Off / TLS / HTTPS**.

> Client-side encrypted DNS (clients → CIDRella over DoT/DoH) is **not** in this
> feature — this is forwarders only.

## How it works

dnsmasq can't forward over DoT/DoH, so CIDRella runs a small **in-Node stub** on
`127.0.0.1:5356`. When encryption is on, `dnsmasq.conf` gets a single
`server=127.0.0.1#5356` (instead of the plain upstream IPs), and the stub:

- **TLS (DoT)** — opens a TLS connection to the upstream on `:853`, connecting by
  **IP** and verifying the certificate against the configured **hostname** (Node's
  CA store). Length-prefixed DNS over the tunnel.
- **HTTPS (DoH)** — `POST application/dns-message` to the upstream's DoH URL,
  connecting by IP (custom resolver) with SNI/cert validation against the hostname
  — so there's no bootstrap-DNS chicken-and-egg.

The stub relays the **raw** query/response, preserving EDNS/DO, so CIDRella's own
**DNSSEC validation still works end-to-end** when both are enabled.

**No external daemon** (stubby/dnsproxy) and no PKI for you to manage — you're the
*client* validating the upstream's public certificate. (Self-contained on purpose:
coupling seam #7 in `DNSMASQ-COUPLING.md` — a future PowerDNS Recursor would do
DoT/DoH natively and this stub goes away.)

## Fails closed

If the encrypted path fails (cert error, timeout, upstream down), CIDRella returns
**SERVFAIL** — it never silently falls back to plaintext, which would defeat the
purpose. The trade-off: resolution is down while the encrypted path is broken.
Errors surface in `/api/health/system` (`dnsEncryption.recentErrors`) and the DNS
settings status line.

## Use **unfiltered** upstreams

The presets ship the providers' **unfiltered** endpoints on purpose — CIDRella is
the single source of filtering (blocklist + GeoIP + the shared whitelist).
Pointing at a *filtered* upstream would double-filter: it would NXDOMAIN a domain
before CIDRella's logic runs, so your whitelist/override couldn't un-block it.

| Provider | Addresses | Hostname | Note |
|---|---|---|---|
| Cloudflare | 1.1.1.1 / 1.0.0.1 | cloudflare-dns.com | DNSSEC-transparent |
| Google | 8.8.8.8 / 8.8.4.4 | dns.google | DNSSEC-transparent |
| Quad9 (unfiltered) | **9.9.9.10** / 149.112.112.10 | dns10.quad9.net | ⚠ NOT 9.9.9.9 (that tier is malware-filtered) |
| AdGuard (unfiltered) | 94.140.14.140 / .141 | unfiltered.dns.adguard-dns.com | |

"Custom" lets you enter IP(s) + hostname + DoH URL for any other resolver.

> If you ever *want* upstream filtering, you'd turn off CIDRella's own filtering
> instead — they're mutually exclusive. Not offered as a mode today.

## Notes / limitations

- The stub is a hot-path component; under **fail-closed**, a broken encrypted path
  means DNS is down (by design). It runs in the main CIDRella process.
- DoT currently uses a fresh TLS connection per query; dnsmasq's cache keeps
  upstream QPS low so the handshake cost is bounded. Connection pooling /
  session-resumption is a future optimization.
- Quad9's unfiltered tier is non-validating — fine because CIDRella validates —
  as long as it's DNSSEC-transparent (it is). Prefer Cloudflare/Google if you want
  both DNSSEC and encryption with maximum margin.
