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

#### IPV6-03: An IPv6 gateway is stored in the spelling the user typed, so the listing and summary show and count it twice and the policy is misclassified

**medium**, confirmed. `server/src/routes/subnets.js:1755`

- **What happens:** Configure fd00:1::/64 with gateway_address 'FD00:1:0:0::1'. The stored values are gateway_address 'FD00:1:0:0::1', gateway_policy 'custom' (it should be 'first') and Gateway range start_ip 'FD00:1:0:0::1', while ip_addresses holds the canonical 'fd00:1::1'. GET /:id/ips then lists [fd00:1::(system), fd00:1::1(gateway), fd00:1::1(gateway)], a duplicate virtual row. GET /:id/summary reports assigned_count 3 instead of 2. String comparisons such as gatewayClaimConflicts (`gateways.has(row.ip_address)`) also miss. (IPv4 accepts '10.0.0.01' through the same path, but IPv6 has far more spellings: case, zero compression, leading zeros.)
- **Why:** validateGatewayForSubnet only checks gateway_address by value (familyAddress). The raw string then flows into resolveGatewayAddress, configureSubnet (subnets.gateway_address), createSystemRanges (the Gateway range start_ip) and reconcileTopologyAddresses. The same happens in POST /configuration-preview, PUT /:id and the divide plan's custom gateway override. gatewayPolicyForAddress (services/subnet-topology.js:122) compares strings (`gatewayAddress === parsed.firstUsable`). The IPv6 listing (routes/subnets.js:2279-2284) and summarizeCanonicalSubnetIps (models/subnet-ip-read.js:101-109) add subnet.gateway_address to a Map keyed by the canonical ip_address. routes/ranges.js POST stores start_ip and end_ip raw through Range.createRange as well.
- **Verifier:** Reproduced. Configuring fd00:1::/64 with gateway_address 'FD00:1:0:0::1' stores subnets.gateway_address 'FD00:1:0:0::1', gateway_policy 'custom' (should be 'first') and a Gateway range start_ip 'FD00:1:0:0::1', while ip_addresses holds the canonical 'fd00:1::1'. GET /ips lists [fd00:1:: system, fd00:1::1 gateway, fd00:1::1 gateway], a duplicate row. GET /summary reports assigned_count 3. validateGatewayForSubnet checks the value only, and the raw string is persisted. gatewayPolicyForAddress compares strings.
- **Fix:** Canonicalize every address input at the route boundary with canonicalizeIp: gateway_address in POST /configuration-preview, PUT /:id, /configure and divide target_gateways, and start_ip/end_ip in the range POST and PUT. Optionally make the two protected-address maps compare by addressToBig value. Add an IPv6 test with an upper-case or expanded gateway.

#### IPV6-04: Searching an IPv6 network for an available address, or for a stored one in a non-canonical spelling, returns nothing

**medium**, confirmed. `server/src/routes/subnets.js:2276`

- **What happens:** On fd00:1::/64, GET /api/subnets/:id/ips?search=fd00:1::5 returns 0 rows, although fd00:1::5 is a valid available address of the network. search=fd00:1:0:0::1 (the persisted gateway in another spelling) also returns 0 rows. On 10.9.0.0/24, search=10.9.0.5 returns 10.9.0.5.
- **Why:** The IPv6 branch of GET /:id/ips filters persisted rows with matchesSearch, a substring test on row.ip_address. exactExplorerSearch is computed above it but the v6 branch never uses it. The IPv4 path uses it to synthesize the virtual row for an exact in-subnet address (mayMatchVirtual and exactSearchIps).
- **Verifier:** Reproduced. On fd00:1::/64, search=fd00:1::5 returns 0 rows, and search=fd00:1:0:0::1 (the gateway in another spelling) also returns 0. The IPv6 branch (routes/subnets.js:2276-2315) filters only persisted and protected rows with the substring matchesSearch and never uses exactExplorerSearch. The IPv4 branch synthesizes the virtual row for an exact in-subnet address. This is a display parity gap, not wrong data. The non-canonical-spelling half is partly shared with IPv4, but IPv6 has far more spellings.
- **Fix:** In the v6 branch, when search (or table_search) is a single valid address inside the prefix, canonicalize it and look it up by value. Return the persisted row, or projectVirtualSubnetIpRow when there is none, then apply the other filters. Add an IPv6 search test for both cases.

#### IPV6-05: With the IPv6 switch off, IPv6 networks can still be divided and merged, addresses reserved, and ranges and gateways created

**medium**, confirmed. `server/src/routes/subnets.js:1364`

- **What happens:** Create and configure fd00:4::/63 while IPv6 is on, then switch it off. PUT /api/subnets/:id/ips/fd00:4::50/allocation {allocation_state:'reserved'} returns 200 and creates an IPv6 reservation. POST /api/subnets/:id/ranges with a DHCP Scope range fd00:4::100-200 returns 201. POST /:id/divide {new_prefix:64, force:true} returns 200 and creates two new IPv6 networks (fd00:4::/64, fd00:4:0:1::/64), which configure the same network on each child. PUT /:id {gateway_policy:'last'} returns 200 and re-projects the IPv6 gateway.
- **Why:** refuseIpv6Unless is called only in POST / (line 482) and POST /:id/configure (line 1751). Divide and carve (1364, preview at 954), merge (617), PUT /:id with a gateway change (749), PUT /:id/ips/:ip/allocation (2809), bulk-allocation (2753), the scan-enabled routes and routes/ranges.js POST and PUT (line 40) have no family gate. utils/ipv6-support.js says 'every route that would create an IPv6 object refuses'; only reads and deletes should work while it is off.
- **Verifier:** Reproduced with ipv6_enabled set to false after configuring fd00:4::/63. PUT /ips/fd00:4::50/allocation {reserved} returns 200, POST /ranges fd00:4::100-200 returns 201, PUT /:id {gateway_policy:'last'} returns 200, and POST /divide {new_prefix:64, force:true} returns 200 and creates fd00:4::/64 and fd00:4:0:1::/64. refuseIpv6Unless appears in routes/subnets.js only at lines 482 and 1751, and not at all in routes/ranges.js. This contradicts the contract in utils/ipv6-support.js. ipv6-gate.test.js does not cover these routes.
- **Fix:** Add `if (subnet.address_family === 6 && refuseIpv6Unless(res)) return;` to divide, carve, merge (any source of family 6), PUT /:id when it changes the gateway, the single and bulk allocation routes, the scan-enabled routes, and the ranges POST and PUT. Extend tests/integration/routes/ipv6-gate.test.js to cover them.

#### IPV6-06: The network address of an IPv6 /127 (and /128) is treated as a protected system address, contradicting topologyAddresses and RFC 6164

**low**, confirmed. `server/src/services/ip-lifecycle-service.js:40`

