# Review findings

Open issues found by review, audits and agents, and not fixed yet. How to use this file is in
`AGENTS.md` (Review findings): record an issue here when you find it and do not fix it in the
same change; when it is fixed, delete its entry in the commit that fixes it and name the ID in
the commit message. Git history is the record of what was fixed.

Each entry: an ID, the severity (**high**: wrong data, a broken feature or a security issue;
**medium**: a parity gap or wrong display; **low**: cosmetic, gating or a test gap), whether it
was confirmed in the code or is only plausible, where it is, what happens, why, and the fix that
was suggested.

---

## IPv6 audit (2026-10-01)

Six auditors (address helpers, networks and lifecycle, DNS, DHCPv6, detection, client UI) read
`dev/0.5.0` at `78c7ada` against the IPv4 and IPv6 rules in `AGENTS.md` and the IPv6
paragraph of `docs/ARCHITECTURE.md`; a skeptic per area then tried to refute each finding.
Where two auditors found the same bug from different sides it is one entry with both sites.

### Scanning, liveness, rogue and anomaly detection

#### IPV6-35: Anomaly identity and training ignore DUID and ND MAC, so IPv6 clients (especially privacy addresses) are never scored and allowlists don't cover a host's IPv6 traffic

**medium**, confirmed. `server/src/models/anomaly.js:24`

- **What happens:** (1) A dual-stack laptop has v4 identity aa:bb:cc:dd:ee:ff from its lease. The operator allowlists it by its v4 address, which stores that MAC identity, but its IPv6 queries from 2001:db8:1::abcd are scored under identity '2001:db8:1::abcd' and keep raising anomalies. (2) A host using RFC 8981 temporary addresses (Linux, Windows and macOS default) gets a new source address about every 24h. Each one starts at 0h history and never reaches 48h, so it sits in 'learning' forever and its IPv6 DNS traffic is never scored. Analytics top-clients likewise lists each temporary address as a separate client with no hostname.
- **Why:** `resolveIdentity`: `SELECT mac_address FROM dhcp_leases WHERE ip_address = ?` and `row?.mac_address || clientIp`, mirrored in server/anomaly/storage.py:65-97 resolve_device_key. DHCPv6 leases are stored with `mac: null` (utils/dhcp.js:482, identity in `duid`), and SLAAC hosts have no lease, so every IPv6 client's identity is its current address. Training is also keyed per client_ip: features.get_client_history_hours(client_ip) has to reach MIN_TRAINING_HOURS=48 (config.py:21), and extract_training_data(client_ip) also works per address.
- **Verifier:** resolveIdentity (server/src/models/anomaly.js:24-26) and resolve_device_key (server/anomaly/storage.py) both key on dhcp_leases.mac_address. parseLeaseLine stores DHCPv6 leases with mac: null (utils/dhcp.js:482), so every IPv6 client resolves to its address, while an IPv4 lease holder resolves to its MAC. BACKLOG.md:187 lists 'IPv6 anomaly identities' as landed, so this is a gap against a stated feature, not an intended difference. Training history is per client_ip with MIN_TRAINING_HOURS=48 (config.py:21), so a rotating RFC 8981 temporary address plausibly never leaves learning. Note that per-IP history also resets on an IPv4 renumbering; rotation is what makes it routine on IPv6. The dual-stack allowlist scenario is real, but DUID and MAC are different identities, so a fix would need ND MAC correlation, not just DUID.
- **Fix:** Resolve IPv6 identity from the DHCPv6 lease DUID, or from ip_addresses.last_seen_mac (populated from the ND table) and the EUI-64 interface ID, in both resolveIdentity and resolve_device_key. Key the history and training queries on identity (all client_ips mapped to it) rather than on one address.
