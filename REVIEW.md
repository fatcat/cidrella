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

### Networks and the IP lifecycle

#### IPV6-06: The network address of an IPv6 /127 (and /128) is treated as a protected system address, contradicting topologyAddresses and RFC 6164

**low**, confirmed. `server/src/services/ip-lifecycle-service.js:40`

- **What happens:** Configure fd00:3::/127 with gateway_policy none. PUT /ips/fd00:3::/allocation {reserved} returns 400 'The network address is managed by subnet topology', and GET /ips/fd00:3:: reads allocation_state 'system', although no system row exists and validateGatewayForSubnet accepts fd00:3:: as a usable gateway. A /128 network has no usable address at all. 10.30.0.0/31 is refused the same way.
- **Why:** protectedAddress returns SYSTEM whenever value === parsed.networkBig, with no prefix check. ipAllocationRejectionReason (routes/subnets.js:2710) and buildVirtualSubnetIpRow (models/ip-view.js:117) do the same. topologyAddresses and parseNetwork say 'Point-to-point and host prefixes reserve nothing' (on /127 and /128 firstUsable is the network address), and createSystemRanges and reconcileTopologyAddresses create no system row there. RFC 6164 makes both /127 addresses usable, with no subnet-router anycast. The same inconsistency applies to IPv4 /31 and /32 (both endpoints protected), so it is not v6-only.
- **Verifier:** Reproduced. fd00:3::/127 with gateway_policy none configures with no ip_addresses rows. PUT /ips/fd00:3::/allocation {reserved} returns 400 'The network address is managed by subnet topology', and GET /ips/fd00:3:: reads allocation_state 'system'. This contradicts utils/cidr.js:89-91 ('except on /127 and /128') and :351 ('Point-to-point and host prefixes reserve nothing'). protectedAddress (ip-lifecycle-service.js:54) and buildVirtualSubnetIpRow have no prefix check. IPv4 /31 and /32 have the same inconsistency, so this is not IPv6-specific. The impact is limited to point-to-point links.
- **Fix:** Derive the protected set from topologyAddresses(parsed) in all three places (protectedAddress, ipAllocationRejectionReason, buildVirtualSubnetIpRow) instead of comparing networkBig and lastBig directly. Add /127 and /31 tests.

#### IPV6-08: Default network name template truncates IPv6 to the first four hextets, so sibling /65+ networks get identical, misleading names

**low**, plausible. `server/src/utils/cidr.js:317`

- **What happens:** Two /127 point-to-point links, 2001:db8:0:ff::/127 and 2001:db8:0:ff::2/127, are both auto-named '2001:db8:0:ff/127'. Neither name is the network, and the two cannot be told apart in lists.
- **Why:** networkNameFromTemplate fills %1-%4 from the first four hextets for IPv6, and the default template is '%1.%2.%3.%4/%bitmask'. For IPv4 those four placeholders cover the whole address. For IPv6 they cover only the top 64 bits.
- **Verifier:** The behaviour is documented and intended (cidr.js:307-314: '%1 to %4 are the first four groups'), and only a default name suggestion is affected. Still, with the default template '%1.%2.%3.%4/%bitmask' (config/defaults.js:28), any IPv6 network longer than /64 gets a name that is not its network, and /127 siblings such as 2001:db8:0:ff::/127 and ::2/127 both become '2001:db8:0:ff/127'. Cosmetic and easy to rename.
- **Fix:** For IPv6 prefixes longer than /64, either render the canonical network (formatIp of networkBig) when the template is the default, or add a placeholder that expands to the canonical compressed network address.

### DHCPv6 and Router Advertisements

#### IPV6-20: Passive device fingerprinting only understands DHCPv4, so DHCPv6-only or SLAAC-only devices are never classified

**low**, confirmed. `server/src/utils/dhcp-fingerprint.js:81`

- **What happens:** An IPv6-only IoT device that does a DHCPv6 SOLICIT/REQUEST/REPLY with vendor class 'xyz' ends up with no device_fingerprints row. Its address row shows device_type null even when the ND MAC is known.
- **Why:** A transaction is finalized only on `DHCPACK`, with the regex `/^DHCP(DISCOVER|REQUEST|ACK|INFORM)\b/`, and identity is a MAC parsed from the line. DHCPv6 transactions (identified by DUID, ending in DHCPREPLY, with vendor class option 16 and ORO option 6) never finalize, so nothing is persisted. A DHCPv6 DHCPREQUEST line does match, and extractMac runs on the DUID, but that partial transaction is discarded as stale. This is not wrong data, but it means IPv6-only hosts get no device_type or os_family. If v6 support is added, the ORO codes must not be mixed into the option-55 (DHCPv4) fingerprint namespace.
- **Verifier:** ingestLine (server/src/utils/dhcp-fingerprint.js:81-99) sets ackSeen only on DHCPACK, and drainFinalized requires ackSeen. A DHCPv6 exchange ends in DHCPREPLY, so it never finalizes and the stale sweep drops it. No v6 traffic leaks into the option-55 namespace, because nothing is persisted. This is a parity gap only: IPv6-only hosts get no device_type or os_family. Low.
- **Fix:** Either document this as DHCPv4-only (with a comment, per AGENTS.md), or add a DHCPv6 path keyed by the lease's DUID/ND MAC that records ORO and option 16 in separate fields from opt55. Also stop the DHCPv4 regex from matching DHCPv6 DHCPREQUEST lines.