- **What happens:** Configure fd00:3::/127 with gateway_policy none. PUT /ips/fd00:3::/allocation {reserved} returns 400 'The network address is managed by subnet topology', and GET /ips/fd00:3:: reads allocation_state 'system', although no system row exists and validateGatewayForSubnet accepts fd00:3:: as a usable gateway. A /128 network has no usable address at all. 10.30.0.0/31 is refused the same way.
- **Why:** protectedAddress returns SYSTEM whenever value === parsed.networkBig, with no prefix check. ipAllocationRejectionReason (routes/subnets.js:2710) and buildVirtualSubnetIpRow (models/ip-view.js:117) do the same. topologyAddresses and parseNetwork say 'Point-to-point and host prefixes reserve nothing' (on /127 and /128 firstUsable is the network address), and createSystemRanges and reconcileTopologyAddresses create no system row there. RFC 6164 makes both /127 addresses usable, with no subnet-router anycast. The same inconsistency applies to IPv4 /31 and /32 (both endpoints protected), so it is not v6-only.
- **Verifier:** Reproduced. fd00:3::/127 with gateway_policy none configures with no ip_addresses rows. PUT /ips/fd00:3::/allocation {reserved} returns 400 'The network address is managed by subnet topology', and GET /ips/fd00:3:: reads allocation_state 'system'. This contradicts utils/cidr.js:89-91 ('except on /127 and /128') and :351 ('Point-to-point and host prefixes reserve nothing'). protectedAddress (ip-lifecycle-service.js:54) and buildVirtualSubnetIpRow have no prefix check. IPv4 /31 and /32 have the same inconsistency, so this is not IPv6-specific. The impact is limited to point-to-point links.
- **Fix:** Derive the protected set from topologyAddresses(parsed) in all three places (protectedAddress, ipAllocationRejectionReason, buildVirtualSubnetIpRow) instead of comparing networkBig and lastBig directly. Add /127 and /31 tests.

#### IPV6-07: DNS record and zone search matches IPv6 text literally, without canonicalizing

**low**, confirmed. `server/src/models/workspace-view.js:59`

- **What happens:** Searching the DNS records for '2001:db8:0:0:0:0:0:5' or 'fd00:0006::10' finds no record. The stored values are 2001:db8::5 and fd00:6::10. The Networks search finds the containing network for the same text.
- **Why:** getWorkspaceDnsRecords and getWorkspaceDnsZones filter q/table_q through anyFieldMatches (`includesLiteral`, a lowercase substring match) on value/ip_address. AAAA values are stored compressed (canonicalizeIp in routes/dns.js). networkMatches in the same file does canonicalize an exact IP (`canonicalizeIp(query)`, line 122), and the client sends q unchanged.
- **Verifier:** workspace-view.js getWorkspaceDnsRecords (the q and tableQ filters around lines 307-308) and getWorkspaceDnsZones (around lines 381-387) use anyFieldMatches/includesLiteral, a lowercased substring match. AAAA values are stored compressed, so an expanded spelling such as '2001:db8:0:0:0:0:0:5' or 'fd00:0006::10' matches nothing. networkMatches in the same file canonicalizes an exact-IP query (line 122). Case is handled because text() lowercases. Only display and search are affected.
- **Fix:** In the DNS matchers, when canonicalizeIp(query) is non-null, also compare it for equality against ip_address/value, the same way networkMatches does.

#### IPV6-08: Default network name template truncates IPv6 to the first four hextets, so sibling /65+ networks get identical, misleading names

**low**, plausible. `server/src/utils/cidr.js:317`

- **What happens:** Two /127 point-to-point links, 2001:db8:0:ff::/127 and 2001:db8:0:ff::2/127, are both auto-named '2001:db8:0:ff/127'. Neither name is the network, and the two cannot be told apart in lists.
- **Why:** networkNameFromTemplate fills %1-%4 from the first four hextets for IPv6, and the default template is '%1.%2.%3.%4/%bitmask'. For IPv4 those four placeholders cover the whole address. For IPv6 they cover only the top 64 bits.
- **Verifier:** The behaviour is documented and intended (cidr.js:307-314: '%1 to %4 are the first four groups'), and only a default name suggestion is affected. Still, with the default template '%1.%2.%3.%4/%bitmask' (config/defaults.js:28), any IPv6 network longer than /64 gets a name that is not its network, and /127 siblings such as 2001:db8:0:ff::/127 and ::2/127 both become '2001:db8:0:ff/127'. Cosmetic and easy to rename.
- **Fix:** For IPv6 prefixes longer than /64, either render the canonical network (formatIp of networkBig) when the template is the default, or add a placeholder that expands to the canonical compressed network address.

### DHCPv6 and Router Advertisements

#### IPV6-14: Neighbor lookups for routers and DHCPv6 servers key link-local addresses without the interface, so a rogue can inherit a trusted router's MAC

**medium**, confirmed. `server/src/utils/ra-monitor.js:180`

