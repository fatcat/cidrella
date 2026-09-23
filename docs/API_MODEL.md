# API Read/Write Model

CIDRella keeps database column names scoped to their tables, but API responses
that are rendered across multiple views must use explicit, cross-domain names.
This avoids a DNS record `type`, a DHCP row `type`, and an IP ownership `Type`
being treated as the same concept.

## IP Read Model

Routes that return IP state for display should include the canonical IP view
fields produced by `server/src/models/ip-view.js`.

| Field | Meaning | Typical values |
| --- | --- | --- |
| `allocation_state` | Mutually exclusive allocation authority. | `unassigned`, `reserved`, `static_dns`, `dynamic_dhcp`, `static_dhcp`, `slaac`, `system`, `gateway`, `quarantined` |
| `allocation_source_type` | Owning protocol or topology source for the allocation. | `dns`, `dhcp_lease`, `dhcp_reservation`, `admin_reservation`, `topology`, null |
| `allocation_source_id` | Protocol or topology row that backs the allocation, when applicable. | integer/string identifier, null |
| `address_family` | Canonical address family. | `4`, `6` |
| `address_sort_key` | Fixed-width indexed key for numeric mixed-family ordering. | 33-character family-prefixed hexadecimal key |
| `interface_id` | Interface context required for scoped addresses such as IPv6 link-local. | identifier, null |
| `ip_display_status` | User-facing availability derived by the server. | `available`, `DHCP Scope`, `in use` |
| `ip_status_severity` | UI severity for `ip_display_status`. | `secondary`, `danger` |
| `address_type` | User-facing reason the IP is in use. Empty/null when available. | `static DNS`, `dynamic DHCP`, `DHCP Reservation`, `SLAAC`, `rogue`, `system`, `gateway`, `IP Reservation`, `disabled DNS` |
| `address_type_tooltip` | Optional explanation for `address_type`. | rogue reason, IP Reservation note, the disabled record's name |
| `computed_type` | Sort/search alias for `address_type`, or `available`. | same as `address_type`, plus `available` |
| `is_online` | Current liveness state. | `0`/`1`, boolean in some API rows |
| `last_seen_at` | Last observation time from scans, DHCP, or passive checks. | datetime/null |
| `last_scanned_at` | Last active probe time. | datetime/null |
| `scan_enabled` | Nullable per-IP scanning override. Null means inherit from the subnet/global setting. | `0`/`1`/null |
| `scanning_enabled` | Server-resolved effective scanning toggle for the IP. The server applies IP override, then subnet override, then the global default. | boolean |
| `network_range_type_id` | Custom organizational Network Range Type covering the IP, when one exists. | integer/null |
| `network_range_type` | Display name of the custom organizational Network Range Type. This does not affect allocation, DNS, DHCP, scanning, or topology. | string/null |
| `network_range_type_color` | Validated display color for the custom organizational Network Range Type tag. | hex color/null |
| `in_dynamic_pool` | Whether the address belongs to an enabled same-family DHCP pool. | `0`/`1` |
| `has_static_dns` | Whether an enabled manual DNS A or AAAA record backs the IP. | `0`/`1` |
| `has_dhcp_reservation` | Whether a DHCP Reservation backs the IP. | `0`/`1` |
| `dhcp_expires_at` | Active dynamic lease expiration. | datetime, `infinite`, null |
| `dhcp_duid` | DHCPv6 client DUID retained by the lifecycle aggregate. | string/null |
| `dhcp_iaid` | DHCPv6 identity association identifier retained with the DUID. | string/null |
| `device_type` | Best device category inferred from DHCP fingerprint evidence. | `Computer`, `Smartphone`, `Printer`, null |
| `os_family` | Best operating-system family inferred from DHCP fingerprint evidence. | `Windows`, `macOS`, `Apple iOS`, `Android`, `Linux`, null |
| `device_confidence` | Confidence of the strongest retained automatic fingerprint, or 100 for a manual override. | `0`–`100`, null |
| `dhcp_fingerprint` | Normalized DHCP option 55 parameter-request list retained as fingerprint evidence. | comma-separated option codes, null |
| `dhcp_vendor_class` | DHCP option 60 vendor-class identifier retained as fingerprint evidence. | string/null |
| `dhcp_fingerprint_hostname` | Client hostname captured with the DHCP fingerprint. | string/null |
| `device_fingerprint_source` | Whether the displayed classification is automatic or operator-supplied. | `dhcp`, `manual`, null |