#### IPV6-22: DHCPv6 leases and reservations get no MAC, so no vendor fallback name, although DUID-LLT/LL embed the link-layer address

**low**, plausible. `server/src/models/dhcp-lease.js:238`

- **What happens:** An unnamed DHCPv6 client with DUID 00:01:00:01:2e:3f:40:51:aa:bb:cc:dd:ee:ff gets no hostname and no AAAA record, and shows no MAC. The same device over DHCPv4 is named '<vendor>-device' and shows aa:bb:cc:dd:ee:ff.
- **Why:** parseLeaseLine sets `mac: null` for v6. assignLeaseNames only applies `fallbackName(lease.mac)`, and utils/dhcp.js:530-533 notes 'DHCPv6 clients have no MAC to look a vendor up by'. DUID types 1 (LLT) and 3 (LL) carry a hardware type and the MAC, and the probe already builds such DUIDs (clientDuidFor).
- **Verifier:** The code is as described (dhcp.js:476-486 mac:null, dhcp-lease.js:238 fallback only on lease.mac). It is acknowledged in a comment (dhcp.js:530-533), and API_MODEL.md says the v6 MAC is 'learned metadata, when present', which the neighbor table can also supply. RFC 8415 says DUIDs are opaque, and the link-layer address in a DUID-LLT/LL is often a different or stale interface. So this is an enhancement-level parity gap rather than a defect.
- **Fix:** Add a helper in utils/duid.js that extracts the Ethernet MAC from DUID-LLT/LL (hardware type 1), use it to fill lease.mac for v6 leases (for display and fallback naming), and leave it null for DUID-EN/UUID.

### DNS, the DNS proxy and DoH

#### IPV6-25: After dividing an IPv6 network across a nibble boundary, deallocating a child leaves its generated PTRs served in the parent's ip6.arpa zone

**medium**, confirmed. `server/src/services/subnet-dns-topology.js:62`

- **What happens:** Configure fd00:6::/63 with create_reverse_dns and reserve fd00:6::50, which creates a placeholder PTR in 0.0.0.0.0.0.0.6.0.0.0.0.0.d.f.ip6.arpa. Divide to /64, then GET /deallocation-preview of fd00:6::/64: generated_ptr 0, reverse_zones []. DELETE it: the PTRs for fd00:6::50 and fd00:6:: stay enabled even after reconcileManagedReverseDns, so reverse DNS keeps answering for a network that no longer exists. IPv4 shows this only when a divide crosses an octet zone boundary (for example /16 to /17); for IPv6 it happens on any divide crossing a multiple of 4, including the common /56 to /64.
- **Why:** dnsDeallocationImpact finds the zones to clean only by exact name: generateReverseNames(subnet.cidr).map(name => SELECT ... WHERE name = ?). For IPv6 the zone sits at floor(prefix/4) nibbles, so a /64 child of a /63 or /56 parent looks for a 16-nibble zone that was never created. migrateConfigToChild (routes/subnets.js:1207) only sets has_reverse_dns and does not create the child's zone. findReversePtrLocation and reconcileManagedReverseDns still write the child's PTRs into the parent's existing zone, the most specific one that exists, so the cleanup and the writer disagree about where those PTRs live.
- **Verifier:** Reproduced. fd00:6::/63 with reverse DNS creates zone 0.0.0.0.0.0.0.6.0.0.0.0.0.d.f.ip6.arpa with placeholder PTRs for fd00:6:: and fd00:6::1. After dividing to /64, the deallocation-preview of fd00:6::/64 shows generated_ptr 0 and reverse_zones []. After DELETE, plus an explicit reconcileManagedReverseDns, the PTRs for fd00:6:: and fd00:6::1 are still enabled in an enabled zone, although the network is unallocated with has_reverse_dns 0. dnsDeallocationImpact looks zones up by exact generateReverseNames name only (subnet-dns-topology.js:62-64), and migrateParentZonesToChildren is a no-op. IPv4 can hit the same thing, but for IPv6 any divide across a nibble boundary, such as /56 to /64, triggers it.
- **Fix:** In dnsDeallocationImpact, select the PTRs to clean by containment rather than zone name: every enabled reverse zone whose reverseZoneNetwork overlaps the subnet, keeping generated PTRs whose ipForPtrRecord falls inside subnet.cidr. Alternatively create the child's own nibble zone during divide and move its PTRs there. Add an IPv6 divide-then-deallocate reverse DNS test.

#### IPV6-26: Removing an AAAA (or an IPv6 reservation) leaves a placeholder PTR for an address that is no longer allocated