- **What happens:** The legitimate router on eth1 is fe80::1 with a MAC known as a configured gateway, and a rogue router on eth0 also uses fe80::1 (a very common router link-local). Both routers get eth1's MAC, and the eth0 rogue is classified 'configured-gateway' and never reported. Likewise, an allowlist entry for fe80::1 trusts that address on every interface.
- **Why:** parseNeighTable (utils/nd-cache.js:48) does `table.set(ip, {...})` keyed only by the canonical address, so a second `fe80::1 dev eth1` overwrites `fe80::1 dev eth0`. ra-monitor.js:180 `table.get(router.address)` and dhcpv6-probe.js:397 `neighbors.get(adv.sourceIp)` then read the wrong interface's MAC. classifyRouter and classifyAdvertise also compare `authorized.ips.has('fe80::1')` without a zone, and the rogue_dhcp_events dedup key (kind, server_ip, server_mac) has no iface. nd-cache's own header says 'Entries carry the interface, which is identity for link-local addresses'. Reproduced: parseNeighTable of two fe80::1 lines yields one entry (eth1's MAC), and parseRaRoutes returns two routers, both fe80::1.
- **Verifier:** nd-cache.js:48 `table.set(ip, ...)` keys on the canonical address only, so a second `fe80::1 dev ethX` line overwrites the first, despite the file header saying the interface is identity for link-local. ra-monitor.js:180 `table.get(router.address)` and dhcpv6-probe.js:397 `neighbors.get(adv.sourceIp)` read that collapsed entry. classifyRouter (ra-monitor.js:115-123) compares authorized.ips and gatewayMacs with no interface, so a rogue fe80::1 on one link can inherit a trusted router's MAC, and an allowlisted fe80::1 is trusted on every link. This needs a multi-interface appliance with colliding link-locals but different MACs, so medium is right.
- **Fix:** Key the neighbor table by `${ip}%${interface}` for link-local addresses (or return all entries per IP), look up by (address, iface) in ra-monitor and dhcpv6-probe, and include iface in the rogue event identity for link-local server_ip values. Optionally allow a zone on allowlisted link-local IPs.

#### IPV6-17: DHCPv6 option, custom-option and scope-option writes are accepted while IPv6 support is off

**low**, confirmed. `server/src/routes/dhcp.js:1303`

- **What happens:** With ipv6_enabled=false (verified): PUT /api/dhcp/options/defaults {family:6, options:[{code:23,value:'fd00::53'}]} returns 200, and POST /api/dhcp/options/custom {address_family:6, code:200, label:'x'} returns 201. Neither gives the IPV6_DISABLED_ERROR.
- **Why:** PUT /options/defaults with family 6 (line 1303) and POST /options/custom with address_family 6 (line 1225) never call refuseIpv6Unless. PUT /scopes/:id (lines 440-446) gates only v6_mode, start_ip, end_ip and gateway on a v6 scope, so options, dns_servers, ntp_servers, domain_search and lease_time are written. ipv6-support.js says 'every route that would create an IPv6 object refuses'.
- **Verifier:** routes/dhcp.js PUT /options/defaults (~line 1303) and POST /options/custom (~line 1225) never call refuseIpv6Unless for family 6. ipv6-support.js says every route that would create an IPv6 object refuses, and a family-6 custom option row is such an object. The scope PUT (lines 440-446) leaving options and lease_time open is deliberate per its comment ('can still be described, enabled or disabled'), but options go beyond that. No dnsmasq effect while off (no v6 scopes are written), so low.
- **Fix:** Call `if (family === 6 && refuseIpv6Unless(res)) return;` in both option routes, and extend the PUT /scopes/:id gate to options and the legacy option columns on a v6 scope. Add these cases to tests/integration/routes/ipv6-gate.test.js.

#### IPV6-19: PUT /dhcp/scopes/:id stores IPv6 pool bounds in whatever spelling the client sent

**low**, confirmed. `server/src/routes/dhcp.js:469`

- **What happens:** PUT /api/dhcp/scopes/1 {start_ip:'FD00:B::0010', end_ip:'fd00:b::00ff'} returns 200 and stores pools[0].start_ip = 'FD00:B::0010' (reproduced). Text comparisons, such as network-dhcp-diagnostics.js:180 `pool.range_start_ip !== pool.start_ip`, and the displayed and exported values then disagree with the canonical 'fd00:b::10' used elsewhere.
- **Why:** start_ip and end_ip are only checked with isValidAddress, then passed through to updateScope (models/dhcp-scope.js:463) without canonicalizeIp. /configure (routes/subnets.js:1811) and the reservation routes do canonicalize.
- **Verifier:** Reproduced: PUT /api/dhcp/scopes/1 {start_ip:'FD00:B::0010', end_ip:'fd00:b::00ff'} returns 200, and pools[0].start_ip is stored as 'FD00:B::0010'. routes/dhcp.js validates with isValidAddress only and never canonicalizes, unlike /configure. Numeric comparisons (addressToBig) still work, so the impact is display/export and string compares only. (The same PUT also lets a slaac scope's display range be edited, which is related.)
- **Fix:** Canonicalize start_ip/end_ip with canonicalizeIp before storing, and check that each one's family matches the scope's family.

#### IPV6-20: Passive device fingerprinting only understands DHCPv4, so DHCPv6-only or SLAAC-only devices are never classified

**low**, confirmed. `server/src/utils/dhcp-fingerprint.js:81`

- **What happens:** An IPv6-only IoT device that does a DHCPv6 SOLICIT/REQUEST/REPLY with vendor class 'xyz' ends up with no device_fingerprints row. Its address row shows device_type null even when the ND MAC is known.
- **Why:** A transaction is finalized only on `DHCPACK`, with the regex `/^DHCP(DISCOVER|REQUEST|ACK|INFORM)\b/`, and identity is a MAC parsed from the line. DHCPv6 transactions (identified by DUID, ending in DHCPREPLY, with vendor class option 16 and ORO option 6) never finalize, so nothing is persisted. A DHCPv6 DHCPREQUEST line does match, and extractMac runs on the DUID, but that partial transaction is discarded as stale. This is not wrong data, but it means IPv6-only hosts get no device_type or os_family. If v6 support is added, the ORO codes must not be mixed into the option-55 (DHCPv4) fingerprint namespace.
- **Verifier:** ingestLine (server/src/utils/dhcp-fingerprint.js:81-99) sets ackSeen only on DHCPACK, and drainFinalized requires ackSeen. A DHCPv6 exchange ends in DHCPREPLY, so it never finalizes and the stale sweep drops it. No v6 traffic leaks into the option-55 namespace, because nothing is persisted. This is a parity gap only: IPv6-only hosts get no device_type or os_family. Low.
- **Fix:** Either document this as DHCPv4-only (with a comment, per AGENTS.md), or add a DHCPv6 path keyed by the lease's DUID/ND MAC that records ORO and option 16 in separate fields from opt55. Also stop the DHCPv4 regex from matching DHCPv6 DHCPREQUEST lines.

#### IPV6-21: DHCP scope gateway, dns_servers and ntp_servers accept either family, are not gated, and the wrong family is silently dropped from config

**low**, plausible. `server/src/routes/dhcp.js:333`

- **What happens:** POST /api/dhcp/scopes for 10.0.0.0/24 with gateway '2001:db8::1' and IPv6 switched OFF returns 201. The effective-options view shows router 2001:db8::1, but no dhcp-option 3 line is written and suppressRouter is not set, so dnsmasq advertises its own address as the router. In the same way, dns_servers '["192.168.1.1","fd00::53"]' on a v4 scope silently loses fd00::53. On a v6 scope the IPv4 entries are silently dropped from option 23/56.
- **Why:** Scope create and update validate `gateway` with `isValidAddress(gateway)` (333, 453) and the server lists with `parseIpList` -> `servers.every(isValidAddress)` (124-131). isValidAddress accepts both families. Nothing compares the value's family to subnet.address_family, and nothing calls refuseIpv6Unless for an IPv6 literal on an IPv4 scope. At config time, utils/dhcp.js renderOptionValue -> resolveToIp(value, 4) returns null for a v6 literal (`addressFamily(value) === family ? value : null`, dhcp.js:40), and the option is skipped (`if (emitValue == null) continue;`). Meanwhile models/dhcp-scope.js still reports option 3 as set (`set(3, scope.gateway, 'legacy_scope')`).
- **Verifier:** The gateway scenario is wrong. In models/dhcp-scope.js:310-337, resolveEffectiveScopeOptions sets 3 from scope.gateway, then line 326 overwrites it with the network gateway. When the network has none, line 328 deletes it and router_suppressed becomes true. So an IPv4 scope never shows or emits the legacy IPv6 gateway, and dnsmasq never falls back to advertising itself as router. What remains is real but minor. parseIpList and validateScopeOption (routes/dhcp.js:98-131) never check that an address literal matches the scope family. renderOptionValue then drops it silently through resolveToIp (utils/dhcp.js:40): an IPv6 literal in ntp_servers (42) on an IPv4 scope, or IPv4 entries in dns_servers/ntp_servers (23/56) on an IPv6 scope. Nothing gates the switch for IPv6 literals in those lists. ScopeDialog does not send the legacy columns, so only API callers can reach this. I did not check dns_servers on IPv4: the IPv4 effective resolver never reads it.
- **Fix:** Validate each address against the scope's family: addressFamily(x) === (subnet.address_family === 6 ? 6 : 4). Return 400 naming the field when it does not match. Also call refuseIpv6Unless before accepting any IPv6 literal. Canonicalize stored values with canonicalizeIp.

#### IPV6-22: DHCPv6 leases and reservations get no MAC, so no vendor fallback name, although DUID-LLT/LL embed the link-layer address

**low**, plausible. `server/src/models/dhcp-lease.js:238`

- **What happens:** An unnamed DHCPv6 client with DUID 00:01:00:01:2e:3f:40:51:aa:bb:cc:dd:ee:ff gets no hostname and no AAAA record, and shows no MAC. The same device over DHCPv4 is named '<vendor>-device' and shows aa:bb:cc:dd:ee:ff.
- **Why:** parseLeaseLine sets `mac: null` for v6. assignLeaseNames only applies `fallbackName(lease.mac)`, and utils/dhcp.js:530-533 notes 'DHCPv6 clients have no MAC to look a vendor up by'. DUID types 1 (LLT) and 3 (LL) carry a hardware type and the MAC, and the probe already builds such DUIDs (clientDuidFor).
- **Verifier:** The code is as described (dhcp.js:476-486 mac:null, dhcp-lease.js:238 fallback only on lease.mac). It is acknowledged in a comment (dhcp.js:530-533), and API_MODEL.md says the v6 MAC is 'learned metadata, when present', which the neighbor table can also supply. RFC 8415 says DUIDs are opaque, and the link-layer address in a DUID-LLT/LL is often a different or stale interface. So this is an enhancement-level parity gap rather than a defect.
- **Fix:** Add a helper in utils/duid.js that extracts the Ethernet MAC from DUID-LLT/LL (hardware type 1), use it to fill lease.mac for v6 leases (for display and fallback naming), and leave it null for DUID-EN/UUID.

### DNS, the DNS proxy and DoH

#### IPV6-23: DoH forwarder's pinned lookup hard-codes family 4, so an IPv6 upstream address cannot connect

**high**, confirmed. `server/src/utils/encrypted-forwarder.js:180` (also `server/src/utils/encrypted-forwarder.js:180`)

- **What happens:** Set encryption mode https with the upstream {addresses:['2606:4700:4700::1111'], hostname:'cloudflare-dns.com', doh_url:'https://cloudflare-dns.com/dns-query'}. Every DoH query fails and resolves to SERVFAIL. With autoSelectFamily on, IPv4 upstreams fail too.
- **Why:** `lookup: (_h, _o, cb) => cb(null, ip, 4)`, where ip is `upstream.addresses[0]`. The PUT /api/dns/encryption route explicitly accepts IPv6 upstream addresses when the switch is on (routes/dns.js:1119-1124). Node uses the family argument to choose the socket type. With autoSelectFamily disabled, a v6 address with family 4 fails with `connect EINVAL 2001:db8::1:443`, which I reproduced. Separately, and more seriously, on Node >= 20 (autoSelectFamily on by default) Node calls the lookup with {all:true} and expects an array. This 3-argument callback therefore fails with 'Invalid IP address: undefined' for IPv4 as well. I reproduced that by calling forwardDoH on Node 22: lastError was 'Invalid IP address: undefined' for both 127.0.0.1 and 2001:db8::1. I could not test Node 24, the version the project ships on. DoT (`tls.connect({host: ip})`) is unaffected.
- **Verifier:** I reproduced this on Node 22.22.2. With autoSelectFamily on by default, an https.request that names a hostname and uses the custom lookup `cb(null, ip, 4)` fails with 'Invalid IP address: undefined' for both 127.0.0.1 and ::1. Node calls the lookup with all:true and expects an array back. encrypted-forwarder.js:180 passes url.hostname, a name and not an IP, so the lookup always runs. DoH is therefore broken for both families on Node 20 and later; I could not test Node 24, the version the project ships. Separately, the hard-coded family 4 is wrong for an IPv6 upstream that routes/dns.js:1119-1124 accepts. url-guard is not affected: it passes the IP as hostname, so Node skips the lookup.
- **Fix:** Honour the lookup options and the address's family: `lookup: (_h, opts, cb) => { const family = net.isIP(ip); return opts?.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family); }`. Alternatively pass `family: net.isIP(ip)` in the request options. Add a test that a DoH request actually reaches a local listener for each family.

#### IPV6-24: A CNAME cannot target a host that only has an AAAA record

**high**, confirmed. `server/src/models/dns-record.js:155`

- **What happens:** I reproduced this with IPv6 enabled, using 2001:db8:1::/64 and 10.9.9.0/24, both with domain v6.test. AAAA six -> 2001:db8:1::5 returned 201, and A four -> 10.9.9.5 returned 201. POST CNAME alias6 -> six.v6.test returned 400 'CNAME target must already exist as an enabled A or CNAME record in v6.test'. POST CNAME alias4 -> four.v6.test returned 201. The 'Add CNAME' menu item on an AAAA row hits the same error.
- **Why:** cnameTargetError only accepts a target that already exists as an enabled `r.type IN ('A', 'CNAME')`. AAAA is missing from that list. The rule is shared by POST/PUT /api/dns/zones/:id/records (routes/dns.js validateRecord) and by the Pi-hole importer. The client offers 'Add CNAME' on AAAA rows (client/src/utils/rowContextMenu.js:67). findAHostnameConflict also tells the user to 'create a CNAME pointing at that hostname instead' when an AAAA address already has a name (routes/dns.js, and the dns-ipv6 test asserts that message). On an IPv6-only host, that workaround is then refused.
- **Verifier:** models/dns-record.js cnameTargetError SQL (around line 155) filters `r.type IN ('A', 'CNAME')`, and AAAA is not in that list. No caller adds AAAA targets: extraKnownFqdns only carries same-batch names. routes/dns.js:574 and :782 tell the user to 'create a CNAME pointing at that hostname instead' when an AAAA address already has a hostname, and client rowContextMenu.js addCnameMenuItem offers 'Add CNAME' on AAAA rows. So on an IPv6-only host both the suggested workaround and the menu action are refused. This is a feature that works for IPv4 and is broken for IPv6.
- **Fix:** Change the predicate to `r.type IN ('A', 'AAAA', 'CNAME')` and update the error text. Add an IPv6 case to the CNAME tests, including one through the Pi-hole import path.

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

#### IPV6-30: POST /api/dns/forwarders/test accepts IPv6 while the switch is off

**low**, confirmed. `server/src/routes/dns.js:1169`

- **What happens:** With ipv6_enabled=false, POST /api/dns/forwarders/test {ip:'2606:4700:4700::1111'} sends DNS traffic over IPv6 and reports reachable instead of returning IPV6_DISABLED_ERROR.
- **Why:** The handler checks only `isValidAddress(ip)` and then calls testDnsForwarder(ip), which sends a query to it. PUT /forwarders and PUT /encryption both call refuseIpv6Unless for family 6, but this route does not.
- **Verifier:** routes/dns.js:1169-1176 checks only isValidAddress(ip) and then calls testDnsForwarder(ip), with no refuseIpv6Unless call. The sibling PUT /forwarders and PUT /encryption routes do gate IPv6. With the switch off, a v6 address is probed instead of being refused with IPV6_DISABLED_ERROR. The route is read-only (it sends one test query and persists nothing), so this is a gating inconsistency with low impact.
- **Fix:** Add `if (addressFamily(ip) === 6 && refuseIpv6Unless(res)) return;` and cover it in ipv6-gate.test.js.

### Scanning, liveness, rogue and anomaly detection

#### IPV6-31: IPv6 scan crashes (TypeError) whenever an unassigned address answers on a network without a stateful DHCPv6 scope

**high**, confirmed. `server/src/utils/scanner.js:327`

- **What happens:** Confirmed by running a copy of tests/integration/scanner-ipv6-scan.test.js. On network fd00:7::/64 with no DHCPv6 scope, neighbour fd00:7::c1 answers the echo, and the scan ends with status 'failed', error "Cannot read properties of undefined (reading 'mac_address')", scanned_ips 0. Because the error is caught before observeScanResult and reconcileScanRogues run, no allocated address on that network is ever marked offline by a scan, and every scheduled scan fails. Also confirmed: POST /api/scans/probe with targetIps ['fd00:5::99'] on a SLAAC network (unassigned, responding) gives a failed scan, so the route answers 500 'Probe completed but no result recorded'.
- **Why:** `const rogueMeaningful = parsed.family === 4 || policy?.mode === 'stateful'; if (!assignment && rogueMeaningful) {...} else if (assignment.mac_address && result.mac && ...)`. On IPv4, `rogueMeaningful` is always true, so `assignment` is never dereferenced while undefined. On IPv6 with mode null (no DHCPv6 scope), or on a targeted probe of an unassigned address under slaac or stateless, `!assignment && false` falls through to `assignment.mac_address` and throws. observeIpv6Presence stores a bare-network neighbour as `unassigned`, and the assignment snapshot excludes `unassigned`, so this happens on every scan that finds any host. The existing test 'records liveness only when the network has no scope' never checks `run.status`, so it passes while the scan fails.
- **Verifier:** Reproduced against the real scanner in a scratch vitest at /tmp/claude-0/-home-user-cidrella/dd3d8b96-fd4c-5864-996a-7445c57d0948/scratchpad/ipv6-audit/skeptic-scan/sk.test.js, with the same mocks as tests/integration/scanner-ipv6-scan.test.js. On a bare fd00:7::/64 network where fd00:7::c1 answers, the run ends status 'failed' with error "Cannot read properties of undefined (reading 'mac_address')" and scanned_ips 0. A targeted probe of an unassigned responder (fd00:5::99) on a SLAAC network fails the same way. The cause is at server/src/utils/scanner.js:327-333: `!assignment && rogueMeaningful` is false when there is no assignment and the mode is not stateful, so control falls into `assignment.mac_address`. Two things make it reachable: observeIpv6Presence leaves a no-scope neighbour as 'unassigned', and the assignment snapshot excludes 'unassigned' rows. The existing test 'records liveness only when the network has no scope' never checks run.status. The try/catch catches the error before observeScanResult and reconcileScanRogues run, so the scan marks nothing offline. IPv4 is unaffected because rogueMeaningful is always true there.
- **Fix:** Guard the MAC-mismatch branch with `else if (assignment && assignment.mac_address && ...)`, and add `expect(run.status).toBe('completed')` to the no-scope and SLAAC tests, plus a targeted-probe IPv6 test.

#### IPV6-32: IPv6 rows the sparse scan never probes are still treated as 'scanner covered', so they stay online forever

**high**, confirmed. `server/src/models/ip-address.js:471`

- **What happens:** Confirmed with a scratch vitest. On a stateful network fd00:6::/64 with a scan interval set, scan 1 finds fd00:6::b1 and fe80::b1 (eth0) in the ND table and both rows go online. The host leaves (empty ND table, no echo reply), scan 2 completes, and both rows have last_seen_at 3h old. bulkMarkStale(db, 60) then returns changes 0, and both rows stay is_online=1 indefinitely. The same applies to every rotated SLAAC temporary address on a no-scope network.
- **Why:** bulkMarkStale skips every row where `scannerCoveredSql(...)` is true and isAutomaticScanAllowed passes. That SQL covers every row in a scanned IPv6 network. The IPv6 scan (scanner.js:218-230) only echoes globals currently in the ND table plus rows with `allocation_state NOT IN ('unassigned','system') AND interface_id IS NULL`, and link-local rows are excluded outright (`filter(ip => !/^fe[89ab]/i.test(ip))`). So an `unassigned` IPv6 row (a liveness-only host on a no-scope network, a rogue on a stateful network, or a privacy address that has rotated away) and every link-local row with an interface_id is neither probed nor allowed to age out. scan-coverage.js says the scheduler and the sweep must agree on what gets probed, and for IPv6 they don't.
- **Verifier:** Reproduced in the same scratch test. On stateful fd00:6::/64 with scan_interval '1h', scan 1 marks fd00:6::b1 online. Scan 2 runs with an empty ND table and the row is not in the probe set (the allocated query at scanner.js:218-226 excludes 'unassigned'). After its last_seen_at is backdated 3h, bulkMarkStale(db, 60) returns changes 0 and the row stays is_online=1. scannerCoveredSql (scan-coverage.js) treats every row of an allocated IPv6 network as covered, and isAutomaticScanAllowed passes with the switch on, so models/ip-address.js:471 filters the row out. No other code path sets is_online=0 (grep finds only markOffline, which takes an explicit IP, and bulkMarkStale). Link-local rows (interface_id set, filtered out of globals) follow the same path by inspection. This is exactly the 'scheduler and sweep disagree' failure that scan-coverage.js says it exists to prevent.
- **Fix:** For IPv6 networks, make the scan echo every persisted row that is currently online (including unassigned rows), and judge link-local rows from their ND state on the interface. Or narrow scannerCoveredSql for family 6 to the rows the IPv6 scan actually probes (allocated, interface_id IS NULL), so the passive stale sweep handles the rest. Add an IPv6 case to the bulkMarkStale coverage tests.

#### IPV6-33: An IPv6 host that drops ICMPv6 echo is marked offline even though its ND entry proves it answered

**medium**, confirmed. `server/src/utils/scanner.js:64`

- **What happens:** Confirmed with a scratch vitest. Static_dns row fd00:6::50 (online) has ND entry REACHABLE with MAC aa:bb:cc:dd:ee:50, and the host drops echo (Windows' default firewall does). After the scan the row is is_online=0 with offline_since_at set, and events are scanned/no_response then offline. On a SLAAC or no-scope network the same scan first marks it online through observeIpv6Presence and then offline through the probe, so it flaps on every scan.
- **Why:** probeIp: `if (addressFamily(ip) === 6) { const icmp = await pingIp(ip); return { ...icmp, method: 'icmpv6' }; }`. Liveness comes only from the echo reply. The ND table read after each batch (line ~300-312) only fills in the MAC, and only when `r.responded` is true. The echo itself makes the kernel send a Neighbor Solicitation, and the Neighbor Advertisement reply (which a host firewall cannot block) leaves the entry REACHABLE, but that evidence is thrown away. On IPv4, arping fills the same role and ICMP is only the fallback.
- **Verifier:** Reproduced. Static_dns row fd00:6::50 starts online and has a REACHABLE ND entry with a MAC. The host does not answer echo. After the scan the row is is_online=0, because probeIp (scanner.js:64-67) uses only the ICMPv6 echo result and the batch loop reads the ND table only for responders, to fill the MAC. On IPv4, arping detects a host that drops ICMP, so this is a real parity gap. It is not a stated intended difference. One caveat: the scratch ND table is static, so a real kernel's entry states after the echo are inferred, not observed. On SLAAC and no-scope networks the discovery step marks the host online through observeIpv6Presence before the probe marks it offline, which gives the flapping the auditor describes.
- **Fix:** Treat the ND layer as the IPv6 counterpart of arping. After a failed echo, re-read the ND cache (forced) and count REACHABLE/DELAY/PROBE for that address as responded (method 'ndp'), or send an explicit NS (ndisc6) first. Add a comment noting that ARP is IPv4-only and ND is the IPv6 equivalent here.

#### IPV6-34: Full IPv6 scan clears rogue flags on addresses it never probed

**medium**, confirmed. `server/src/utils/scanner.js:377`

- **What happens:** Confirmed in the same scratch run. On stateful fd00:6::/64, scan 1 flags fd00:6::b1 as rogue. Scan 2 runs with the host not in the ND table and not probed, and the row ends up is_rogue=0, is_online=1 with no rogue_cleared event. For a routed stateful IPv6 network the appliance is not attached to, where discovery finds nothing, every DNS-detected rogue is silently erased at the next scheduled scan.
- **Why:** `if (!isTargeted) reconcileScanRogues(db, subnetId, conflictIps);` calls clearRogueForSubnet, which runs `UPDATE ... is_rogue = 0 WHERE subnet_id = ? AND is_rogue = 1 AND ip_address NOT IN (flagged)`. It also emits no rogue_cleared event. That is sound for IPv4, where the sweep re-probed every address. On IPv6 the probe set is sparse (ND globals plus allocated rows), so a rogue raised by passive DNS observation (observeIpv6Presence on a stateful network) or an earlier scan is cleared even though nothing re-checked it, while is_online stays 1 (see the stale-sweep finding).
- **Verifier:** Reproduced. Scan 1 flags fd00:6::b1 rogue. Scan 2 does not probe it, and it ends is_rogue=0, rogue_reason NULL, is_online=1. scanner.js:377 calls reconcileScanRogues, which runs clearRogueForSubnet (ip-address.js:755). That clears every rogue row in the subnet not flagged in this scan and emits no rogue_cleared event, unlike markOffline and bulkMarkStale. The logic assumes the scan re-checked every address, which holds for the IPv4 sweep but not for the sparse IPv6 probe set. Passively detected rogues on a stateful network the appliance is not attached to are erased silently.
- **Fix:** On IPv6, limit reconcileScanRogues to the addresses actually probed in this scan (pass the probed set and clear only those not in conflictIps), and emit rogue_cleared events like the per-row path does.

#### IPV6-35: Anomaly identity and training ignore DUID and ND MAC, so IPv6 clients (especially privacy addresses) are never scored and allowlists don't cover a host's IPv6 traffic

**medium**, confirmed. `server/src/models/anomaly.js:24`

- **What happens:** (1) A dual-stack laptop has v4 identity aa:bb:cc:dd:ee:ff from its lease. The operator allowlists it by its v4 address, which stores that MAC identity, but its IPv6 queries from 2001:db8:1::abcd are scored under identity '2001:db8:1::abcd' and keep raising anomalies. (2) A host using RFC 8981 temporary addresses (Linux, Windows and macOS default) gets a new source address about every 24h. Each one starts at 0h history and never reaches 48h, so it sits in 'learning' forever and its IPv6 DNS traffic is never scored. Analytics top-clients likewise lists each temporary address as a separate client with no hostname.
- **Why:** `resolveIdentity`: `SELECT mac_address FROM dhcp_leases WHERE ip_address = ?` and `row?.mac_address || clientIp`, mirrored in server/anomaly/storage.py:65-97 resolve_device_key. DHCPv6 leases are stored with `mac: null` (utils/dhcp.js:482, identity in `duid`), and SLAAC hosts have no lease, so every IPv6 client's identity is its current address. Training is also keyed per client_ip: features.get_client_history_hours(client_ip) has to reach MIN_TRAINING_HOURS=48 (config.py:21), and extract_training_data(client_ip) also works per address.
- **Verifier:** resolveIdentity (server/src/models/anomaly.js:24-26) and resolve_device_key (server/anomaly/storage.py) both key on dhcp_leases.mac_address. parseLeaseLine stores DHCPv6 leases with mac: null (utils/dhcp.js:482), so every IPv6 client resolves to its address, while an IPv4 lease holder resolves to its MAC. BACKLOG.md:187 lists 'IPv6 anomaly identities' as landed, so this is a gap against a stated feature, not an intended difference. Training history is per client_ip with MIN_TRAINING_HOURS=48 (config.py:21), so a rotating RFC 8981 temporary address plausibly never leaves learning. Note that per-IP history also resets on an IPv4 renumbering; rotation is what makes it routine on IPv6. The dual-stack allowlist scenario is real, but DUID and MAC are different identities, so a fix would need ND MAC correlation, not just DUID.
- **Fix:** Resolve IPv6 identity from the DHCPv6 lease DUID, or from ip_addresses.last_seen_mac (populated from the ND table) and the EUI-64 interface ID, in both resolveIdentity and resolve_device_key. Key the history and training queries on identity (all client_ips mapped to it) rather than on one address.

#### IPV6-36: API probe of a non-canonical IPv6 spelling flags an assigned address as rogue

**medium**, confirmed. `server/src/routes/scans.js:108`

- **What happens:** Confirmed with a scratch vitest. On stateful network fd00:6::/64 with a static_dns row 'fd00:6::77', probing targetIps ['FD00:6::77'] completes, and row fd00:6::77 ends up allocation_state static_dns, is_rogue=1, rogue_reason 'Rogue device (IP not assigned)'. A non-responding probe with that spelling records nothing at all.
- **Why:** `const targets = many ? [...new Set(ips)] : [ip];`. The targets are validated with isValidAddress but never canonicalized before `startScan(..., { targetIps: targets })`. In the scanner, `assignmentMap.get(result.ip)` is an exact string lookup against canonical ip_address values, so it misses and the address is classed 'Rogue device (IP not assigned)'. updateFromScan also misses on its exact-string `existing` lookup, so addressClaim never clears the conflict. upsert then canonicalizes and writes is_rogue=1 onto the real row. The Set dedupe also lets 'fd00::1' and 'FD00::1' be probed twice.
- **Verifier:** Reproduced. A targeted scan with targetIps ['FD00:6::77'] against canonical static_dns row 'fd00:6::77' completes with conflicts_found 1, and the real row ends is_rogue=1 with rogue_reason 'Rogue device (IP not assigned)' while still static_dns. routes/scans.js:108 never canonicalizes the targets. scanner.js:322 and updateFromScan (ip-address.js:790) both look up by exact string, so the assignment and the claim check both miss before upsert canonicalizes. This is wrong data on an admin-declared row, but it is triggered only by an API caller or typed input with a non-canonical spelling. The UI probably sends stored canonical strings, which is why this stays medium rather than high.
- **Fix:** Canonicalize every target with canonicalizeIp in the probe route (and defensively in startScan for targetIps) before dedupe, the containment check, and the scan.

#### IPV6-37: DHCPv6 traffic is miscounted in DHCP metrics: requests counted, replies never, so every DHCPv6 exchange looks unanswered

**medium**, confirmed. `server/src/utils/metrics-aggregator.js:32`

- **What happens:** Confirmed with node. parseLogLines on a SOLICIT/ADVERTISE/REQUEST/REPLY/RENEW/REPLY sequence returns {dhcpClientMsgs: 1, dhcpServerMsgs: 0}, while the equivalent DHCPv4 DISCOVER/OFFER/REQUEST/ACK returns 2/2. A healthy DHCPv6 network shows unanswered client requests and no server activity, and renewals are not counted.
- **Why:** `DHCP_CLIENT_RE = /\bDHCP(?:DISCOVER|REQUEST|RELEASE|INFORM|DECLINE)\b/` and `DHCP_SERVER_RE = /\bDHCP(?:OFFER|ACK|NAK)\b/`. These are DHCPv4 message names. dnsmasq logs DHCPv6 as DHCPSOLICIT/DHCPADVERTISE/DHCPREQUEST/DHCPREPLY/DHCPRENEW/DHCPREBIND/DHCPCONFIRM/DHCPINFORMATION-REQUEST, and only REQUEST/RELEASE/DECLINE overlap. The comment says the two counts exist 'so the dashboard can show a request the server never answered'.
- **Verifier:** The regexes at server/src/utils/metrics-aggregator.js:32-33 hold DHCPv4 names only. The dnsmasq rfc3315.c source in the scratch dir logs DHCPv6 as DHCPSOLICIT, DHCPADVERTISE, DHCPREQUEST, DHCPREPLY, DHCPRENEW, DHCPREBIND, DHCPCONFIRM and DHCPINFORMATION-REQUEST. Of these, only REQUEST, RELEASE and DECLINE match the client regex. INFORMATION-REQUEST does not, because there is no word boundary after INFORM. Nothing matches the server regex. client/src/views/Dashboard.vue shows the client/server split, so a healthy DHCPv6 network displays as unanswered requests. Re-rated to medium as a wrong display.
- **Fix:** Add the DHCPv6 message names to the client regex (SOLICIT, RENEW, REBIND, CONFIRM, INFORMATION-REQUEST) and the server regex (ADVERTISE, REPLY), and add an IPv6 test case to the parseLogLines test.

#### IPV6-38: POST /api/scans accepts an IPv6 network while the switch is off (201, then the scan fails in the background)

**low**, confirmed. `server/src/routes/scans.js:66`

- **What happens:** With ipv6_enabled=false and an existing allocated fd00:7::/64 network, POST /api/scans {subnet_id} returns 201 with a pending scan, and the scan history then shows a failed run plus 'Unhandled promise rejection' in the log. The documented contract is a 400 carrying IPV6_DISABLED_ERROR.
- **Why:** The route checks status and the IPv4 size cap (`subnet.address_family !== 6 && ...`) but never calls `refuseIpv6Unless(res)`. It creates a pending scan and calls `startScan(db, scanId, subnet_id)` unawaited. startScan then marks the scan failed and throws IPV6_DISABLED_ERROR, which ends up in the global unhandledRejection logger. /probe instead turns the same error into a 500 'Probe failed: ...' and leaves the failed scan row behind. ipv6-gate.test.js has no scan case.
- **Verifier:** POST / in server/src/routes/scans.js:36-71 never calls refuseIpv6Unless; it creates the pending scan and calls startScan without awaiting it. With the switch off, startScan (scanner.js:164-167) marks the scan failed and then throws inside an async function, so the rejection is unhandled. BACKLOG says the switch gates 'scan scheduling and creation', and every other IPv6 route returns a 400 carrying IPV6_DISABLED_ERROR. /probe has the same gap and turns the error into a 500. No data is corrupted, so this stays low.
- **Fix:** In both POST / and /probe, call `if (subnet.address_family === 6 && refuseIpv6Unless(res)) return;` before creating the scan record, and add the case to ipv6-gate.test.js.

### Imports, address helpers and outbound URLs

#### IPV6-39: Pi-hole DHCP import crashes (500, partial import) whenever any IPv6 leaf network exists

**high**, confirmed. `server/src/routes/pihole.js:563` (also `server/src/routes/pihole.js:360`, `server/src/routes/pihole.js:360`)

- **What happens:** I confirmed this with a scratch vitest. Turn IPv6 on, create the leaf networks 10.9.0.0/24 and 2001:db8::/64, then POST /api/pihole/import with hosts [{nas,10.9.0.5}] and dhcpHosts [{aa:bb:cc:dd:ee:01,10.9.0.50,printer}]. The response is HTTP 500 with an empty body, and the A record nas is still left in dns_records (count 1). The import half-succeeds and the operator only sees an error. The same import with no IPv6 network present succeeds.
- **Why:** The best-subnet loop runs 32-bit math over every leaf subnet with no family filter: `for (const s of subnets) { const netLong = ipToLong(s.network_address); const size = Math.pow(2, 32 - s.prefix_length); ...}` (lines 562-568). The subnet list comes from `SELECT s.* FROM subnets s WHERE <leaf>` (528-534), which includes IPv6 networks. ipToLong throws 'Invalid IP address: 2001:db8::' on a v6 network_address. This runs after the DNS transaction has already committed (line 476/501). So existing IPv6 data breaks an IPv4-only feature.
- **Verifier:** pihole.js:5 imports ipToLong from utils/ip.js, which re-exports cidr.js:50. That function splits on '.' and throws 'Invalid IP address: 2001:db8::' for any IPv6 string, which I checked with node. The leaf query at lines 528-534 has no address_family filter, and the loop at 562-568 visits every subnet, so a single IPv6 leaf network makes any import with a valid DHCP row throw, whatever order the rows come in. By then the DNS transaction (lines 476-501) has already committed, so the import is left half done and the operator gets a 500.
- **Fix:** Choose the subnet with findSubnetForIp(db, d.ip) from utils/ip-sync.js, or with parseNetwork/parsedNetworkContains filtered to the address's family, instead of ipToLong and 2**(32-prefix). Add an integration test that imports DHCP hosts while an IPv6 leaf network exists.

#### IPV6-40: Outbound URL guard refuses IPv6 entirely, even with the IPv6 switch on

**low**, confirmed. `server/src/utils/url-guard.js:108`

- **What happens:** On an IPv6-only appliance with IPv6 enabled, every blocklist feed refresh, Pi-hole probe and mac-vendor download fails with 'Hostname does not resolve (IPv4): ENOTFOUND'. A dual-stack host whose feed has only an AAAA record fails the same way.
- **Why:** `else if (net.isIP(parsed.hostname) === 6) return { ok: false, reason: 'IPv6 URLs are not allowed' }`. Hostnames are resolved with `dns.promises.lookup(hostname, { family: 4 })`, and the pinned requests use `lookup: ... cb(null, check.ip, 4)`. The header comment says 'IPv6 is blocked entirely (simpler + our target feeds are all v4)', which predates the switch. isBlockedIpv6 already exists in the same file and would make an IPv6 path safe.
- **Verifier:** url-guard.js:108 refuses IPv6 literal URLs, and line 112 resolves only with family:4, regardless of the IPv6 switch. On an IPv6-only host, or for a feed host with only an AAAA record, outbound fetches (blocklists, Pi-hole, mac-vendor) fail. The header comment documents this as a deliberate choice that predates the switch, so it is a parity gap and not a correctness bug. isBlockedIpv6 already exists, so an IPv6 path could be added safely.
- **Fix:** When ipv6Enabled(), allow an IPv6 literal or AAAA result that passes isBlockedIpv6. Pin with the address's real family, and use the array-form lookup (see the DoH finding). Keep IPv4-only behaviour when the switch is off.

#### IPV6-41: parseIp accepts '::' standing for zero groups, so an invalid spelling canonicalizes to a valid address

**low**, confirmed. `server/src/utils/address.js:89`

- **What happens:** canonicalizeIp('1::2:3:4:5:6:7:8') returns '1:2:3:4:5:6:7:8', and so does canonicalizeIp('1:2:3:4:5:6::7:8'). net.isIP returns 0 for both. Malformed input is accepted by isValidAddress, the AAAA validator and the GeoIP allowlist, and is stored under a different address's spelling.
- **Why:** In parseV6, `const fill = groupCount - parts.length; if (fill < 0) return null;` allows fill === 0. RFC 4291 2.2 says '::' represents one or more groups of zeros. node's net.isIP rejects these strings. The behaviour came from the pre-refactor cidr-match parser (fixtures/cidr-match-pre-address-refactor.js:19), so it is long-standing.
- **Verifier:** I ran this against the real helper. canonicalizeIp('1::2:3:4:5:6:7:8') and canonicalizeIp('1:2:3:4:5:6::7:8') both return '1:2:3:4:5:6:7:8', and isValidAddress returns true, while net.isIP returns 0. The cause is that `fill < 0` in address.js allows fill === 0. Stored values are canonicalized, so this does not split storage across two spellings. It does mean malformed input is accepted without an error. A strictness issue, low.
- **Fix:** Require `fill >= 1` when hasDoubleColon. Update cidr-match-equivalence if it pins this case, and add the two strings to address.test.js as invalid.

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

#### IPV6-51: DNS forwarders stay 'dirty' after saving a non-canonical IPv6 spelling

**low**, confirmed. `client/src/views/DNS.vue:476`

- **What happens:** With IPv6 on, enter forwarder '2606:4700:4700:0:0:0:0:1111' or '2001:DB8::1' and Save. The server stores '2606:4700:4700::1111'. The Save button stays enabled and the card reports unsaved changes until the page reloads, and saving again sends the same request.
- **Why:** saveUpstream sets `savedForwarders.value = [...(res.servers || servers)]`. The server (routes/dns.js PUT /forwarders) returns the canonicalized list from canonicalizeIp. The inputs in `forwarders.value` keep the typed text. forwardersDirty (line 332) compares the trimmed input with saved[i] by string equality, so a typed IPv6 spelling that differs from the canonical one never matches.
- **Verifier:** routes/dns.js:994 stores canonicalizeIp(s) for each server and :1017 returns that canonical list. Checked: canonicalizeIp('2001:DB8::1') returns '2001:db8::1', and canonicalizeIp('2606:4700:4700:0:0:0:0:1111') returns '2606:4700:4700::1111'. DNS.vue:476 copies res.servers into savedForwarders but leaves forwarders.value as the typed text, and forwardersDirty (line 331-337) compares the two strictly as strings. The card therefore stays dirty after a successful save until reload. The impact is cosmetic plus redundant re-saves.
- **Fix:** After a successful save, rewrite forwarders.value from res.servers (keeping each status), or compare canonicalizeIp(input) with saved.

#### IPV6-52: IPv6 networks never show utilization, even where the server sends a countable total

**low**, plausible. `client/src/views/networks-workspace-data.js:60`

- **What happens:** An IPv6 /120 (256 addresses) with 250 assigned shows no utilization and does not appear in the 'high-utilization networks' attention count. An IPv4 /24 in the same state shows 98% and is flagged.
- **Why:** networkUtilization returns null for any `address_family === 6`, so the explorer shows 'IPv6' instead of a percent, the Networks table shows '—', and `state` is never 'warning' (85% or more). NetworksWorkspace.vue:1348 also swaps the UTILIZATION tile for ASSIGNED on any v6 network. ARCHITECTURE.md says utilization reports counts instead of a total only 'when the prefix exceeds what a JavaScript number holds'. models/subnet-ip-read.js sends total_addresses when it fits.
- **Verifier:** networkUtilization (networks-workspace-data.js:60-63) returns null for every family-6 network, and the comment there says this is on purpose. parseNetwork('fd00::/120').size is 256 and '/76' is a finite Number. Only /64 and wider give null. The server's used_count is a row count that applies to either family. So a small IPv6 prefix could show a percent and be flagged at 85% or more, as an IPv4 one is. ARCHITECTURE.md:118-120 only says counts replace a total 'when the prefix exceeds what a JavaScript number holds', which suggests this is a parity gap and not an intended rule. However, IPv6 prefixes longer than /64 are uncommon outside /126-/128 point-to-point links, and the ASSIGNED count is still shown. Rated low because the design deliberately chose to hide utilization for IPv6 and the doc does not clearly require showing it.
- **Fix:** Base the decision on whether total_addresses is a finite non-null number, not on family. Show a percent and the warning state when it is, and the assigned count otherwise.
