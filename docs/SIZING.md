# Host Sizing & DHCP Scope Limits

CIDRella is designed for modest hosts — a 1 GB or 2 GB LXC is the target footprint. RAM, not CPU, is the binding constraint, and the dominant memory consumer is not dnsmasq — it's CIDRella's own per-IP tracking tables in SQLite.

## RAM budget

| Host RAM | OS + filesystem cache | CIDRella budget |
|---|---|---|
| 1 GB  | ~512 MB | ~512 MB |
| 2 GB  | ~512 MB | ~1.5 GB |

Of the CIDRella budget, the Node process itself holds ~150 MB baseline (Vue dev/build chunk, express, better-sqlite3, lru-cache, MaxMind GeoLite2 DB, etc.). Everything else is workload-driven: SQLite row cache, DuckDB analytics ring buffer, DNS-proxy in-flight map, and — if any — large allocated subnets.

## Where per-IP memory comes from

- `ip_addresses` table — **one row per IP in any allocated subnet**. Row size with indexes is ~160 bytes in SQLite. This is the dominant cost as subnets grow.
- `ip_lifecycle_events` — retention-limited (default 7 days), ~100 bytes/row.
- `host_liveness_history` — scan results, retention-limited.
- dnsmasq lease table — ~200–400 bytes per *active* lease. Does NOT scale with scope size, only with concurrent clients.

## Practical scope size ceilings

Assuming a single large allocated scope is the dominant workload:

| Subnet | Rows in `ip_addresses` | Disk + index | Peak RAM (total) |
|---:|---:|---:|---:|
| /24 | 256 | ~80 KB | negligible |
| /16 | 65,536 | ~20 MB | ~170 MB total |
| /12 | 1,048,576 | ~330 MB | ~500 MB total |
| /10 | 4,194,304 | ~1.3 GB | overshoots 1 GB hosts |
| /8 | 16,777,216 | ~5 GB | fails on both 1 GB and 2 GB hosts |

**Rule of thumb:**
- 1 GB host: stay at /12 or smaller for any allocated subnet.
- 2 GB host: /10 is plausible but leaves little headroom for the rest of the app.
- Either: multiple /24s scale linearly (cheap). It's individual huge subnets that hurt.

## DHCP scope auto-fill behavior

The "Create DHCP scope" toggle on the Edit Network and First-time Setup dialogs auto-fills Start IP / End IP for subnets **between /16 and /29 inclusive**. Outside that range:

- **Smaller than /29** (i.e., /30, /31, /32): only 1–2 usable IPs, DHCP is meaningless. No defaults, no warning — just blank fields.
- **Larger than /16** (i.e., /15, /14, …, /0): the defaults would be computationally valid but the SIZE of the scope would cause `ip_addresses` to overflow modest-host RAM. The UI surfaces a warning reminding the user this is a bad idea on a small host, and the fields are left blank for manual entry.

dnsmasq itself happily accepts any DHCP range (it doesn't pre-allocate); the constraint is CIDRella's bookkeeping. If you're on a beefy host and genuinely need a DHCP scope larger than /16, type the Start/End IP manually and accept the RAM cost.

## Where the numbers come from

SQLite row size is approximate — actual bytes depend on column content (hostname strings, MAC presence, vendor lookups). DuckDB analytics is a ring buffer capped by the scheduler; it does not grow with subnet size. The 150 MB Node baseline is measured from `process.memoryUsage().rss` right after boot with a freshly-initialized DB on Node 24 + Debian 13.

Verify your own instance with:
```bash
journalctl -u cidrella -g 'memoryUsage' --since '1 hour ago'
# or
ps -o pid,rss,cmd -p "$(pgrep -f 'server/src/index.js')"
```