**medium**, confirmed. `server/src/utils/ip-sync.js:186`

- **What happens:** On fd00:6::/64 with reverse DNS, create AAAA host1 -> fd00:6::10, move it to fd00:6::11, then delete it. fd00:6::10 and fd00:6::11 are both 'unassigned', but the PTR rows 0.1.0.0… and 1.1.0.0… stay in the ip6.arpa zone with value 'fd00:6::10' / 'fd00:6::11' and source 'placeholder'. Every AAAA or IPv6 reservation ever created or moved leaves a permanent row that the DNS tables list.
- **Why:** clearDnsFromIp always calls `setPtrForIp(db, ip, canonical.hostname || ip, …)`. clearPtrForIp (models/dns-record.js:733) and the reservation path syncPtrForIp(..., '', placeholder) do the same. For an IPv6 address with no remaining name, this upserts a PTR row whose value is the bare address instead of deleting it. ARCHITECTURE.md says IPv6 reverse projection writes PTR rows only for allocated addresses, and reconcileManagedReverseDns never walks IPv6, so these rows are never removed. The DHCPv6 lease-expiry path (deleteDynamicDhcpRecordsByIps) does delete its PTR, so the IPv6 paths disagree with each other. Note: dns-ipv6.test.js:146-150 currently asserts this leftover row, so the maintainer may consider it intended. I am reporting it because it contradicts the documented model.
- **Verifier:** The cited paths call setPtrForIp(db, ip, canonical.hostname || ip, ...) without checking the family: ip-sync.js:186, clearPtrForIp, and syncPtrForIp with a falsy hostname. setPtrForIp (models/dns-record.js:455) then upserts a row whose value is the bare address. Removing an AAAA therefore leaves a placeholder PTR on an unallocated v6 address. That contradicts ARCHITECTURE.md lines 120-123 ('PTR rows only for allocated addresses') and the reconcileManagedReverseDns docstring ('IPv6 ... only allocated addresses get a PTR, and there are no placeholders'). reconcileManagedReverseDns never walks IPv6, so nothing ever removes these rows. However, dns-ipv6.test.js (around line 146) explicitly asserts the leftover value 'fd00:6::11', so the maintainer may have written this deliberately. The code contradicts its own docs either way, but because the test asserts it, this rates medium rather than high.
- **Fix:** In setPtrForIp, or in its clear callers: when the address is IPv6 and no hostname remains, delete the PTR row unless the address is still allocated (topology or reserved), instead of writing an IP placeholder. Update the dns-ipv6 test to expect no row.

#### IPV6-27: Blocked query is logged as NXDOMAIN when only an IPv6 sinkhole is configured, but NOERROR is sent

**low**, confirmed. `server/src/utils/dns-proxy.js:482` (also `server/src/utils/dns-proxy.js:482`)

- **What happens:** Set blocklist_redirect_ip6 = fd00::1 and leave blocklist_redirect_ip empty. A blocked AAAA (or A) query gets a NOERROR reply on the wire, but analytics record NXDOMAIN, so the response-code charts disagree with what clients received.
- **Why:** evaluateInboundPolicy logs `responseCode: blocklistRedirectIp ? 'NOERROR' : 'NXDOMAIN'` and considers only the v4 redirect. createBlockedResponse sends NOERROR whenever `blocklistRedirectIp || blocklistRedirectIp6` is set (352).
- **Verifier:** dns-proxy.js:482 computes the logged responseCode from blocklistRedirectIp alone. createBlockedResponse (line 352) answers NOERROR whenever either redirect is set. With only blocklist_redirect_ip6 configured, the wire reply is NOERROR (an AAAA sinkhole, or an empty answer for A) while the log records NXDOMAIN. Analytics only.
- **Fix:** Use `responseCode: blocklistRedirectIp || blocklistRedirectIp6 ? 'NOERROR' : 'NXDOMAIN'`, the same condition createBlockedResponse uses.

#### IPV6-28: A /128 network's reverse zone has 32 nibbles, which PTR lookup never matches

**low**, confirmed. `server/src/utils/dnsmasq.js:189`

- **What happens:** Allocate 2001:db8:1::5/128 with create_reverse_dns. The zone 5.0.…​.8.b.d.0.1.0.0.2.ip6.arpa is created but holds no PTR (I checked: PTRs = []). The equivalent 10.9.9.9/32 gets its placeholder PTR in 9.9.10.in-addr.arpa.
- **Why:** generateReverseNames uses `Math.max(1, Math.floor(prefix / 4))` nibbles, which is 32 for a /128, so the zone name is the full PTR owner name. reversePtrCandidates (models/dns-record.js:363) only tries `zoneNibbles = 31 … 1`, so that zone is never a candidate. The route's REVERSE_ZONE_RE also accepts 32-nibble manual zones.
- **Verifier:** I checked both helpers with node. generateReverseNames('2001:db8:1::5/128') produces a zone with 32 nibble labels, while reversePtrCandidates('2001:db8:1::5') returns 31 candidates with at most 31 zone nibbles. The /128 zone can never be matched, so it stays empty. The IPv4 /32 gets a 3-octet zone that does hold its PTR. This is an edge case: a /128 network with reverse DNS is unusual.
- **Fix:** Cap the zone at 31 nibbles (`Math.min(31, …)`, so a /128 uses its /124 zone). Refuse 32-nibble names in REVERSE_ZONE_RE.