UI table rendering should use `ip_display_status` for the displayed Status and
`address_type`/`computed_type` for the displayed Type. It should not infer
display Type from DNS or DHCP row shape. It should likewise render
`scanning_enabled` directly instead of rebuilding scan-setting inheritance in
the client. `scan_enabled` remains available only to distinguish an explicit
per-IP override from an inherited value for editing actions.

The `system` allocation/type is limited to topology-defined non-host addresses:
IPv4 network and broadcast addresses and IPv6 subnet-router anycast. A
CIDRella, DNS, or DHCP service role does not make a host address `system`. An
enabled manual A or AAAA record allocates that address as `static_dns`.

The server canonicalizes every persisted address through
`server/src/utils/address.js`. IPv4-mapped IPv6 input resolves to the canonical
IPv4 identity. IPv6 link-local addresses require `interface_id`; global
addresses must leave it null. API consumers must not use textual address
spelling for identity or ordering.

## Lifecycle Diagnostics

`GET /api/metrics/ip-lifecycle` requires `analytics:read` and returns allocation
counts by state, current scope conflicts, online rogue hosts, retirement
activity, and the sanitized migration outcome. The localhost-only
`GET /api/health/deep` response includes the same data as its `ip_lifecycle`
check. Neither endpoint returns the migration report's address-level conflict
details.

## DHCP Rows

DHCP read rows add DHCP-specific fields:

| Field | Meaning |
| --- | --- |
| `dhcp_assignment_type` | DHCP ownership shape: `dynamic`, `reserved`, or null. |
| `lease_status` | DHCP lease availability/activity: `active`, `offline`, `available`, or `unavailable`. |
| `expires_at` | Raw DHCP Lease or DHCP Reservation expiration display value. |

Do not expose or consume bare `type` or `status` for DHCP table rows. Use
`dhcp_assignment_type` and `lease_status`.

`unavailable` means the address is not assigned by DHCP but is still not safe
for dynamic lease use, such as a rogue online host, static DNS assignment, IP
Reservation, or system-owned address inside a DHCP scope.

DHCPv6 is configured per network through `dhcp_scopes.v6_mode`: `slaac`
(Router Advertisement only), `stateless` (SLAAC plus stateless DHCPv6 for
options), or `stateful` (managed addresses from a pool). The SLAAC modes require
a /64. Only `stateful` scopes issue leases and accept reservations. IPv6
reservations and leases are keyed by `duid` (with optional `iaid`) instead of a
MAC; the MAC, when present, is learned metadata. Rogue detection covers three
kinds of finding under `/api/dhcp/rogue`: `dhcp` (a DHCPv4 server answered a
DISCOVER), `dhcpv6` (a DHCPv6 server answered a SOLICIT, identified by
`server_duid`), and `ra` (a router advertised itself, with
`advertised_prefixes`). The allowlist trusts a server by `server_ip` of either
family, `server_mac`, or `server_duid`.

### DHCP option defaults by family

DHCPv4 and DHCPv6 option codes are separate namespaces (v4 23 is the default
TTL, v6 23 is the DNS server list), so `dhcp_option_defaults`,
`dhcp_scope_options` and `dhcp_custom_options` are keyed by
`(address_family, code)` and every option endpoint takes a family, IPv4 when
omitted so pre-IPv6 callers are unchanged:

| Endpoint | Family |
| --- | --- |
| `GET /api/dhcp/options?family=4\|6` | Catalog, defaults, `enabledDefaults`, custom options and `customRange` for that family. |
| `PUT /api/dhcp/options/defaults` | Body `{ family, options, enabledDefaults }`; replaces only that family's rows. |
| `POST /api/dhcp/options/custom` | Body `address_family`; codes 128-254 for IPv4, 1-65535 for IPv6 minus the codes dnsmasq builds itself (1-7, 12-17, 39). |
| `DELETE /api/dhcp/options/custom/:code?family=` | Deletes the option, its default and its scope values within that family. |

Scope `options` on `POST`/`PUT /api/dhcp/scopes` are validated against the
network's family. The IPv6 catalog (`DHCP6_OPTIONS`) is written to dnsmasq as
`option6:<name>` lines with bracketed addresses; a custom IPv6 code is written
as `option6:<code>`. Startup seeds two IPv6 defaults, DNS servers (23) and the
search list (24), enabled without a value: a new IPv6 scope inherits the
enabled defaults and fills 23 with CIDRella's IPv6 address on the network and
24 with the network's domain, the IPv6 twin of what IPv4 does with 1, 3, 6, 15,
28 and 119. Routers, prefixes and lifetimes are never options in DHCPv6. The
`dhcp_scopes` columns `dns_servers`, `domain_search` and `ntp_servers` remain
a valid way to set 23, 24 and 56 on an IPv6 scope and sit between the global
defaults and the scope's own option rows. Lease time stays one shared setting,
`default_lease_time`.

