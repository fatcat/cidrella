# DNSSEC validation

CIDRella can validate DNS answers with DNSSEC while keeping its blocklist +
GeoIP filtering. Toggle it from **DNS → DNSSEC Validation** in the UI.

## How it works

DNS requests flow through CIDRella's proxy (`server/src/utils/dns-proxy.js`)
which fronts dnsmasq for filtering. dnsmasq performs the actual DNSSEC
validation; the proxy makes the path correct end-to-end:

- **dnsmasq config** — when enabled, `regenerateDnsmasqConf()` injects a managed
  block into `dnsmasq.conf`: `dnssec`, `dnssec-check-unsigned`,
  `dnssec-no-timecheck`, and a root trust anchor (the distro-maintained
  `/usr/share/dnsmasq/trust-anchors.conf` via `conf-file=` when present,
  otherwise a hardcoded root KSK fallback). The block is a pure function of the
  `dnssec_enabled` setting — regen strips and re-adds it idempotently, so
  forwarder edits never leave DNSSEC state inconsistent.
- **TCP relay** — validating-stub resolvers (e.g. Debian with
  `systemd-resolved DNSSEC=yes`) set the DO bit, receive large signed answers,
  and fall back to TCP. The proxy now listens on **TCP** as well as UDP on each
  LAN address, length-prefix-frames messages, applies the same blocklist/GeoIP
  policy, and relays to dnsmasq's TCP port. Responses are relayed **verbatim**,
  preserving signatures and the query ID. TCP is additive — a TCP bind failure
  does not tear down the UDP path.
- **EDNS echo** — synthesized blocked/NXDOMAIN/SERVFAIL responses echo the
  client's EDNS OPT record (advertised UDP payload size + DO bit) so they stay
  well-formed for DNSSEC-aware clients. The AD (authenticated-data) flag is
  **not** set: a locally blocked domain is unsigned local policy, not a
  validated answer.

## Clock / NTP

DNSSEC checks each signature's validity window, so a skewed clock SERVFAILs
signed lookups. To avoid bricking resolution at boot:

- dnsmasq starts with `dnssec-no-timecheck` (lenient on timestamps).
- `install.sh` and `preflight.sh` enable NTP (`timedatectl set-ntp true`) as
  root; at runtime the backend can re-enable it via a narrow polkit grant
  (`org.freedesktop.timedate1.set-ntp`, `scripts/polkit/49-cidrella.rules`).
- Once the clock reports `NTPSynchronized=yes`, the backend
  (`server/src/utils/timesync.js`) sends dnsmasq **one** SIGHUP, switching it
  from lenient to enforcing signature timestamps. This re-arms on every restart.

`/api/health/system` reports `dnssec` (`enabled` / `supported` / `validating`)
and `ntp` (`available` / `ntpEnabled` / `synchronized`). `validating` is true
only when DNSSEC is enabled, dnsmasq supports it, and the clock is synced.

## Requirements / notes

- **dnsmasq must be built with DNSSEC.** `dnsmasq --version` lists `DNSSEC` (not
  `no-DNSSEC`) in its compile options. If it lacks support, the toggle is
  disabled in the UI and `PUT /api/dns/dnssec` returns 400 rather than writing a
  config dnsmasq rejects on start.
- **Authoritative write path is `PUT /api/dns/dnssec`** — only that route
  regenerates `dnsmasq.conf` and restarts dnsmasq (via the
  `regenerate_dnsmasq_conf` afterCommit hook). A bare `PUT /api/settings/dnssec_enabled`
  changes the value without applying it (same as `dns_upstream_servers` vs
  `/api/dns/forwarders`).

## Verifying

After enabling on a host (`dig` against CIDRella's LAN IP):

```
dig +dnssec cloudflare.com      # answer should carry the `ad` flag
dig +dnssec dnssec-failed.org   # SERVFAIL (validation rejects the bad signature)
dig +dnssec +tcp <signed-name>  # full signed answer over TCP (relay works)
```

Confirm blocklisted / GeoIP-blocked domains still return NXDOMAIN over both UDP
and TCP, and that `/api/health/system` reports `dnssec.validating: true` once
`ntp.synchronized` is true.