#### IPV6-29: PTR name validation does not check the ip6.arpa nibble shape or count

**low**, confirmed. `server/src/routes/dns.js:192`

- **What happens:** In zone 0.0.0.0.1.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa, POST PTR name '7' value 'z.v6.test' returned 201. The row has ip_address null and emits a ptr-record for a name that is not an address. Names like 'ff.1' or '255' are accepted too. 'A.0.0.…' is refused with 400.
- **Why:** PTR records are validated only with isValidPtrName, which accepts `/^[0-9a-f]+(\.[0-9a-f]+)*$/` for any zone. Nothing checks that each label in an ip6.arpa zone is a single nibble, or that the record plus zone labels add up to 32. ipForPtrRecord then returns null for such rows. Uppercase nibbles are rejected rather than lowercased.
- **Verifier:** PTR names are validated only by isValidPtrName (dnsmasq-escape.js:39): /^[0-9a-f]+(\.[0-9a-f]+)*$/ with up to 63 characters. It applies no per-zone nibble or label-count check, so 'ff.1' or '7' is accepted in an ip6.arpa zone. This laxity is not IPv6-specific, though: the same check accepts 'ff' or '999' in an in-addr.arpa zone. Only the uppercase-nibble 400 is v6-specific. The regex still blocks injection, so this is a validation gap with low impact.
- **Fix:** For reverse zones, check ipForPtrRecord(name, zone.name) !== null (32 single nibbles for ip6.arpa, 4 octets for in-addr.arpa), and lowercase the name before validating.

### Scanning, liveness, rogue and anomaly detection

#### IPV6-53: IPv6 discovery counts a STALE neighbor entry as presence, so a departed host flips online then offline on every scan

**low**, confirmed by reading (found while fixing IPV6-32/33). `server/src/utils/scanner.js` discoverIpv6Hosts, `server/src/utils/nd-cache.js` SEEN_STATES

- **What happens:** A host leaves a network. The kernel keeps its neighbor entry as STALE until garbage collection, often for minutes or longer. On each scan in that window, discoverIpv6Hosts returns the host and observeIpv6Presence marks its row online ('online' event, last_seen_at refreshed). The scan's echo then fails, the entry goes DELAY, PROBE and FAILED with no answer, and the row is marked offline ('offline' event). The final state is right, but every scan writes an online/offline pair of events for a host that is gone.
- **Why:** parseNeighTable keeps STALE (and DELAY, PROBE, PERMANENT, NOARP) entries as SEEN_STATES, and discovery treats every kept entry inside the prefix as present. STALE only means the kernel heard from the host at some point. The scan's own verdict (confirmByNeighborDiscovery) already refuses STALE as evidence.
- **Fix:** In discovery, count only REACHABLE entries (fresh after the all-nodes echo) as presence. Leave older entries to the probe, which echoes every online row. Check that a host dropping multicast echo is still found through the DNS and lease paths, and add a scanner test with a STALE entry for a departed host that asserts no 'online' event.

#### IPV6-35: Anomaly identity and training ignore DUID and ND MAC, so IPv6 clients (especially privacy addresses) are never scored and allowlists don't cover a host's IPv6 traffic

**medium**, confirmed. `server/src/models/anomaly.js:24`

- **What happens:** (1) A dual-stack laptop has v4 identity aa:bb:cc:dd:ee:ff from its lease. The operator allowlists it by its v4 address, which stores that MAC identity, but its IPv6 queries from 2001:db8:1::abcd are scored under identity '2001:db8:1::abcd' and keep raising anomalies. (2) A host using RFC 8981 temporary addresses (Linux, Windows and macOS default) gets a new source address about every 24h. Each one starts at 0h history and never reaches 48h, so it sits in 'learning' forever and its IPv6 DNS traffic is never scored. Analytics top-clients likewise lists each temporary address as a separate client with no hostname.
- **Why:** `resolveIdentity`: `SELECT mac_address FROM dhcp_leases WHERE ip_address = ?` and `row?.mac_address || clientIp`, mirrored in server/anomaly/storage.py:65-97 resolve_device_key. DHCPv6 leases are stored with `mac: null` (utils/dhcp.js:482, identity in `duid`), and SLAAC hosts have no lease, so every IPv6 client's identity is its current address. Training is also keyed per client_ip: features.get_client_history_hours(client_ip) has to reach MIN_TRAINING_HOURS=48 (config.py:21), and extract_training_data(client_ip) also works per address.
- **Verifier:** resolveIdentity (server/src/models/anomaly.js:24-26) and resolve_device_key (server/anomaly/storage.py) both key on dhcp_leases.mac_address. parseLeaseLine stores DHCPv6 leases with mac: null (utils/dhcp.js:482), so every IPv6 client resolves to its address, while an IPv4 lease holder resolves to its MAC. BACKLOG.md:187 lists 'IPv6 anomaly identities' as landed, so this is a gap against a stated feature, not an intended difference. Training history is per client_ip with MIN_TRAINING_HOURS=48 (config.py:21), so a rotating RFC 8981 temporary address plausibly never leaves learning. Note that per-IP history also resets on an IPv4 renumbering; rotation is what makes it routine on IPv6. The dual-stack allowlist scenario is real, but DUID and MAC are different identities, so a fix would need ND MAC correlation, not just DUID.
- **Fix:** Resolve IPv6 identity from the DHCPv6 lease DUID, or from ip_addresses.last_seen_mac (populated from the ND table) and the EUI-64 interface ID, in both resolveIdentity and resolve_device_key. Key the history and training queries on identity (all client_ips mapped to it) rather than on one address.