### The IPv6 switch

`ipv6_enabled` (default `false` on new installs and upgrades) is persisted and
applied by `PUT /api/interfaces/config` and read back from
`GET /api/interfaces/config` and `GET /api/features` (`{ ipv6 }`, any signed-in
user). It is not editable through the generic settings route. While it is off
the appliance is an IPv4 product: dnsmasq and the resolver bind IPv4 only,
IPv6 DHCP scopes are left out of the generated config, the DHCPv6 and Router
Advertisement detectors are skipped and reported with `disabled: true`, the
scan scheduler skips IPv6 networks and a manual scan of one fails,
`GET /api/interfaces` withholds host IPv6 addresses, and every route that would
create an IPv6 object answers `400` with one message:

```
IPv6 support is disabled. Enable it under Settings > General > Interfaces.
```

That covers `POST /api/subnets` with an IPv6 CIDR, `POST /api/subnets/:id/configure`
on an IPv6 network, `ip6.arpa` zone create or rename, AAAA record create or
edit of type or value, `PUT /api/dns/forwarders` and `PUT /api/dns/encryption`
with an IPv6 address, DHCP scope create on an IPv6 network or a mode, pool or
gateway change on one, reservation create with a DUID or an identity or
address change on one, and a non-empty `blocklist_redirect_ip6`. Existing IPv6
rows stay readable, their non-IPv6 fields (name, description, enabled,
hostname) stay editable, and deletes work. `GET /api/subnets/:id/ips` on an
IPv6 network answers `sparse: true` with only the addresses that hold rows.

## Network Read Model

Network responses expose `gateway_policy` as `first`, `last`, `custom`, or
`none`, alongside the resolved `gateway_address`. Consumers preserve that
policy rather than infer future split or merge behavior from the literal
address. `topology_revision` changes whenever topology-owned configuration is
mutated and is the concurrency boundary for transformation plans.

Split, carve, and merge previews return resolved target networks, gateways,
scope and pool lineage, exact conflicts, and a dependency token. Execution
accepts that token and rejects it when a relevant network, DHCP, DNS, lease,
reservation, or allocation fact changed. Database completion and generated
configuration apply status are separate response facts.

Transformation preview requires `subnets:read`; execution requires
`subnets:write`. The latter is a compound topology permission and is currently
administrator-only. Conflict resolutions can name only exact record identities
returned by the current preview.

`GET /api/metrics/configuration-generation` returns durable desired-generation
records for DNS and DHCP. Each row reports `pending`, `applied`, or `failed`,
with attempt/error details. A committed network mutation can therefore be
successful while its generated configuration is still pending or failed; a
later retry or process restart resumes pending work.

DHCP scope `lease_time` is the sole lease-duration policy. Option 51 is not a
separate global or per-scope override. Scope pools are returned as explicit
intervals. Split and merge preserve scope presence rather than prior pool
bounds: when any source network has a scope, preview gives every supported
resulting network one standard-sized interval with `origin: "default"`.
Execution creates exactly that disclosed interval and inherits deterministic
source scope policy while rebasing network-derived options. Differing source
scope policies produce a `dhcp_scope_policy_conflict` rather than being chosen
by request order. With no source scope, transformations create no scope.

An unallocated network row with child networks is a hierarchy container, not
available address space. Clients must not list a fully subdivided container in
an unallocated-space browser; its allocated leaves are the operating networks.

Network rows carry `address_family` (`4` or `6`) and `last_address`.
`broadcast_address` is null for IPv6 and `total_addresses` is null when the
prefix holds more addresses than a JavaScript number represents exactly. The
per-network IP listing for an IPv6 network returns persisted rows only, sorted
by the canonical sort key, with no synthesized available rows; its summary
reports `assigned_count` and leaves `unassigned_count` null when
`total_addresses` is null. Split and calculate previews report child counts as
decimal strings when they exceed that limit. Divide and merge use the same
rules for both families with the prefix bound at the family's width.

## Cross-Table Facts

