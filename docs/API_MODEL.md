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
| `allocation_source_id` | Protocol or topology row that backs the allocation, when applicable. | integer/string identifier, null |
| `address_family` | Canonical address family. | `4`, `6` |
| `address_sort_key` | Fixed-width indexed key for numeric mixed-family ordering. | 33-character family-prefixed hexadecimal key |
| `interface_id` | Interface context required for scoped addresses such as IPv6 link-local. | identifier, null |
| `ip_lifecycle_status` | Temporary compatibility projection of legacy storage state. | `available`, `assigned`, `dhcp`, `locked` |
| `ip_display_status` | User-facing availability derived by the server. | `available`, `DHCP Scope`, `in use` |
| `ip_status_severity` | UI severity for `ip_display_status`. | `secondary`, `danger` |
| `address_type` | User-facing reason the IP is in use. Empty/null when available. | `static DNS`, `dynamic DHCP`, `reserved DHCP`, `SLAAC`, `rogue`, `system`, `gateway`, `reserved` |
| `address_type_tooltip` | Optional explanation for `address_type`. | rogue reason, lock note |
| `computed_type` | Sort/search alias for `address_type`, or `available`. | same as `address_type`, plus `available` |
| `is_online` | Current liveness state. | `0`/`1`, boolean in some API rows |
| `last_seen_at` | Last observation time from scans, DHCP, or passive checks. | datetime/null |
| `last_scanned_at` | Last active probe time. | datetime/null |
| `in_dynamic_pool` | Whether the address belongs to an enabled same-family DHCP pool. | `0`/`1` |
| `has_static_dns` | Temporary compatibility fact for an enabled manual DNS A or AAAA record. | `0`/`1` |
| `has_dhcp_reservation` | Whether a DHCP reservation backs the IP. | `0`/`1` |
| `dhcp_expires_at` | Active dynamic lease expiration. | datetime, `infinite`, null |

UI table rendering should use `ip_display_status` for the displayed Status and
`address_type`/`computed_type` for the displayed Type. It should not infer
display Type from storage fields such as `ip_addresses.status`,
`dns_records.source`, or DHCP lease row shape.

The server canonicalizes every persisted address through
`server/src/utils/address.js`. IPv4-mapped IPv6 input resolves to the canonical
IPv4 identity. IPv6 link-local addresses require `interface_id`. API consumers
must not use textual address spelling for identity or ordering.

## DHCP Rows

DHCP read rows add DHCP-specific fields:

| Field | Meaning |
| --- | --- |
| `dhcp_assignment_type` | DHCP ownership shape: `dynamic`, `reserved`, or null. |
| `lease_status` | DHCP lease availability/activity: `active`, `offline`, `available`, or `unavailable`. |
| `expires_at` | Raw DHCP lease/reservation expiration display value. |

Do not expose or consume bare `type` or `status` for DHCP table rows. Use
`dhcp_assignment_type` and `lease_status`.

`unavailable` means the address is not assigned by DHCP but is still not safe
for dynamic lease use, such as a rogue online host, static DNS assignment, or
locked/system-owned address inside a DHCP scope.

## DNS Rows

DNS read rows add DNS-specific fields:

| Field | Meaning |
| --- | --- |
| `record_type` | DNS RR type: `A`, `AAAA`, `CNAME`, `PTR`, `MX`, `TXT`, `SRV`. |
| `dns_source` | DNS row provenance: `manual`, `dhcp`, `reservation`. |

DNS write APIs still accept `type` because the submitted form is a DNS record
write model. UI read paths should use `record_type` and `dns_source`; form
submission should map `record_type` back to `type` only when editing a record.

## Storage Fields

The database may continue to use table-local names when they are meaningful in
that table:

| Storage field | Scope |
| --- | --- |
| `ip_addresses.allocation_state` | Canonical mutually exclusive allocation state. |
| `ip_addresses.status` | Temporary legacy compatibility state during migration. |
| `subnets.status` | Network allocation state. |
| `dns_records.type` | DNS RR type. |
| `dns_records.source` | DNS record provenance. |
| `network_scans.status` | Scan execution state. |
| DHCP option `type` | DHCP option value type. |

These names should not be projected directly into mixed IP table views when a
canonical API read field exists.