### Imports, address helpers and outbound URLs

#### IPV6-40: Outbound URL guard refuses IPv6 entirely, even with the IPv6 switch on

**low**, confirmed. `server/src/utils/url-guard.js:108`

- **What happens:** On an IPv6-only appliance with IPv6 enabled, every blocklist feed refresh, Pi-hole probe and mac-vendor download fails with 'Hostname does not resolve (IPv4): ENOTFOUND'. A dual-stack host whose feed has only an AAAA record fails the same way.
- **Why:** `else if (net.isIP(parsed.hostname) === 6) return { ok: false, reason: 'IPv6 URLs are not allowed' }`. Hostnames are resolved with `dns.promises.lookup(hostname, { family: 4 })`, and the pinned requests use `lookup: ... cb(null, check.ip, 4)`. The header comment says 'IPv6 is blocked entirely (simpler + our target feeds are all v4)', which predates the switch. isBlockedIpv6 already exists in the same file and would make an IPv6 path safe.
- **Verifier:** url-guard.js:108 refuses IPv6 literal URLs, and line 112 resolves only with family:4, regardless of the IPv6 switch. On an IPv6-only host, or for a feed host with only an AAAA record, outbound fetches (blocklists, Pi-hole, mac-vendor) fail. The header comment documents this as a deliberate choice that predates the switch, so it is a parity gap and not a correctness bug. isBlockedIpv6 already exists, so an IPv6 path could be added safely.
- **Fix:** When ipv6Enabled(), allow an IPv6 literal or AAAA result that passes isBlockedIpv6. Pin with the address's real family, and use the array-form lookup (see the DoH finding). Keep IPv4-only behaviour when the switch is off.

### Client UI

#### IPV6-43: Workspace range size and DHCP pool size are blank or zero for IPv6 because ipToLong throws and the error is swallowed

**medium**, confirmed. `client/src/views/networks-workspace-data.js:348` (also `client/src/views/networks-workspace-data.js:283`)

- **What happens:** A stateful DHCPv6 scope 2001:db8::1000-2001:db8::1fff appears in the DHCP scopes table with pool size '0 addresses'. The Ranges table shows '—' for every IPv6 range's size. A folder holding one /24 v4 scope (pool 64) and one v6 scope (pool 4096) shows POOL ADDRESSES = 64.
- **Why:** `rangeSize` does `ipToLong(endIp) - ipToLong(startIp) + 1` in a try/catch that returns EMPTY_CELL (285-289). `sumScopeAddresses` does `poolTotal + (ipToLong(pool.end_ip) - ipToLong(pool.start_ip)) + 1` and on the throw `catch { return poolTotal; }` (346-352). mapDhcpScopeRows builds `poolSize: `${formatNumber(sumScopeAddresses([scope]))} addresses`` (150), and the folder/all-networks 'POOL ADDRESSES' tile sums the same function (NetworksWorkspace.vue:1396).
- **Verifier:** networks-workspace-data.js:10 imports ipToLong from the shared cidr.js, which throws on IPv6. rangeSize (283-290) returns EMPTY_CELL for every IPv6 range. In sumScopeAddresses (341-355), each IPv6 pool adds 0. That feeds the DHCP scopes table poolSize (line 150) and the folder/all-networks POOL ADDRESSES tile (NetworksWorkspace.vue:1396). The per-network tile (line 1376) and addressOverview (line 1451) guard with isV6Network, which shows the gap was known only for the single-network view. A fix needs BigInt sizes, because SLAAC/stateless pools span the whole prefix.
- **Fix:** Compute sizes with addressToBig in BigInt: size = end.value - start.value + 1n. Format with BigInt toLocaleString, or show a count/'≥2^53' label when the value exceeds Number.MAX_SAFE_INTEGER, matching the server's sparse-count rule. Do not fold an IPv6 pool into the IPv4 sum silently.