The Addresses, DNS and DHCP workspace tables are one table model: each can show
any column the others have. The reads attach what the other tables know about
an address, from `server/src/models/ip-row-facts.js`, as nested objects so a
table's own fields never collide with them:

| Field | On | Meaning |
| --- | --- | --- |
| `dns_record` | Addresses, DHCP rows | The forward A/AAAA record behind the address: the one the allocation names, else the lowest-id served record, else the lowest-id record. `record_fqdn`, `record_type`, `value`, `ttl`, `priority`, `port`, `enabled`, `dns_source`, `zone_soa_minimum_ttl`; null when none. |
| `dns_record_count` | Addresses, DHCP rows | How many forward address records name the address. |
| `dhcp` | Addresses, DNS rows | The DHCP Reservation, else the active lease, else the newest lease for the address: `dhcp_assignment_type`, `lease_status`, `enabled`, `duid`, `iaid`, `subnet_name`, `related_scope_ids`; null when none. |

## Column Filters

`GET /api/subnets/:id/ips`, `/api/workspace/dns-records` and
`/api/workspace/dhcp-addresses` take the same column parameters, applied to the
whole result before paging (`server/src/utils/ip-columns.js`):

| Parameter | Meaning |
| --- | --- |
| `filters` | JSON object `{ column: [value, ...] }`. A value is a string, a boolean, or null for "none". A value-list column matches any listed value; a text column takes one string and matches a case-insensitive substring. Unknown columns and other value types are refused with 400. |
| `facets=1` | Adds `facets` (`{ column: [{ value, count }] }` for every value-list column, each counted over rows matching the other filters, free addresses included) and `filter_kinds` (`{ column: 'enum' \| 'text' }`). |
| `sort_column` | Sort by any column key, empty values last. |

The older single-purpose filters (`display_status`, `address_type`, `online`,
`record_type`, `dns_source`, `lease_status`, `dhcp_assignment_type`, and so on)
still work.

## IP Allocation Writes

An IP Reservation is an administrative address hold without a DHCP client
binding. Create or release one IP Reservation with
`PUT /api/subnets/:id/ips/:ip/allocation`:

```json
{ "allocation_state": "reserved", "note": "printer" }
```

Release it by sending `{"allocation_state":"unassigned"}`. For a contiguous
IP Reservation range, use `PUT /api/subnets/:id/ips/bulk-allocation` with
`start_ip`, `end_ip`, `allocation_state`, and an optional `note`. These
endpoints accept only the internal values `reserved` and `unassigned`; DNS,
DHCP, SLAAC, and topology allocations must be changed through their owning
APIs. An address held by a disabled DNS record (`reserved` owned by `dns`,
shown as `disabled DNS`) is refused here with 409: enable or delete the record
instead (ADR 004). A DHCP Reservation is a static DHCP client-to-address binding and is
managed through `/api/dhcp/reservations`.

## DNS Rows

DNS read rows add DNS-specific fields:

| Field | Meaning |
| --- | --- |
| `record_type` | DNS RR type: `A`, `AAAA`, `CNAME`, `PTR`, `MX`, `TXT`, `SRV`. |
| `dns_source` | DNS row provenance: `manual`, `dns`, `dhcp`, `reservation`, or `placeholder`. The internal `reservation` value identifies a generated DHCP Reservation PTR. Generated PTR rows use the latter four values; an operator-created PTR remains `manual`. |
| `record_fqdn` | Fully qualified owner name derived from the record name and its zone. This is a DNS record fact and is distinct from the canonical IP `hostname`. |

DNS write APIs still accept `type` because the submitted form is a DNS record
write model. UI read paths should use `record_type` and `dns_source`; form
submission should map `record_type` back to `type` only when editing a record.

## Storage Fields

The database may continue to use table-local names when they are meaningful in
that table:

| Storage field | Scope |
| --- | --- |
| `ip_addresses.allocation_state` | Canonical mutually exclusive allocation state. |
| `subnets.status` | Network allocation state. |
| `subnets.address_family` | Network address family, `4` or `6`. |
| `dhcp_scopes.v6_mode` | DHCPv6 mode for an IPv6 scope, null for IPv4. |
| `dhcp_reservations.duid`, `dhcp_leases.duid` | DHCPv6 client identity. |
| `dns_records.type` | DNS RR type. |
| `dns_records.source` | DNS record provenance. |
| `network_scans.status` | Scan execution state. |
| DHCP option `type` | DHCP option value type. |

These names should not be projected directly into mixed IP table views when a
canonical API read field exists.
