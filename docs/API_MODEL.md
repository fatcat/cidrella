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
| `ip_lifecycle_status` | Internal IP lifecycle/control state from `ip_addresses`. | `available`, `assigned`, `dhcp`, `locked` |
| `ip_display_status` | User-facing availability for tables. | `available`, `in use` |
| `ip_status_severity` | UI severity for `ip_display_status`. | `secondary`, `danger` |
| `address_type` | User-facing reason the IP is in use. Empty/null when available. | `static DNS`, `dynamic DHCP`, `reserved DHCP`, `rogue`, `system`, `gateway`, `locked` |
| `address_type_tooltip` | Optional explanation for `address_type`. | rogue reason, lock note |
| `computed_type` | Sort/search alias for `address_type`, or `available`. | same as `address_type`, plus `available` |
| `is_online` | Current liveness state. | `0`/`1`, boolean in some API rows |
| `last_seen_at` | Last observation time from scans, DHCP, or passive checks. | datetime/null |
| `last_scanned_at` | Last active probe time. | datetime/null |
| `has_static_dns` | Whether an enabled manual DNS A record backs the IP. | `0`/`1` |
| `has_dhcp_reservation` | Whether a DHCP reservation backs the IP. | `0`/`1` |
| `dhcp_expires_at` | Active dynamic lease expiration. | datetime, `infinite`, null |

UI table rendering should use `ip_display_status` for the displayed Status and
`address_type`/`computed_type` for the displayed Type. It should not infer
display Type from storage fields such as `ip_addresses.status`,
`dns_records.source`, or DHCP lease row shape.

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
| `record_type` | DNS RR type: `A`, `CNAME`, `PTR`, `MX`, `TXT`, `SRV`. |
| `dns_source` | DNS row provenance: `manual`, `dhcp`, `reservation`. |

DNS write APIs still accept `type` because the submitted form is a DNS record
write model. UI read paths should use `record_type` and `dns_source`; form
submission should map `record_type` back to `type` only when editing a record.

## Storage Fields

The database may continue to use table-local names when they are meaningful in
that table:

| Storage field | Scope |
| --- | --- |
| `ip_addresses.status` | IP lifecycle/control state, including lock state. |
| `subnets.status` | Network allocation state. |
| `dns_records.type` | DNS RR type. |
| `dns_records.source` | DNS record provenance. |
| `network_scans.status` | Scan execution state. |
| DHCP option `type` | DHCP option value type. |

These names should not be projected directly into mixed IP table views when a
canonical API read field exists.