#### IPV6-44: AddressScanDialog freezes its IPv4-only probe gate at mount, so one IPv6 open disables Probe for IPv4 addresses too

**medium**, confirmed. `client/src/views/networks-workspace/dialogs/AddressScanDialog.vue:67`

- **What happens:** Open 'Probe now' from the row menu (ip.probe calls openScanDialog) on an IPv6 address such as fd00::5. The button is disabled, as designed. Close it, then choose 'Probe now' on IPv4 address 10.0.0.5. The button is still disabled and submit() returns early, so IPv4 probing is broken until a page reload. In the reverse order (IPv4 first), IPv6 probes are allowed and succeed, because the server supports them (see the next finding).
- **Why:** `const supportsProbe = props.addressFamily === 4;` is a plain constant computed once in setup, not a computed. NetworksWorkspace.vue:287-295 mounts the dialog with `v-if="selectedNetwork.id && scanTarget"`. scanTarget is never reset to null, so the same instance is reused for every later address in the session, and only the addressFamily prop changes. I checked this with a scratch mount: mounted with addressFamily 6, then setProps({address:'10.0.0.5', addressFamily:4}), and the 'Probe now' button stayed disabled.
- **Verifier:** AddressScanDialog.vue:67 is `const supportsProbe = props.addressFamily === 4;`, a plain non-reactive constant evaluated once in setup. NetworksWorkspace.vue:287-295 mounts it under `v-if="selectedNetwork.id && scanTarget"` with no :key. scanTarget (line 581) is only ever reassigned by openScanDialog (useWorkspaceActions.js:159), never set back to null. So the instance survives from one address to the next, and only the address-family prop changes. A network is single-family, so to hit this the user has to move from a v6 network straight to a v4 network while selectedNetwork.id stays truthy. That is easily done from the explorer. In that case Probe stays disabled and submit() returns early for IPv4 until the component remounts. It is really a reactivity bug, but IPv6 is what triggers it, and the result is broken IPv4 behaviour.
- **Fix:** Make it `const supportsProbe = computed(() => Number(props.addressFamily) === 4)` and read `.value`. Better still, drop the family gate entirely, since POST /scans/probe handles IPv6 (see the next finding). Add a test that changes addressFamily on a mounted dialog.

#### IPV6-45: UI refuses to probe an IPv6 address even though POST /scans/probe probes IPv6 with ICMPv6

**medium**, confirmed. `client/src/views/networks-workspace/AddressDetailsPanel.vue:397`

- **What happens:** With IPv6 on, open the details panel for fd00:1234::10 on an allocated /64 and click 'Probe now'. The button is disabled. Selecting the same address and using the bulk Probe action reaches the server and returns 'responded via ICMPV6'.
- **Why:** `const supportsProbe = computed(() => !raw.value.address_family || Number(raw.value.address_family) === 4)` disables the 'Probe now' button, with the tooltip 'Manual probing is currently available for IPv4 addresses only.' AddressScanDialog.vue:67 applies the same gate. The server does not need it: routes/scans.js:92 validates with isValidAddress/networkContains (either family), and utils/scanner.js probeIp (line 64) sends `pingIp(ip)` with method 'icmpv6' for a family-6 address. The ip.probe action in workspace-actions.js:628 has no family gate, so bulk probe of an IPv6 selection (probeSelection) works while the single-address paths are disabled.
- **Verifier:** AddressDetailsPanel.vue:397-399 and AddressScanDialog.vue:67 refuse family-6 addresses. The server path accepts them. routes/scans.js:92-160 validates with isValidAddress/networkContains, startScan checks the ipv6Enabled switch (scanner.js:164), and probeIp (scanner.js:64-67) pings with `-6` and reports method 'icmpv6'. The bulk ip.probe action (workspace-actions.js:628, probeSelection) has no family gate, so the gate is inconsistent. The tooltip and docs/WORKSPACE-UI-IMPLEMENTATION-PLAN.md:216 show the gate was put in deliberately back when the backend was IPv4-only, and it is now stale. One caveat for the fix, found while checking: scanner.js:323-329 evaluates `assignment.mac_address` when `!assignment && !rogueMeaningful`. A responding IPv6 address with no non-unassigned row on a SLAAC or stateless network therefore throws a TypeError, which reaches the user as 500 'Probe failed'. This already affects the bulk path today and is worth reporting on the server side.
- **Fix:** Remove the family gate from AddressDetailsPanel and AddressScanDialog, or limit it to the IPv6-switch-off case, where the server already returns IPV6_DISABLED_ERROR. Add an IPv6 case to the probe tests.

#### IPV6-46: Classic SubnetDetail throws while rendering any IPv6 network (visibleRanges and findRangeForIp call ipToLong)

**medium**, confirmed. `client/src/views/SubnetDetail.vue:952`

