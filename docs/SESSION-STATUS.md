# Session Status

Updated: 2026-10-08

Snapshot of where the tree stands. [RELEASE-NOTES.md](../RELEASE-NOTES.md) is canonical
for what actually shipped. [BACKLOG.md](../BACKLOG.md) is the one place for work in
flight, and [REVIEW.md](../REVIEW.md) the list of known issues.

## Current State

**v0.4.18 is the latest release** (2026-09-18), and `main` is at its release-notes commit.
Everything since lives on three development lines, each merged forward into the next:

| Branch | Version | Schema | What it is |
|---|---|---|---|
| `dev/0.5.0` | 0.5.0 | 86 | The 0.5.0 release line. `v0.5.0-pre.15` is the newest pre-release. |
| `dev/0.5.1` | 0.5.1 | 86 | 0.5.0 plus the DNS/DHCP backend layer (`server/src/backends/`). |
| `dev/0.5.2` | 0.5.2 | 86 | 0.5.1 plus Kea as a hidden second DHCP server. Release candidates only. |

0.5.2 and 0.5.3 are never released on their own: 0.5.3 adds the PowerDNS + Kea stack, and the
release that carries both stacks is **0.6.0**. A host runs one stack, dnsmasq or
PowerDNS + Kea, and can switch both ways.

Every 0.5.x line has `min_from: "0.4.17"`, so a 0.4.17 or 0.4.18 install upgrades to any of
them directly.

### 0.5.0

The release notes list it all; the large pieces are the networks and settings workspaces,
IPv6 behind one switch (networks, AAAA and `ip6.arpa`, DHCPv6 per network, rogue DHCPv6 and
router detection), the reworked Analytics pages and anomaly triage, first-run setup,
two-factor sign-in, DHCP Bulk Change, and DNS forwarding through CIDRella's forwarder with a
backup resolver (On failure or Load balance) and a resolver performance test.

Landed 2026-10-08, after `pre.15`:

- **DHCP defaults are opt-in per scope** (DHCP-01). A default reaches a scope only through a
  linked row (`dhcp_scope_options.value IS NULL`, Use default in the scope dialog), which
  follows later edits of the default. Migration 086 links every scope to each default it was
  being served, so an upgrade changes nothing a client receives. The DHCPv6 NTP default (56)
  is seeded at boot, after migrations, so a 0.4.x upgrade does not add it to existing IPv6
  scopes; Bulk Change does that.
- **An IPv6 option 51 is served** (DHCP-03). 51 is lease time in DHCPv4 only.
- **One network fill rule** (DHCP-02). `networkOptionFills` in
  `server/src/utils/dhcp-network-options.js` is what a scope takes from its network, for
  the server and, through `@shared`, the scope dialog. This also fixed a crash in the dialog
  when picking an IPv6 range while a default with a value was ticked.
- **DNS table row checkboxes are named** (A11Y-01): a record without an address was read
  out as "Select null".

### 0.5.1

The backend layer: a registry under `server/src/backends/` with dnsmasq as the first DNS,
DHCP and RA backend, and health that reports backends by role. The rendered dnsmasq output
is pinned by golden tests (`server/tests/integration/backends/dnsmasq-golden.test.js`).

### 0.5.2

Kea 3.0 ships with native installs and updates but is hidden: Settings > DHCP > Server is
not in the settings areas, and `/api/dhcp/server` is admin-only for harness and testerella
testing. Kea output is pinned by `kea-golden.test.js`; `kea/live.test.js` needs a real Kea
and is skipped elsewhere.

## Hosts

- **Production (10.0.3.250)** runs `v0.5.0-pre.15`.
- **testerella (10.0.0.8)** runs `dev/0.5.1` through `scripts/deploy-lxc.sh`, so its
  `RELEASE.json` still names `pre.15`. Schema 86. DHCP is off there (`dhcp_enabled` false),
  so live DHCP serving is not exercised on it.

## Validation

At `dev/0.5.0` `3a60c88`:

- `npm run test:server`: 169 files, 1768 tests passed, 2 skipped.
- `npm run test:client`: 114 files, 729 tests passed.
- `npm run lint`, `npm run check:reuse`, `npm run check:db-ownership`,
  `npm run build:client`, the release-version guard and the release-notes lint passed.
- madge reports one circular chain, the CI baseline.
- `MODEL_SEEDS=100 npm run hunt:workspace` passed.

The DHCP-01 merge was gated on `dev/0.5.1` (server 1826, client 734) and `dev/0.5.2`
(server 1960, client 742), with the dnsmasq and Kea goldens unchanged.

On testerella, migration 086 was checked against real data: each scope gained one linked
row for the default it was already served, and the scope files the new code renders are
byte-identical to the ones before the upgrade.

Not yet validated:

- **No pre-release carries the 2026-10-08 DHCP work.** `pre.15` predates it.
- The disposable-appliance live DHCP matrix and the full pre-release security pipeline
  remain release gates, deferred until DHCP can be enabled on a test interface.

## Next Resume

Work in flight lives in [BACKLOG.md](../BACKLOG.md). Do not restart a second list here.

Open threads specific to this snapshot:

- Cut `v0.5.0-pre.16` with the DHCP work and soak it on production.
- Release 0.5.0, then cut 0.5.1 (its RELEASE-NOTES date is still a placeholder).
- REVIEW.md: DNSMASQ-08 (dnsmasq sizes a DHCPv4 option it does not know, such as Path MTU
  Aging Timeout, by the value's shape) is open on every line. DNSMASQ-02 (duplicate log lines
  on a reservation change) stays open by decision. On 0.5.1, DNSMASQ-06 and DNSMASQ-07 are
  open too, dnsmasq traits the backend layer kept on purpose; 0.5.2 fixes both.

Known bad metadata, not fixable in place: the `v0.4.18-pre.1` through `pre.3` tags point at
0.4.17 code (`gh release create` had no `--target`; fixed forward). Read `RELEASE.json`
inside a signed tarball to learn the commit it was built from.
