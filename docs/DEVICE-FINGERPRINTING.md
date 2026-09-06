# Passive device / OS fingerprinting

CIDRella identifies *what* each host is (device type and OS family) without any
active scanning, using the DHCP data it already sees as the DHCP server. Surfaced
as a **Device** column in the IP table and a per-host **"More info"** popup
(right-click an IP → More info).

## How it works

Because CIDRella *is* the DHCP server (dnsmasq), every client that takes a lease
hands it a highly device-specific signature for free:

- **DHCP option 55** (parameter request list): the ordered set of options a
  client asks for is OS/stack-specific.
- **DHCP option 60** (vendor class identifier): e.g. `MSFT 5.0`, `android-dhcp-13`.
- the supplied **hostname** (e.g. `Johns-iPhone`, `DESKTOP-AB12CD`).
- the **MAC OUI** → manufacturer (reuses the existing vendor lookup).

`dnsmasq` already logs these with `log-dhcp`. A watcher
(`server/src/utils/dhcp-fingerprint.js`) tails `dnsmasq.log` (reusing the same
`readLogTail` + poll pattern as passive liveness), reconstructs each transaction
from its log block (correlated by dnsmasq's transaction id), and on the `DHCPACK`
classifies the signals with an **offline heuristic ruleset**
(`server/src/data/device-fingerprints.js` + `utils/device-classifier.js`). The
collector retains dnsmasq's wrapped option-55 fragments and waits briefly after
`DHCPACK` for the trailing option detail before classifying. The strongest result
is stored per-MAC in `device_fingerprints` and attached to IP rows during the
normal IP-view enrichment (alongside the OUI vendor). A partial renewal can add
evidence but cannot erase a stronger result.

Everything is offline and self-contained: **no cloud API, no raw sockets, no
nmap, no dnsmasq restart**. A confidence score (0–100) reflects how strong the
match is; agreement across signals boosts it.

## What you get

- A compact **Device** column (OS family / device type), plus optional columns
  for OS, device type, confidence, option 55, vendor class, captured hostname,
  and fingerprint source.
- A **"More info"** popup with identity, liveness, and the full device
  fingerprint: manufacturer, device type, OS family, confidence, and the raw
  option 55 / option 60 / hostname.
- An operator **override** (`PUT /api/devices/:mac/fingerprint`): a manually set
  type/OS is never clobbered by a later automatic capture.

## Limitations

- **DHCP clients only.** Statically-configured hosts never DHCP, so they get only
  the MAC OUI manufacturer + hostname, not a fingerprint.
- **Device-family granularity, not exact version.** You get "Windows", "Apple
  iOS", "Android", "Printer", etc. (what an IPAM actually needs), not the exact
  build.
- **Appears on next lease.** A device already holding a lease isn't fingerprinted
  until it next requests/renews (within its lease time).
- **Heuristic coverage.** Unknown devices fall back to manufacturer + "Unknown"
  rather than a wild guess. The ruleset lives in one data file and is easy to tune.
- **Log-format dependency**: parses `dnsmasq`'s `log-dhcp` output (the same
  dependency passive liveness + metrics already rely on).