- **What happens:** Open /networks-classic (linked from the user menu) and select an allocated fd00:1234::/64. visibleRanges calls ipToLong('fd00:1234::'), which throws 'Invalid IP address: fd00:1234::', and the subnet view fails to render instead of showing the 'IPv6 networks are managed in the Networks workspace' notice. On a partial render, clicking an IPv6 row in the IP table throws from findRangeForIp.
- **Why:** The visibleRanges computed (line 937) loops over every Network/Broadcast/Gateway system range and calls `ipToLong(r.start_ip)` (line 952), then calls `ipToLong(ip.ip_address)` for reserved IPs (line 960). It has no isIpv6Subnet guard, unlike ipGrid (line 1058). services/subnet-topology.js createSystemRanges writes a 'Network' range (the subnet-router anycast address) for every IPv6 prefix shorter than /127. The Grid tab's DataTable binds `:value="visibleRanges"` (line 206), and the openvue TabPanel renders inactive panels eagerly because SubnetDetail's <Tabs> is not lazy, so the computed is evaluated on load. findRangeForIp (line 893), which onTableRowClick calls at line 841, also uses ipToLong on the row address. The existing IPv6 test is a source-string check only.
- **Verifier:** I confirmed the parts of the claim one at a time. createSystemRanges (subnet-topology.js:17-41) always writes a 'Network' range at parsed.network for any IPv6 prefix that topologyAddresses reserves, plus a Gateway range when a gateway is set. visibleRanges (SubnetDetail.vue:937-960) calls ipToLong(r.start_ip) on those rows with no isIpv6Subnet guard, and ipToLong throws on IPv6 (verified). The DataTable binds :value="visibleRanges" (line 206) inside TabPanel 'grid'. The openvue TabPanel template renders content with `v-if="$pcTabs?.lazy ? active : true"` plus v-show, and SubnetDetail's <Tabs> is not lazy, so the computed runs on first render even with the IP tab active. SubnetsLayoutB.vue:294 mounts SubnetDetail for any selected subnet and has no family filter. findRangeForIp (line 893) also calls ipToLong on the row address. The only existing IPv6 test (SubnetDetailGridInteractions.test.js:44-51) is a source-string check. I did not mount the component, but every step is deterministic. Rated medium because this is the classic view; the workspace is the primary UI.
- **Fix:** Return [] from visibleRanges, and null from findRangeForIp, when isIpv6Subnet is true, or rewrite both with addressToBig/addressInRange. Add a mount test of SubnetDetail with an IPv6 subnet that has a Network range.

#### IPV6-47: Client DHCP option resolver passes a wrong-family address literal through unchanged

**low**, confirmed. `client/src/utils/resolveHostname.js:36`

- **What happens:** In a DHCPv6 scope, typing '192.168.1.53' into option 23 (DNS servers) gives no toast, and the value is saved. dnsmasq never receives it, because resolveToIp(…, 6) returns null and the option line is omitted. A DHCPv4 option given 'fd00::53' behaves the same way.
- **Why:** `if (!value || isAddress(value)) return value;` and `if (isAddress(part)) resolved.push(part)` (36, 43), where isAddress is the family-agnostic isValidAddress. The `family` parameter is applied only to hostnames (`ips.filter((ip) => addressFamily(ip) === Number(family))`). The server writer then silently drops the wrong-family entry (see the dhcp.js finding), so no layer tells the operator.
- **Verifier:** resolveHostname.js:17 defines isAddress as family-agnostic isValidAddress, and lines 36 and 43 pass a literal through without checking it against `family`. On the server, validateScopeOption (routes/dhcp.js:98-112) only runs the dnsmasq injection check and never checks address family, and renderOptionValue/resolveToIp drops the wrong-family literal without a word. The option is saved and shown, but never emitted to dnsmasq. The real gap is server-side validation; the client resolver is only where it shows up.
- **Fix:** For literals, check addressFamily(part) === Number(family) and warn (or refuse) when it does not match, as the hostname branch already does.

#### IPV6-48: AAAA record inside a DHCPv6 pool gets no 'inside a DHCP pool' warning; the comment claiming a server check is wrong

**low**, confirmed. `client/src/components/DnsPanel.vue:674`

- **What happens:** Create an AAAA host -> 2001:db8::1500 where a stateful DHCPv6 pool covers 2001:db8::1000-1fff. No warning appears, while the equivalent A record inside a v4 pool shows 'IP is inside a DHCP pool'.
- **Why:** saveRecord calls findDhcpScopeForIp for both `['A', 'AAAA']` (1223). findDhcpScopeForIp starts with `// IPv4 only: an IPv6 pool is compared on the server when the record lands.` then `if (!ip || !isValidIpv4(ip)) return null;` and compares with ipToLong. Grepping routes/dns.js and models/dns-record.js finds no pool-overlap warning on the server.
- **Verifier:** DnsPanel.vue:672-673 returns null for any value that is not IPv4, so the warning saveRecord shows for ['A','AAAA'] (line 1223) can never fire for an AAAA record. The comment says 'an IPv6 pool is compared on the server', but routes/dns.js has no pool warning. Its only pool mention is the bulk-action comment at line 854, and the lifecycle's dnsHoldingRecord only declines a hold inside an enabled scope; it does not warn. This is a client-only parity gap, and the comment is stale.
- **Fix:** Use addressInRange (shared cidr.js) for both families, filtered to scopes of the same family, and delete the misleading comment.

#### IPV6-49: Workspace aggregate tables sort IPv6 networks and ranges with decimal-numeric localeCompare, so hex groups misorder

**low**, confirmed. `client/src/views/networks-workspace/NetworksWorkspace.vue:1202` (also `client/src/views/networks-workspace/NetworksWorkspace.vue:1202`)

- **What happens:** In node, sorting ['2001:db8:a::/64','2001:db8:10::/64','2001:db8:9::/64'] gives 9, 10, a. The numeric order is 9 (0x9), a (0xa), 10 (0x10). So 2001:db8:10::/64 is listed before 2001:db8:a::/64. The networks tree (stores/subnets.js compareNetworks) already sorts correctly with sortKey.
- **Why:** Non-IP tables (networks, ranges, scopes, zones) are sorted with `String(a[key]).localeCompare(String(b[key]), undefined, { numeric: true })`. Numeric collation reads digit runs as decimal and puts letters after digits. That is right for dotted quads but wrong for hextets.
- **Verifier:** NetworksWorkspace.vue:1199-1205 sorts tables that are not IP tables with localeCompare numeric:true. In node, ['2001:db8:a::/64','2001:db8:10::/64','2001:db8:9::/64'] sorts to 9, 10, a, but the hex order is 9, a, 10. The networks/ranges/scopes aggregate tables can therefore misorder IPv6 entries. Display only.
- **Fix:** For address/CIDR columns, sort by sortKey(network or start address) and then by prefix length, as stores/subnets.js does, and fall back to localeCompare for other text.

#### IPV6-50: Divide/carve drops an IPv6 parent's custom gateway for the child that contains it

**low**, confirmed. `client/src/components/NetworkDialogs.vue:2055`

- **What happens:** Take 2001:db8::/63 with gateway_policy custom and gateway 2001:db8:0:1::fe, and divide it into /64s. The preview sets both children to policy 'none'. The IPv4 equivalent keeps 'custom' on the child that holds the gateway. I have not traced whether the server re-derives this, so the confidence is moderate.
- **Why:** `else if (isValidIpv4(parent.gateway_address) && isIpInSubnet(parent.gateway_address, cidr)) { next[cidr] = { policy: 'custom', address: parent.gateway_address }; } else next[cidr] = { policy: 'none', address: null };`. isValidIpv4 and isIpInSubnet (parseCidr) are IPv4-only, so an IPv6 parent always falls to 'none'.
- **Verifier:** NetworkDialogs.vue:2055 short-circuits on isValidIpv4, so every IPv6 child of a parent with a custom gateway defaults to policy 'none'. divideTargetGateways (2065-2068) sends those policies to the server as explicit overrides. buildDividePlan (network-transformation-plan.js:278-289) applies them through targetGateway, so the server does not re-derive 'custom' for the child that holds the gateway. The operator can probably still change the per-child policy in the preview, which is why this stays low.
- **Fix:** Use isValidAddress plus networkContains(cidr, parent.gateway_address), which are family-aware and return false across families.

#### IPV6-52: IPv6 networks never show utilization, even where the server sends a countable total

**low**, plausible. `client/src/views/networks-workspace-data.js:60`

- **What happens:** An IPv6 /120 (256 addresses) with 250 assigned shows no utilization and does not appear in the 'high-utilization networks' attention count. An IPv4 /24 in the same state shows 98% and is flagged.
- **Why:** networkUtilization returns null for any `address_family === 6`, so the explorer shows 'IPv6' instead of a percent, the Networks table shows '—', and `state` is never 'warning' (85% or more). NetworksWorkspace.vue:1348 also swaps the UTILIZATION tile for ASSIGNED on any v6 network. ARCHITECTURE.md says utilization reports counts instead of a total only 'when the prefix exceeds what a JavaScript number holds'. models/subnet-ip-read.js sends total_addresses when it fits.
- **Verifier:** networkUtilization (networks-workspace-data.js:60-63) returns null for every family-6 network, and the comment there says this is on purpose. parseNetwork('fd00::/120').size is 256 and '/76' is a finite Number. Only /64 and wider give null. The server's used_count is a row count that applies to either family. So a small IPv6 prefix could show a percent and be flagged at 85% or more, as an IPv4 one is. ARCHITECTURE.md:118-120 only says counts replace a total 'when the prefix exceeds what a JavaScript number holds', which suggests this is a parity gap and not an intended rule. However, IPv6 prefixes longer than /64 are uncommon outside /126-/128 point-to-point links, and the ASSIGNED count is still shown. Rated low because the design deliberately chose to hide utilization for IPv6 and the doc does not clearly require showing it.
- **Fix:** Base the decision on whether total_addresses is a finite non-null number, not on family. Show a percent and the warning state when it is, and the assigned count otherwise.
